// Agent-driven execution: every write op is one run of an agent CLI (claude / codex) that is told to
// use ONLY Binance's official MCP server (https://agent.binance.com/mcp/agentic, OAuth 2.1 PKCE) and to
// perform exactly one operation. The gateway holds no Binance key and no OAuth token — the CLI owns the
// session (AGENTS.md rule 1 still holds). Tool names/schemas are deliberately NOT hard-coded: the agent
// discovers them from the server, so this backend keeps working when Binance renames or adds tools.
//
// COST: every uncached call = one CLI run (one model session). Read ops are therefore split:
//   * markPrice / symbolRules / symbols  → public REST (market.ts), free, no CLI run;
//   * account()  → one CLI run, cached TG_EXEC_AGENT_ACCOUNT_TTL_MS (default 300 s), invalidated after
//                  every write op;
//   * getOrder() → one CLI run, cached 30 s per client_order_id.
//
// Setup (once, by the human):
//   claude: `cd ~ && claude "/mcp"` → binance-mcp-server → Authenticate. POST /api/execution/connect pops
//           that exact command in a Terminal window (openTerminalWith); the CLI stores the OAuth token
//           under the server name and we pass the SAME name+url via --mcp-config so the token is reused.
//           The gateway never reads that token — Binance whitelists agent client_ids and rejects ours
//           ("not currently supported", 3346001), so Claude Code's session IS the connection.
//   codex:  `codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic` works, but
//           `codex mcp login` is dead upstream today ("Dynamic client registration not supported":
//           Binance only publishes a CIMD client-id document). See CODEX_MCP_BLOCKED_DETAIL.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountView, Backend, Direction, NetCheckResult, OpenOrderView, PositionView, SymbolInfo, TransportHealth } from './types.js';
import type { SymbolRules } from './gates.js';
import type { AlgoLegReceipt, EntryRequest, ExecBackend, OpenWithProtectionRequest, OpenWithProtectionReceipt, OrderOutcome, OrderReceipt, OrderStatusView, PaperEvent, ProtectionCapability } from './execution.js';
import { cliSpawnArgs, defaultCliCommand, stripShellNoise } from './cli-launch.js';
import { fetchExchangeInfo, fetchPremiumIndex } from './market.js';

export type AgentCli = 'claude' | 'codex';

export const DEFAULT_MCP_NAME = process.env['TG_BINANCE_MCP_NAME'] ?? 'binance-mcp-server';
export const DEFAULT_MCP_URL = process.env['TG_BINANCE_MCP_URL'] ?? 'https://agent.binance.com/mcp/agentic';

/** Tools the executor must never touch: it may only call the binance MCP server. */
const DISALLOWED_CLAUDE_TOOLS = 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent,NotebookEdit,TodoWrite,KillShell,BashOutput';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Set when the process could not be started at all (ENOENT…): nothing reached the exchange. */
  spawnError: string | null;
}

/** Injectable so tests can point at a fake CLI script instead of the real `claude` / `codex`. */
export type AgentSpawn = (cmd: string, args: string[], stdin: string, opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<SpawnResult>;

export const defaultAgentSpawn: AgentSpawn = (cmd, args, stdin, opts) =>
  new Promise<SpawnResult>((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...opts.env } });
    } catch (e) {
      return resolve({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: (e as Error).message });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut, spawnError: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, spawnError: null });
    });
    try {
      child.stdin.end(stdin);
    } catch {
      /* the child may already be gone; `close` still fires */
    }
  });

export function commandOnPath(cmd: string): boolean {
  try {
    const r = spawnSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && String(r.stdout).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The last complete TOP-LEVEL `{...}` in a blob of text (agents like to narrate before the JSON, and
 * `claude --output-format json` wraps everything in an envelope). Nested objects never win over the
 * object that contains them. Returns null when nothing in the text parses as a JSON object.
 */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  const asObject = (from: number, to: number): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(text.slice(from, to)) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  // Pass 1: brace-match from the outside in, keeping the LAST top-level span that parses.
  let depth = 0;
  let openedAt = -1;
  let inStr = false;
  let esc = false;
  let best: Record<string, unknown> | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) openedAt = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth <= 0) {
        if (openedAt >= 0) best = asObject(openedAt, i + 1) ?? best;
        depth = 0;
        openedAt = -1;
      }
    }
  }
  if (best) return best;
  // Pass 2 (prose with unbalanced braces): brute-force the last few `{`/`}` pairs only — bounded so a
  // huge unparsable transcript can never turn this into an O(n²) walk.
  const LIMIT = 40;
  const starts: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') starts.push(i);
    else if (text[i] === '}') closes.push(i);
  }
  for (const close of closes.slice(-LIMIT).reverse()) {
    for (const open of starts.slice(-LIMIT)) {
      if (open >= close) break;
      const v = asObject(open, close + 1);
      if (v) return v;
    }
  }
  return null;
}

export interface AgentMcpOptions {
  cli: AgentCli;
  /** null → 'sonnet' for claude, the Codex CLI's own default for codex. */
  model: string | null;
  /**
   * How this machine launches that CLI (Workflow.cli_commands): a bare name, a path, an env-prefixed
   * line, or an interactive-shell alias. Omitted → the boot default (TG_DEMO_CLI_* or the bare name).
   */
  command?: string | null;
  server_name?: string;
  url?: string;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  spawnFn?: AgentSpawn;
  /** Per-op wall clock, default TG_EXEC_AGENT_TIMEOUT_MS or 120 s. Kill on timeout → outcome 'unknown'. */
  timeoutMs?: number;
  /** account() cache, default TG_EXEC_AGENT_ACCOUNT_TTL_MS or 300 s. */
  accountTtlMs?: number;
  /**
   * 空闲时(本通道没有开放线程、没有待批/进行中的意图)用的更长缓存,默认 TG_EXEC_AGENT_ACCOUNT_IDLE_TTL_MS 或 15 分钟。
   * 每次读账户 = 一趟带 MCP 工具表的 Claude CLI(几万 token),没仓位时没必要每 5 分钟问一次余额;写操作后仍立刻失效。
   */
  idleTtlMs?: number;
  idle?: () => boolean;
  maxTurns?: number;
  /** Working directory for the CLI runs; default a fresh temp dir (never the repo, so no CLAUDE.md loads). */
  scratchDir?: string;
}

const ORDER_SHAPE = '{"ok":boolean,"outcome":"filled"|"submitted"|"failed"|"unknown","order_id"?:string,"avg_price"?:string,"executed_qty"?:string,"raw"?:unknown,"error"?:string}';
const OPEN_PROTECTION_SHAPE = '{"entry":{"outcome":"filled"|"submitted"|"failed"|"unknown","avg_price":string|null,"executed_qty":string|null,"order_id":string|null,"error":string|null},"stop":{"outcome":"submitted"|"filled"|"failed"|"unknown"|"skipped","algo_id":string|null,"error":string|null},"tp":{"outcome":"submitted"|"filled"|"failed"|"unknown"|"skipped","algo_id":string|null,"error":string|null}}';
const ACCOUNT_SHAPE =
  '{"ok":boolean,"error"?:string,"account":{"equity":string,"available":string,"unrealized_pnl":string,"positions":[{"symbol":string,"side":"long"|"short","qty":string,"entry_price":string,"mark_price":string,"unrealized_pnl":string,"leverage":number}],"open_orders":[{"symbol":string,"client_order_id":string,"type":string,"side":string,"qty":string,"price":string|null,"stop_price":string|null,"reduce_only":boolean,"status":string}]}}';
const ORDER_STATUS_SHAPE = '{"ok":boolean,"error"?:string,"order":{"status":string,"avg_price":string|null,"executed_qty":string,"raw":unknown}|null}';

/** A lost transport response is not evidence of an exchange rejection. */
export function isTransportError(error: string | null): boolean {
  return /socket.*clos|before a response|result not confirmed|timed?\s*out|ECONNRESET|EPIPE|fetch failed|network/i.test(error ?? '');
}

const ORDER_TTL_MS = 30_000;

export class AgentMcpBackend implements ExecBackend {
  readonly kind: Backend = 'agent_mcp';
  /**
   * 2026-09-06 事故:币安 MCP 的 futures_usds_newOrder schema 没有 stopPrice/closePosition/workingType,
   * 子代理挂不上 STOP_MARKET → 入场后被迫补偿平仓。保护腿改走 tool_execute 透传(见 protective()),
   * 但在 the maintainer 用真实账户跑过探针之前当作 unverified:runtime 提交前重闸会拒掉所有新增开仓。
   * 验证通过后设 TG_AGENT_MCP_PROTECTION=verified。
   */
  protectionCapability(): ProtectionCapability {
    return process.env['TG_AGENT_MCP_PROTECTION'] === 'verified' ? 'verified' : 'unverified';
  }
  private readonly spawnFn: AgentSpawn;
  private readonly timeoutMs: number;
  private readonly accountTtlMs: number;
  private readonly idleTtlMs: number;
  private readonly maxTurns: number;
  readonly serverName: string;
  readonly url: string;
  private scratch: string;
  private ownScratch: boolean;
  private mcpConfigPath: string | null = null;
  private accountCache: { at: number; view: AccountView } | null = null;
  private accountInFlight: Promise<AccountView> | null = null;
  private orderCache = new Map<string, { at: number; view: OrderStatusView | null }>();
  private rulesCache = new Map<string, SymbolRules>();
  private symbolsCache: SymbolInfo[] | null = null;
  private symbolsFetchedAt = 0;
  private runs = 0;
  /** 09-07:传输健康账本(30 分钟窗口)。任何「回执丢了」都记一笔:超时、连接被掐、无响应。 */
  private static readonly TRANSPORT_WINDOW_MS = 30 * 60_000;
  private runLog: number[] = [];
  private transportLog: { at: number; error: string }[] = [];
  private noteTransport(error: string | null): void {
    if (!error) return;
    this.transportLog.push({ at: Date.now(), error: error.slice(0, 300) });
    if (this.transportLog.length > 200) this.transportLog.splice(0, this.transportLog.length - 200);
  }
  /**
   * 网络自检:连续 n 次只读账户调用(每次一个新子进程、一条新连接,和真下单同一条路),统计掉线率。
   * 只读、不花钱以外的钱(每次一个 sonnet 会话),n 钳在 1–10。
   */
  async netCheck(nIn: number): Promise<NetCheckResult> {
    const n = Math.max(1, Math.min(10, Math.round(nIn) || 5));
    const started_at = Date.now();
    const runs: NetCheckResult['runs'] = [];
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      try {
        await this.accountInner();
        runs.push({ ms: Date.now() - t0, ok: true, transport_error: false, error: null });
      } catch (e) {
        const msg = (e as Error).message;
        runs.push({ ms: Date.now() - t0, ok: false, transport_error: isTransportError(msg), error: msg.slice(0, 300) });
      }
    }
    const ok = runs.filter((r) => r.ok).length;
    const transport_errors = runs.filter((r) => r.transport_error).length;
    const other_errors = runs.length - ok - transport_errors;
    const okMs = runs.filter((r) => r.ok).map((r) => r.ms);
    const avg_ms = okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null;
    const rate = Math.round((transport_errors / runs.length) * 100);
    const verdict =
      transport_errors === 0 && other_errors === 0
        ? `${n} 次全通,平均 ${avg_ms ?? '—'} ms:这条路现在是稳的`
        : transport_errors > 0
          ? `${n} 次里 ${transport_errors} 次连接被掐/超时(掉线率 ${rate}%):是本机到交易所接口的网络/代理问题。代理(Clash 等)给 agent.binance.com 换稳定节点或加直连规则;下单时回执丢了网关会自动查/重发,不会误平仓`
          : `${n} 次里 ${other_errors} 次非网络错误(登录过期、权限、返回格式):看最近一次错误文本,不是掉线`;
    return { backend: this.kind, started_at, finished_at: Date.now(), runs, ok, transport_errors, other_errors, avg_ms, verdict };
  }

  transportHealth(): TransportHealth {
    const cutoff = Date.now() - AgentMcpBackend.TRANSPORT_WINDOW_MS;
    this.runLog = this.runLog.filter((t) => t >= cutoff);
    this.transportLog = this.transportLog.filter((e) => e.at >= cutoff);
    const last = this.transportLog[this.transportLog.length - 1] ?? null;
    return { window_ms: AgentMcpBackend.TRANSPORT_WINDOW_MS, runs: this.runLog.length, transport_errors: this.transportLog.length, last_error: last?.error ?? null, last_at: last?.at ?? null };
  }

  constructor(private readonly opts: AgentMcpOptions) {
    this.spawnFn = opts.spawnFn ?? defaultAgentSpawn;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env['TG_EXEC_AGENT_TIMEOUT_MS'] ?? '120000');
    this.accountTtlMs = opts.accountTtlMs ?? Number(process.env['TG_EXEC_AGENT_ACCOUNT_TTL_MS'] ?? '300000');
    this.idleTtlMs = opts.idleTtlMs ?? Number(process.env['TG_EXEC_AGENT_ACCOUNT_IDLE_TTL_MS'] ?? 15 * 60_000);
    this.maxTurns = opts.maxTurns ?? Number(process.env['TG_EXEC_AGENT_MAX_TURNS'] ?? '6');
    this.serverName = opts.server_name ?? DEFAULT_MCP_NAME;
    this.url = opts.url ?? DEFAULT_MCP_URL;
    this.ownScratch = !opts.scratchDir;
    this.scratch = opts.scratchDir ?? '';
  }

  get cli(): AgentCli {
    return this.opts.cli;
  }
  get model(): string | null {
    return this.opts.model;
  }
  /** How many CLI runs this backend has spawned since start (for the logs / cost awareness). */
  get runCount(): number {
    return this.runs;
  }

  async start(): Promise<void> {
    if (!this.scratch) this.scratch = mkdtempSync(path.join(os.tmpdir(), 'tswarm-mcp-'));
    if (this.opts.cli === 'claude') {
      this.mcpConfigPath = path.join(this.scratch, 'mcp.json');
      // Same server name + url as the one the human logged in with, so the CLI reuses its stored OAuth token.
      writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers: { [this.serverName]: { type: 'http', url: this.url } } }, null, 2));
    }
    this.opts.log('info', `执行后端 agent_mcp 就绪:${this.command}${this.opts.model ? `(${this.opts.model})` : ''} → MCP ${this.serverName} ${this.url};每次写操作 = 一次 CLI 运行(超时 ${this.timeoutMs} ms),账户缓存 ${this.accountTtlMs} ms`);
  }

  async stop(): Promise<void> {
    if (this.ownScratch && this.scratch) {
      try {
        rmSync(this.scratch, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      this.scratch = '';
    }
    this.accountCache = null;
    this.orderCache.clear();
  }

  // ------------------------------------------------------------ the one CLI run

  private prompt(task: Record<string, unknown>, shape: string): string {
    return [
      'You are a trade execution agent. Execute EXACTLY ONE operation and report it back as JSON.',
      '',
      'TASK (JSON):',
      JSON.stringify(task, null, 2),
      '',
      'RULES:',
      `1. Use ONLY the binance MCP tools (server "${this.serverName}"). Discover the tool list first if you need to; never use any other tool.`,
      '2. Perform exactly this one operation. open_with_protection is ONE operation with the specified entry → stop → optional TP sequence in this SAME run. Never place anything else, never modify other orders or positions. Use tool_execute with the exact toolName and arguments supplied by code. Never change economic fields, positionSide, type, quantity, trigger price or client IDs; never retry a write, change transport or substitute an order. A rejected leg reports the exact exchange code and message. A sent request with no confirmed result is unknown.',
      '3. Never withdraw, never transfer, never move funds between wallets.',
      '4. The market is USDⓈ-M futures (USDT perpetual). Use the symbol verbatim.',
      '5. If a needed tool or parameter is unavailable, do NOTHING and report ok=false with outcome "failed" and the reason in "error".',
      '6. If you sent a request but cannot confirm the result, report outcome "unknown" — never "failed".',
      `7. Reply with ONLY a JSON object of this shape (no prose, no markdown fence):\n${shape}`,
    ].join('\n');
  }

  /** The configured launch command for this CLI. */
  get command(): string {
    return this.opts.command?.trim() || defaultCliCommand(this.opts.cli);
  }

  private argv(): { cmd: string; args: string[]; outFile: string | null; env: NodeJS.ProcessEnv } {
    if (this.opts.cli === 'codex') {
      const outFile = path.join(this.scratch, `codex-${Date.now().toString(36)}-${this.runs}.txt`);
      const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', this.scratch, '-o', outFile, '--color', 'never'];
      if (this.opts.model) args.push('-m', this.opts.model);
      const launch = cliSpawnArgs(this.command, args);
      return { cmd: launch.file, args: launch.args, outFile, env: launch.env };
    }
    const args = [
      '-p',
      '--model',
      this.opts.model ?? 'sonnet',
      '--output-format',
      'json',
      '--max-turns',
      String(this.maxTurns),
      '--allowedTools',
      `mcp__${this.serverName}__*`,
      '--disallowedTools',
      DISALLOWED_CLAUDE_TOOLS,
      '--strict-mcp-config',
    ];
    if (this.mcpConfigPath) args.push('--mcp-config', this.mcpConfigPath);
    const launch = cliSpawnArgs(this.command, args);
    return { cmd: launch.file, args: launch.args, outFile: null, env: launch.env };
  }

  /**
   * One CLI run. Returns the parsed reply object plus enough context to classify a failure:
   * `ambiguous` = the run may have reached the exchange (timeout / crash after start) → callers map to 'unknown'.
   */
  private async run(task: Record<string, unknown>, shape: string): Promise<{ obj: Record<string, unknown> | null; raw: string; ambiguous: boolean; error: string | null }> {
    if (!this.scratch) await this.start();
    const { cmd, args, outFile, env } = this.argv();
    const started = Date.now();
    this.runs++;
    const r = await this.spawnFn(cmd, args, this.prompt(task, shape), { cwd: this.scratch, timeoutMs: this.timeoutMs, env: { ...env, CLAUDECODE: '' } });
    const ms = Date.now() - started;
    let text = stripShellNoise(r.stdout).trim();
    if (outFile) {
      try {
        text = readFileSync(outFile, 'utf8').trim() || text;
      } catch {
        /* codex wrote nothing: fall back to stdout */
      }
    } else {
      // claude --output-format json wraps the answer in an envelope: {..., "result": "<text>"}
      const env = lastJsonObject(text);
      if (env && typeof env['result'] === 'string') text = (env['result'] as string).trim();
    }
    const log = (outcome: string): void => this.opts.log(r.spawnError || r.timedOut ? 'warn' : 'info', `agent_mcp ${String(task['op'])} via ${cmd}: ${outcome} (${ms} ms, run #${this.runs})`, { argv: [cmd, ...args], code: r.code, timed_out: r.timedOut });
    if (r.spawnError) {
      log(`spawn failed: ${r.spawnError}`);
      // Never started → nothing reached the exchange.
      return { obj: null, raw: '', ambiguous: false, error: `spawn ${cmd} failed: ${r.spawnError}` };
    }
    this.runLog.push(Date.now());
    if (r.timedOut) {
      log(`timeout after ${this.timeoutMs} ms`);
      this.noteTransport(`${cmd} timed out after ${this.timeoutMs} ms`);
      return { obj: null, raw: text, ambiguous: true, error: `${cmd} timed out after ${this.timeoutMs} ms` };
    }
    const obj = lastJsonObject(text);
    if (!obj) {
      log(`unparsable output (${text.length} chars)`);
      const tail = (text || r.stderr).slice(-400);
      if (isTransportError(tail)) this.noteTransport(tail);
      return { obj: null, raw: text, ambiguous: true, error: `${cmd} 输出里没有 JSON 对象(exit ${r.code}): ${tail}` };
    }
    log(String(obj['outcome'] ?? (obj['ok'] === true ? 'ok' : 'not-ok')));
    return { obj, raw: text, ambiguous: true, error: null };
  }

  // ------------------------------------------------------------ write ops

  private task(op: string, extra: Record<string, unknown>): Record<string, unknown> {
    return { op, market: 'USDⓈ-M futures', ...extra };
  }

  /** Maps one agent reply onto OrderReceipt semantics; anything ambiguous becomes 'unknown', never a silent 'failed'. */
  private toReceipt(r: { obj: Record<string, unknown> | null; raw: string; ambiguous: boolean; error: string | null }): OrderReceipt {
    this.invalidateAccount();
    if (!r.obj) return { outcome: r.ambiguous ? 'unknown' : 'failed', receipt: r.raw ? { raw_text: r.raw.slice(0, 2000) } : null, avg_price: null, error: r.error };
    const o = r.obj;
    const declared = String(o['outcome'] ?? '');
    let outcome: OrderOutcome = declared === 'filled' || declared === 'submitted' || declared === 'failed' || declared === 'unknown' ? (declared as OrderOutcome) : o['ok'] === true ? 'submitted' : 'unknown';
    const avg = o['avg_price'] === undefined || o['avg_price'] === null ? null : String(o['avg_price']);
    const err = o['error'] === undefined || o['error'] === null ? null : String(o['error']);
    if (isTransportError(err)) {
      outcome = 'unknown';
      this.noteTransport(err);
    }
    return { outcome, receipt: o, avg_price: avg && Number(avg) > 0 ? avg : null, error: outcome === 'filled' || outcome === 'submitted' ? null : (err ?? `agent reported ${outcome}`) };
  }

  async placeEntry(req: EntryRequest): Promise<OrderReceipt> {
    return this.toReceipt(
      await this.run(
        this.task('place_entry', {
          symbol: req.symbol,
          side: req.direction === 'long' ? 'BUY' : 'SELL',
          position_side_if_hedge: req.direction.toUpperCase(),
          order_type: req.entry === 'market' ? 'MARKET' : 'LIMIT',
          quantity: req.qty,
          price: req.entry === 'limit' ? req.limit_price : null,
          time_in_force: req.entry === 'limit' ? 'GTC' : null,
          reduce_only: false,
          close_position: false,
          client_order_id: req.client_order_id,
        }),
        ORDER_SHAPE,
      ),
    );
  }

  private algoTransport(symbol: string, position: Direction, type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', trigger: string, id: string) {
    return { toolName: 'futures_usds.newAlgoOrder', arguments: {
      algoType: 'CONDITIONAL', symbol, side: position === 'long' ? 'SELL' : 'BUY',
      positionSide: position.toUpperCase(), type, triggerPrice: trigger,
      closePosition: 'true', workingType: 'MARK_PRICE', clientAlgoId: id,
    } };
  }

  async openWithProtection(req: OpenWithProtectionRequest): Promise<OpenWithProtectionReceipt> {
    const r = await this.run(this.task('open_with_protection', {
      entry: { toolName: 'futures_usds.newOrder', arguments: {
        symbol: req.symbol, side: req.direction === 'long' ? 'BUY' : 'SELL',
        positionSide: req.direction.toUpperCase(), type: 'MARKET', quantity: req.qty,
        newClientOrderId: req.client_order_id, newOrderRespType: 'RESULT',
      } },
      stop: this.algoTransport(req.symbol, req.direction, 'STOP_MARKET', req.stop_price, req.stop_client_algo_id),
      tp: req.take_profit ? this.algoTransport(req.symbol, req.direction, 'TAKE_PROFIT_MARKET', req.take_profit.trigger_price, req.take_profit.client_algo_id) : null,
      sequence: 'Send entry once via tool_execute. If and ONLY if its RESULT status is FILLED, IMMEDIATELY send stop via tool_execute, without any account/order polling or other call between entry and stop. closePosition on a flat side is rejected (-4509), so never send stop before the fill. If stop is accepted (NEW with algoId), report submitted, then send optional TP. If entry is not FILLED, skip both legs. If stop fails/is unknown, skip TP and return all known entry/stop evidence immediately; do not close or retry. Preserve each exact exchange error. Missing/uncertain results are unknown; skipped means definitely not sent. FILLED on an algo means already triggered, not active protection.',
    }), OPEN_PROTECTION_SHAPE);
    const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    const entryObj = obj(r.obj?.['entry']);
    const entry = this.toReceipt({ ...r, obj: entryObj, error: r.error ?? 'missing entry receipt' });
    const leg = (value: unknown, requested: boolean): AlgoLegReceipt => {
      if (!requested) return { outcome: 'skipped', algo_id: null, error: null };
      const o = obj(value);
      const outcome = o?.['outcome'];
      const algo_id = o?.['algo_id'] == null ? null : String(o['algo_id']);
      const error = o?.['error'] == null ? null : typeof o['error'] === 'string' ? o['error'] : JSON.stringify(o['error']);
      if (isTransportError(error)) {
        this.noteTransport(error);
        return { outcome: 'unknown', algo_id, error };
      }
      if (outcome === 'submitted' && algo_id) return { outcome, algo_id, error: null };
      if (outcome === 'failed' || outcome === 'skipped' || outcome === 'filled') return { outcome, algo_id, error };
      return { outcome: 'unknown', algo_id, error: error ?? r.error ?? 'missing/invalid algo receipt or algo_id' };
    };
    return {
      entry: { ...entry, executed_qty: entryObj?.['executed_qty'] == null ? null : String(entryObj['executed_qty']), order_id: entryObj?.['order_id'] == null ? null : String(entryObj['order_id']) },
      stop: leg(r.obj?.['stop'], true), tp: leg(r.obj?.['tp'], !!req.take_profit),
    };
  }

  /**
   * 保护腿 = closePosition 条件单。币安 USDⓈ-M 的条件单(STOP_MARKET/TAKE_PROFIT_MARKET)走 **算法单接口**
   * `futures_usds.newAlgoOrder`(algoType=CONDITIONAL,triggerPrice),不是 newOrder(它暴露的 schema 表达不了
   * stopPrice/closePosition)。经 tool_execute 透传;经济字段由代码定死,子代理只负责发送,不得改单型/改价/找别的路径。
   * 双向持仓模式下必须带 positionSide 且**不能**带 reduceOnly / quantity。
   * 2026-09-06 探针(本机同一 MCP 登录):flat 时挂 closePosition 止损被交易所拒 -4509「TIF GTE 只能用于已有持仓」——
   * 所以保护腿只能在入场成交之后挂,传输链路本身已证明可达交易所。
   */
  private protective(op: 'place_stop' | 'place_take_profit', symbol: string, position: Direction, trigger: string, id: string): Promise<OrderReceipt> {
    const orderType = op === 'place_stop' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';
    const wire = {
      algoType: 'CONDITIONAL',
      symbol,
      side: position === 'long' ? 'SELL' : 'BUY',
      positionSide: position.toUpperCase(),
      type: orderType,
      triggerPrice: Number(trigger),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      clientAlgoId: id,
    };
    return this.run(
      this.task(op, {
        symbol,
        order_type: orderType,
        stop_price: trigger,
        close_position: true,
        client_order_id: id,
        transport: {
          how: 'Call the meta tool `tool_execute` with toolName "futures_usds.newAlgoOrder" and EXACTLY the `arguments` object below. Conditional orders live on the algo-order endpoint; the plain futures_usds.newOrder tool cannot express triggerPrice/closePosition — do not try it.',
          toolName: 'futures_usds.newAlgoOrder',
          arguments: wire,
          hedge_mode_note: 'The account runs in Hedge Mode: keep positionSide, and do NOT add reduceOnly or quantity. If the account turns out to be One-way Mode, send positionSide "BOTH" instead and still no quantity.',
          on_rejection: 'If tool_execute is unavailable or the exchange rejects the order (e.g. -4509 no open position), do NOT place any other order type; report outcome "failed" with the exact server error text. Report the returned algoId/clientAlgoId in "order_id".',
        },
      }),
      ORDER_SHAPE,
    ).then((r) => this.toReceipt(r));
  }
  placeStop(symbol: string, position: Direction, stop_price: string, id: string): Promise<OrderReceipt> {
    return this.protective('place_stop', symbol, position, stop_price, id);
  }

  /** 条件单还挂着吗(按 clientAlgoId)。unknown → null,调用方不得把 null 当「没有」。 */
  async algoOrderExists(symbol: string, client_algo_id: string): Promise<boolean | null> {
    const r = await this.run(
      this.task('query_algo_orders', {
        symbol,
        client_algo_id,
        transport: { how: 'Call tool_execute with toolName "futures_usds.currentAllAlgoOpenOrders" and arguments {"symbol": symbol}. Report found=true only if an order whose clientAlgoId equals client_algo_id is in the returned list.', toolName: 'futures_usds.currentAllAlgoOpenOrders', arguments: { symbol } },
      }),
      '{"ok":boolean,"found":boolean,"orders":[{"client_algo_id":string,"algo_id":string,"type":string,"trigger_price":string|null,"position_side":string|null,"status":string}],"error"?:string}',
    );
    if (!r.obj || r.obj['ok'] !== true) return null;
    return typeof r.obj['found'] === 'boolean' ? r.obj['found'] : null;
  }

  /** 这个币上挂着的所有条件单。09-06:金丝雀残留的 closePosition 止损会让下一张同向止损被拒 -4130,验证前要先清。 */
  async listAlgoOrders(symbol: string): Promise<{ client_algo_id: string; algo_id: string | null }[] | null> {
    const r = await this.run(
      this.task('list_algo_orders', {
        symbol,
        transport: { how: 'Call tool_execute with toolName "futures_usds.currentAllAlgoOpenOrders" and arguments {"symbol": symbol}. Report every order in the returned list; an empty list is ok=true with orders=[].', toolName: 'futures_usds.currentAllAlgoOpenOrders', arguments: { symbol } },
      }),
      '{"ok":boolean,"orders":[{"client_algo_id":string,"algo_id":string|null,"type":string,"position_side":string|null}],"error"?:string}',
    );
    if (!r.obj || r.obj['ok'] !== true || !Array.isArray(r.obj['orders'])) return null;
    return (r.obj['orders'] as Record<string, unknown>[])
      .map((o) => ({ client_algo_id: String(o['client_algo_id'] ?? ''), algo_id: o['algo_id'] == null ? null : String(o['algo_id']) }))
      .filter((o) => o.client_algo_id !== '');
  }

  async cancelAlgoOrder(symbol: string, client_algo_id: string): Promise<{ ok: boolean; error: string | null }> {
    const r = await this.run(
      this.task('cancel_algo_order', {
        symbol,
        client_algo_id,
        transport: { how: 'Call tool_execute with toolName "futures_usds.cancelAlgoOrder" and EXACTLY the arguments below. If the exchange says the order does not exist / is already canceled, report ok=true with error "already gone".', toolName: 'futures_usds.cancelAlgoOrder', arguments: { clientAlgoId: client_algo_id } },
      }),
      '{"ok":boolean,"error"?:string}',
    );
    this.invalidateAccount();
    if (!r.obj) return { ok: false, error: r.error ?? 'no receipt' };
    return { ok: r.obj['ok'] === true, error: r.obj['error'] == null ? null : String(r.obj['error']) };
  }
  placeTakeProfit(symbol: string, position: Direction, tp: string, id: string): Promise<OrderReceipt> {
    return this.protective('place_take_profit', symbol, position, tp, id);
  }

  async closePosition(symbol: string, id: string): Promise<{ closed: boolean; receipt: unknown; error: string | null }> {
    const r = await this.run(this.task('close_position', { symbol, order_type: 'MARKET', reduce_only: true, close_position: true, quantity: null, client_order_id: id, note: 'close the whole open position on this symbol; if there is no position, report ok=true outcome="filled" with executed_qty "0"' }), ORDER_SHAPE);
    const rec = this.toReceipt(r);
    // 'unknown' must never read as "flat": only a positive fill/submit counts as closed.
    if (rec.outcome === 'filled' || rec.outcome === 'submitted') return { closed: true, receipt: rec.receipt, error: null };
    return { closed: false, receipt: rec.receipt, error: rec.error ?? `agent reported ${rec.outcome}` };
  }

  async reducePosition(symbol: string, qty: string, id: string): Promise<OrderReceipt> {
    const acct = await this.account();
    const pos = acct.positions.find((p) => p.symbol === symbol);
    if (!pos) return { outcome: 'failed', receipt: null, avg_price: null, error: 'no position' };
    return this.toReceipt(
      await this.run(
        this.task('reduce_position', {
          symbol,
          side: pos.side === 'long' ? 'SELL' : 'BUY',
          position_side_if_hedge: pos.side.toUpperCase(),
          order_type: 'MARKET',
          quantity: qty,
          reduce_only: true,
          close_position: false,
          client_order_id: id,
        }),
        ORDER_SHAPE,
      ),
    );
  }

  async cancelAll(symbol: string): Promise<{ ok: boolean; error: string | null }> {
    const r = this.toReceipt(await this.run(this.task('cancel_all', { symbol, note: 'cancel every open order (including conditional / algo orders) on this symbol' }), ORDER_SHAPE));
    return { ok: r.outcome === 'filled' || r.outcome === 'submitted', error: r.error };
  }

  async cancelOrder(symbol: string, client_order_id: string): Promise<{ ok: boolean; error: string | null }> {
    const r = this.toReceipt(await this.run(this.task('cancel_order', { symbol, client_order_id, note: 'cancel this one order by its client order id; if it does not exist any more report ok=true outcome="filled"' }), ORDER_SHAPE));
    this.orderCache.delete(client_order_id);
    return { ok: r.outcome === 'filled' || r.outcome === 'submitted', error: r.error };
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ ok: boolean; error: string | null }> {
    const r = this.toReceipt(await this.run(this.task('set_leverage', { symbol, leverage }), ORDER_SHAPE));
    return { ok: r.outcome === 'filled' || r.outcome === 'submitted', error: r.error };
  }

  async setMarginType(symbol: string, mode: 'cross' | 'isolated'): Promise<{ ok: boolean; error: string | null }> {
    const r = this.toReceipt(await this.run(this.task('set_margin_type', { symbol, margin_type: mode === 'cross' ? 'CROSSED' : 'ISOLATED', note: 'if it is already this margin type, report ok=true outcome="filled"' }), ORDER_SHAPE));
    return { ok: r.outcome === 'filled' || r.outcome === 'submitted', error: r.error };
  }

  // ------------------------------------------------------------ read ops

  /** Public REST — free, no CLI run. */
  async markPrice(symbol: string): Promise<string> {
    const pi = await fetchPremiumIndex(symbol);
    return Number(pi.markPrice).toString();
  }

  /** Public REST — free, no CLI run. Same shape as PaperBackend's `symbols: 'live'`. */
  async symbols(): Promise<SymbolInfo[]> {
    if (this.symbolsCache && Date.now() - this.symbolsFetchedAt < 10 * 60_000) return this.symbolsCache;
    const rows = await fetchExchangeInfo();
    if (rows.length) {
      this.symbolsCache = rows;
      this.symbolsFetchedAt = Date.now();
      for (const r of rows) this.rulesCache.set(r.symbol, { step_size: r.step_size, tick_size: r.tick_size, min_qty: r.min_qty, min_notional: r.min_notional });
    }
    return this.symbolsCache ?? [];
  }

  async symbolRules(symbol: string): Promise<SymbolRules> {
    const cached = this.rulesCache.get(symbol);
    if (cached) return cached;
    await this.symbols();
    return this.rulesCache.get(symbol) ?? { step_size: '0.001', tick_size: '0.1', min_qty: '0.001', min_notional: '5' };
  }

  /** Drops the account cache; called after every write op so the next read sees the exchange truth. */
  invalidateAccount(): void {
    this.accountCache = null;
  }

  /** 账户读的固有陈旧度:当前用的缓存 TTL + 一次 CLI 的时间。 */
  accountStalenessMs(): number {
    return (this.opts.idle?.() ? this.idleTtlMs : this.accountTtlMs) + this.timeoutMs;
  }

  /** One CLI run per uncached call. Cached `accountTtlMs`, invalidated by every write op. */
  account(): Promise<AccountView> {
    const cached = this.accountCache;
    const ttl = this.opts.idle?.() ? this.idleTtlMs : this.accountTtlMs;
    if (cached && Date.now() - cached.at < ttl) return Promise.resolve(cached.view);
    if (this.accountInFlight) return this.accountInFlight;
    this.accountInFlight = this.accountInner().finally(() => {
      this.accountInFlight = null;
    });
    return this.accountInFlight;
  }

  private async accountInner(): Promise<AccountView> {
    const r = await this.run(
      this.task('account', {
        note: 'read the futures account: total equity, available balance, unrealized pnl, every open position with a non-zero size, and every open order INCLUDING conditional / algo orders. Read only — place nothing.',
        // 09-07:普通 open orders 接口不含条件单,子代理以前只读它,带止损的仓被报成「缺止损」。条件单要单独走算法单接口再合并。
        algo_orders: 'Conditional orders (STOP_MARKET / TAKE_PROFIT_MARKET, closePosition) live on the ALGO endpoint and do NOT appear in the plain open-orders call. After the plain read, ALSO call tool_execute with toolName "futures_usds.currentAllAlgoOpenOrders" and arguments {} (or per symbol with a position) and merge every returned algo order into open_orders as: type = its orderType (e.g. STOP_MARKET), side = its side, stop_price = its triggerPrice, qty = its quantity or "0" when closePosition, reduce_only = true when closePosition/reduceOnly, client_order_id = its clientAlgoId, status = its algoStatus. If the algo call fails, still return the account with the plain orders and put the error text in "note".',
      }),
      ACCOUNT_SHAPE,
    );
    if (!r.obj || r.obj['ok'] === false || typeof r.obj['account'] !== 'object' || r.obj['account'] === null) {
      throw new Error(`agent_mcp account 读取失败:${r.error ?? String(r.obj?.['error'] ?? '返回里没有 account')}`);
    }
    const a = r.obj['account'] as Record<string, unknown>;
    const positions: PositionView[] = (Array.isArray(a['positions']) ? (a['positions'] as Record<string, unknown>[]) : [])
      .map((p) => ({
        symbol: String(p['symbol'] ?? ''),
        side: (String(p['side'] ?? 'long').toLowerCase() === 'short' ? 'short' : 'long') as Direction,
        qty: String(p['qty'] ?? '0'),
        entry_price: String(p['entry_price'] ?? '0'),
        mark_price: String(p['mark_price'] ?? '0'),
        unrealized_pnl: Number(p['unrealized_pnl'] ?? '0').toFixed(2),
        leverage: Number(p['leverage'] ?? '0'),
      }))
      .filter((p) => p.symbol && Number(p.qty) !== 0);
    const open_orders: OpenOrderView[] = (Array.isArray(a['open_orders']) ? (a['open_orders'] as Record<string, unknown>[]) : []).map((o) => ({
      symbol: String(o['symbol'] ?? ''),
      client_order_id: String(o['client_order_id'] ?? ''),
      type: String(o['type'] ?? ''),
      side: String(o['side'] ?? ''),
      qty: String(o['qty'] ?? '0'),
      price: o['price'] === null || o['price'] === undefined || Number(o['price']) <= 0 ? null : String(o['price']),
      stop_price: o['stop_price'] === null || o['stop_price'] === undefined || Number(o['stop_price']) <= 0 ? null : String(o['stop_price']),
      reduce_only: Boolean(o['reduce_only']),
      status: String(o['status'] ?? 'NEW'),
    }));
    const view: AccountView = {
      backend: this.kind,
      equity: Number(a['equity'] ?? '0').toFixed(2),
      available: Number(a['available'] ?? '0').toFixed(2),
      unrealized_pnl: Number(a['unrealized_pnl'] ?? '0').toFixed(2),
      positions,
      open_orders,
      as_of: Date.now(),
    };
    if (Number(view.equity) <= 0 && positions.length === 0) {
      view.quality = 'unfunded';
      view.note = '币安 Agentic 子账户读取成功但未入金(权益 0、无持仓);去 https://www.binance.com/en/my/sub-account/asset-management/transfer 划转后才能开仓';
    } else view.quality = 'ok';
    this.accountCache = { at: Date.now(), view };
    return view;
  }

  /** One CLI run per uncached call; cached 30 s per client_order_id. */
  async getOrder(symbol: string, client_order_id: string): Promise<OrderStatusView | null> {
    const hit = this.orderCache.get(client_order_id);
    if (hit && Date.now() - hit.at < ORDER_TTL_MS) return hit.view;
    const r = await this.run(this.task('get_order', { symbol, client_order_id, note: 'look this one order up by its client order id (check conditional / algo orders too). Read only. If it does not exist, reply with order: null.' }), ORDER_STATUS_SHAPE);
    if (!r.obj || r.obj['ok'] === false) throw new Error(`agent_mcp get_order 失败:${r.error ?? String(r.obj?.['error'] ?? 'unknown')}`);
    const raw = r.obj['order'];
    if (raw === null || raw === undefined) {
      this.orderCache.set(client_order_id, { at: Date.now(), view: null });
      return null;
    }
    const o = raw as Record<string, unknown>;
    const avg = o['avg_price'] === null || o['avg_price'] === undefined ? null : String(o['avg_price']);
    const view: OrderStatusView = { status: String(o['status'] ?? ''), avg_price: avg && Number(avg) > 0 ? avg : null, executed_qty: String(o['executed_qty'] ?? '0'), raw: o['raw'] ?? o };
    this.orderCache.set(client_order_id, { at: Date.now(), view });
    return view;
  }

  /** Not a simulator: nothing to advance. */
  tick(): PaperEvent[] {
    return [];
  }
}

// ---------------------------------------------------------------- connection probe

export type McpConnectionStatus = 'connected' | 'needs_auth' | 'unavailable' | 'unknown';

export interface McpConnection {
  status: McpConnectionStatus;
  checked_at: number | null;
  detail: string;
}

/**
 * Why codex cannot connect (verified 2026-09-04): `codex mcp add binance-mcp-server --url …` works and
 * lands in ~/.codex/config.toml, but `codex mcp login` dies with "Dynamic client registration not
 * supported" — Binance only publishes an OAuth client-id metadata document (CIMD), which this Codex
 * build does not implement. The option stays selectable (a future Codex will fix it) but never probes.
 */
export const CODEX_MCP_BLOCKED_DETAIL = 'Codex 的 MCP OAuth 只支持动态注册,币安只支持 CIMD;等 Codex 支持后再用';

/**
 * Best-effort read of whether the CLI's MCP session is logged in. Run with cwd = the user's home dir,
 * because that is the project scope the server was registered in (`cd ~ && claude mcp get …`).
 */
export async function probeMcpConnection(cli: AgentCli, name = DEFAULT_MCP_NAME, spawnFn: AgentSpawn = defaultAgentSpawn, timeoutMs = 20_000, command?: string | null): Promise<McpConnection> {
  if (cli === 'codex') return { status: 'unavailable', checked_at: Date.now(), detail: CODEX_MCP_BLOCKED_DETAIL };
  const home = os.homedir();
  // Same launch path as every other run of this CLI, so an alias-only `claude` is probed too.
  const launchCmd = command?.trim() || defaultCliCommand(cli);
  const launch = cliSpawnArgs(launchCmd, ['mcp', 'get', name]);
  const r = await spawnFn(launch.file, launch.args, '', { cwd: home, timeoutMs, env: launch.env });
  const at = Date.now();
  const text = stripShellNoise(`${r.stdout}\n${r.stderr}`).trim();
  if (r.spawnError) return { status: 'unavailable', checked_at: at, detail: `${launchCmd} 起不来(不在 PATH、也不是登录 shell 认识的命令):${r.spawnError}` };
  if (r.timedOut) return { status: 'unknown', checked_at: at, detail: `${launchCmd} mcp get ${name} 超时` };
  if (/needs authentication|not authenticated|需要认证|请登录/i.test(text)) return { status: 'needs_auth', checked_at: at, detail: trimLines(text) };
  if (r.code !== 0) return { status: 'unavailable', checked_at: at, detail: trimLines(text) || `${launchCmd} mcp get ${name} exit ${r.code}` };
  if (/connected|✓|已连接|authenticated/i.test(text)) return { status: 'connected', checked_at: at, detail: trimLines(text) };
  return { status: 'unknown', checked_at: at, detail: trimLines(text) || `${launchCmd} mcp get ${name} 输出无法判断` };
}

function trimLines(s: string): string {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(' · ')
    .slice(0, 400);
}

/** claude has no headless MCP login: the human does it once in an interactive session. */
export function claudeLoginInstructions(name = DEFAULT_MCP_NAME, command?: string | null): string {
  const cmd = command?.trim() || defaultCliCommand('claude');
  return `在终端 cd ~ && ${cmd},输入 /mcp,选择 ${name} → Authenticate 完成登录;登录一次后网关复用该会话`;
}

// ---------------------------------------------------------------- pop a Terminal for the login

/**
 * The one command the human has to run. `claude` starts interactive by default and takes the initial
 * prompt as a positional argument, so `/mcp` opens the MCP panel straight away (`claude --help`:
 * "starts an interactive session by default" + "Arguments: prompt"). cwd = ~ because that is the
 * project scope `binance-mcp-server` is registered in.
 */
export function claudeLoginCommand(command?: string | null): string {
  return `cd ~ && ${command?.trim() || defaultCliCommand('claude')} "/mcp"`;
}

/** The default form of {@link claudeLoginCommand} (no per-machine command configured yet). */
export const CLAUDE_LOGIN_COMMAND = claudeLoginCommand();

export interface TerminalOpenResult {
  ok: boolean;
  error: string | null;
}
/** Injectable so tests never really talk to Terminal.app. */
export type TerminalOpener = (cmd: string) => TerminalOpenResult;

/** AppleScript string literal escaping: only `\` and `"` matter inside `do script "…"`. */
function osaQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Opens a new macOS Terminal window running `cmd` and brings Terminal to the front. Reads nothing:
 * the human types in that window, the CLI owns the OAuth session (AGENTS.md rule 1). Non-macOS or an
 * osascript failure → `{ok:false}` and the caller falls back to printed instructions.
 */
export const openTerminalWith: TerminalOpener = (cmd) => {
  if (process.platform !== 'darwin') return { ok: false, error: `当前系统是 ${process.platform},只有 macOS 能自动弹终端` };
  try {
    const r = spawnSync('osascript', ['-e', `tell application "Terminal" to do script "${osaQuote(cmd)}"`, '-e', 'tell application "Terminal" to activate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: String(r.stderr ?? '').trim() || `osascript 退出码 ${r.status}` };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

/** codex login is blocked upstream (see CODEX_MCP_BLOCKED_DETAIL): never spawn it, just explain. */
export function codexLoginInstructions(name = DEFAULT_MCP_NAME): string {
  return `${CODEX_MCP_BLOCKED_DETAIL}。\`codex mcp add ${name} --url ${DEFAULT_MCP_URL}\` 已可用,但 \`codex mcp login\` 会报 "Dynamic client registration not supported";先用 claude。`;
}
