// The v2 loop (design notes): information officer → scans → strategy threads → order
// tracking → reviews, plus manual orders and chat, all sharing one brain queue and one execution
// backend. Threads are persisted plans; their STATUS is re-derived from exchange facts every poll.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Brain } from './brain.js';
import { commandForKind, estimateCny, makeBrain } from './brain.js';
import { cliLaunchStatus } from './cli-launch.js';
import { edgeFor, GRAPH_VERSION, guardsFromGates } from './graph.js';
import type { NetCheckResult } from './types.js';
import { runChatTurn, type ChatTools } from './chat.js';
import { buildContext, PROMPT_VERSION } from './context.js';
import type { ExecBackend, OrderReceipt, PaperEvent } from './execution.js';
import { DEFAULT_MCP_NAME, DEFAULT_MCP_URL, isTransportError, probeMcpConnection } from './execution-agent.js';
import { computeSizing, DEFAULT_GATES, evaluateGates, type GateConfig } from './gates.js';
import { runInformationOfficer } from './info.js';
import { strategyWakes } from './strategies.js';
import { dailyRegime, fetchFundingRateHistory, fetchKlines, fetchMarketView, fetchOpenInterestHist, fetchTicker24h, nextCloseAfter, tfFeatures, tfToMs, type TfFeatures } from './market.js';
import { detectTriggers, sessionInfo, windowMovePct } from './triggers.js';
import { heartbeatFingerprint } from './fingerprint.js';
import { BrainQueue } from './queue.js';
import { Radar, type RadarOptions } from './radar.js';
import { extractJson, validateJudgment } from './schema.js';
import type { DemoStore } from './store.js';
import { ATTRIBUTION_GRACE_MS, isOpen, newThread, nextLegCid, openingBlockers, reconcileThread, reduceReview, threadClientPrefix } from './threads.js';
import type { AccountView, ActivityItem, ActivityKind, Backend, BrainKind, ChatMessage, DailyRegime, DemoIntent, Direction, Episode, EpisodeStep, ExecutionOption, ExecutionView, HistoryResponse, HistoryThreadRow, Judgment, LogLine, LoopView, ManualOrderRequest, MarketState, MarketView, QueueView, RegimeView, SessionInfo, StrategyThread, SymbolInfo, Trigger, TriggerHit, TriggerKind, UsageToday, Workflow } from './types.js';
import { summarize } from './types.js';
import { applyWorkflowPatch, BACKENDS, loadWorkflow, WORKFLOW_BOUNDS } from './workflow.js';
import type { ProtectionStatusView } from './types.js';
import { ConfirmationStore, fingerprintOf, PROPOSAL_TTL_MS, splitWorkflowPatch, type ConfirmToken, type WorkflowProposal } from './confirm.js';

export interface RuntimeOptions {
  store: DemoStore;
  backend: ExecBackend;
  /**
   * Factories for the backends this process can switch to at runtime (main.ts registers them).
   * The kind the runtime booted on is always selectable even without a factory (it is already built).
   */
  backends?: Partial<Record<Backend, () => ExecBackend>>;
  /**
   * Extra per-kind availability gates for `executionView()`. main.ts wires `cli` here because whether
   * that channel is usable depends on state the runtime does not own (is binance-cli installed, does the
   * profile exist). `note` replaces the static note so the UI can say WHY it is not selectable.
   */
  backendGates?: Partial<Record<Backend, () => { available: boolean; note?: string }>>;
  brains?: Partial<Record<BrainKind, Brain>>;
  gates?: GateConfig;
  marketPollMs?: number;
  accountPollMs?: number;
  /** 测试注入 Radar 的 runScreen(真实版打币安公共 REST)。 */
  radar?: RadarOptions;
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}
function utcDayStart(now: number): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}
/** The daily judgment cap is a human budget ("today"), so it runs on the local day, not UTC. */
function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const BACKEND_LABELS: Record<Backend, string> = {
  paper: '纸面模拟(本地撮合)',
  demo: 'Binance 模拟盘(tswarm-demo-exec)',
  cli: 'Binance 模拟盘(官方 binance-cli)',
  agent_mcp: '币安官方 MCP(agent CLI 驱动)',
};
const BACKEND_NOTES: Record<Backend, string> = {
  paper: '不碰交易所,余额与持仓存在本地库里;换后端不会带走纸面持仓。',
  demo: '走 Rust 子进程 tswarm-demo-exec,密钥只在子进程里。',
  cli: '走官方 binance-cli(Skills Hub binance 技能),BINANCE_API_ENV=demo,密钥在 CLI 自己的 profile 里。',
  agent_mcp: '每个写操作 = 一次 agent CLI 运行,由它调币安官方 MCP 工具;网关不持有任何币安密钥或 token。读接口里只有账户与订单查询要花一次 CLI 运行(有缓存),行情走公开 REST。',
};

const TRIGGER_LABEL: Partial<Record<TriggerKind, string>> = { fast_move: '急拉急跌', breakout: '突破', ema_cross: 'EMA 交叉', vol_spike: '放量', retest: '回踩', session: '交易时段', funding: '资金费率', heartbeat: '心跳' };
const FAST_MOVE_WINDOW_MS = 5 * 60_000;
const FAST_MOVE_COOLDOWN_MS = 10 * 60_000;
const REGIME_TTL_MS = 60 * 60_000;
const EQUITY_POINT_MS = 60_000;
/** At most one "cap reached" log + activity per this window, however many triggers are skipped. */
const CAP_NOTICE_MS = 10 * 60_000;
/** MCP connection probe cache (one `claude mcp get` spawn per window at most). */
const CONN_PROBE_TTL_MS = 60_000;

/** 入场调用的最长在途时间(agent_mcp 调用 timeout 120 s + 余量);超过后巡检恢复正常查单。 */
const SUBMIT_PHASE_MAX_MS = 150_000;

export class DemoRuntime extends EventEmitter {
  readonly store: DemoStore;
  /** Mutable since v3.3: `switchBackend()` swaps it when no thread is open (design notes). */
  backend: ExecBackend;
  private readonly backendFactories: Partial<Record<Backend, () => ExecBackend>>;
  private readonly backendGates: Partial<Record<Backend, () => { available: boolean; note?: string }>>;
  private conn: ExecutionView['connection'] = { status: 'unknown', checked_at: null, detail: '还没检测' };
  private switching: Promise<string | null> | null = null;
  private capNoticeAt = 0;
  workflow: Workflow;
  markets = new Map<string, MarketView>();
  account: AccountView | null = null;
  marketState: MarketState | null = null;
  readonly queue: BrainQueue;
  /** Radar 角色(radar.ts):定时全市场筛选,产出 watchlist 提案;只读行情。 */
  readonly radar: Radar;
  /** v3.10 人批:一次性 confirm token(意图批准 / 设置提议 apply)。 */
  readonly confirmations = new ConfirmationStore();
  /** v3.11 保护腿自验证(§9.20):运行态 + 落库记录 demo_kv `protection_verified:<backend>` */
  private protectionRun: { running: boolean; last_run_at: number | null; last_error: string | null; steps: { name: string; ok: boolean; detail: string }[] } = { running: false, last_run_at: null, last_error: null, steps: [] };
  private readonly proposals = new Map<string, WorkflowProposal>();
  private brains: Partial<Record<BrainKind, Brain>>;
  private brainCache = new Map<string, Brain>();
  private readonly gatesCfg: GateConfig;
  private halted = false;
  private inFlight: Episode | null = null;
  private klineTimer: NodeJS.Timeout | null = null;
  private infoTimer: NodeJS.Timeout | null = null;
  private nextAt: number | null = null;
  private pollers: NodeJS.Timeout[] = [];
  private lastEpisodeId: string | null = null;
  private readonly marketPollMs: number;
  private readonly accountPollMs: number;
  private protectionRetryAt = new Map<string, number>();
  private externalWarnedAt = 0;
  private symbolsCache: SymbolInfo[] | null = null;
  private pendingPaperEvents: PaperEvent[] = [];
  private marketPolling = false;
  private accountPolling: Promise<void> | null = null;
  private approving = new Set<string>();
  // v3 triggers / regime (design notes)
  private markHistory = new Map<string, { at: number; mark: number }[]>();
  private lastModelCallAt = new Map<string, number>();
  private lastFeatures = new Map<string, TfFeatures>();
  private lastH1 = new Map<string, TfFeatures>();
  /** Fingerprint of what the playbook saw at the last model call per symbol (heartbeat de-dup, fingerprint.ts). */
  private lastAskFingerprint = new Map<string, string>();
  private heartbeatSkipped = new Map<string, number>();
  private regimeCache = new Map<string, { at: number; regime: DailyRegime | null }>();
  private fastMoveFiredAt = new Map<string, number>();
  private prevSessionName: SessionInfo['name'] | null = null;
  private lastTriggerHits = new Map<string, TriggerHit[]>();
  /** v3.5: funding history per symbol for the 30-day z-score; refreshed at most hourly (it moves every 8h). */
  private fundingHistory = new Map<string, { at: number; rows: { at: number; rate: string }[] }>();

  constructor(opts: RuntimeOptions) {
    super();
    this.store = opts.store;
    this.backend = opts.backend;
    this.backendFactories = opts.backends ?? {};
    this.backendGates = opts.backendGates ?? {};
    this.brains = opts.brains ?? {};
    this.gatesCfg = opts.gates ?? DEFAULT_GATES;
    this.marketPollMs = opts.marketPollMs ?? 10_000;
    this.accountPollMs = opts.accountPollMs ?? 15_000;
    this.workflow = loadWorkflow(this.store.loadWorkflowJson());
    this.halted = this.store.kvGet('demo.halted') === '1';
    this.queue = new BrainQueue((v) => this.emit('queue.state', v));
    this.radar = new Radar(this, opts.radar ?? {});
    this.marketState = this.store.latestMarketState();
    // The boot choice wins over whatever was persisted: `workflow.execution` must always name the
    // backend actually running, or the UI would offer to "switch" to the one it is already on.
    this.workflow.execution = this.backend.kind;
  }

  // ------------------------------------------------------------ logging / views

  log(level: LogLine['level'], scope: string, message: string, data?: unknown): void {
    const line: LogLine = { at: Date.now(), level, scope, message, ...(data === undefined ? {} : { data }) };
    this.store.log(line);
    this.emit('log', line);
    const tag = level === 'error' ? 'ERR ' : level === 'warn' ? 'WARN' : 'info';
    console.error(`${new Date(line.at).toISOString()} ${tag} [${scope}] ${message}`);
  }

  /** One plain-language line from the agent into the chat (the "旁白"): makes the loop feel alive. */
  narrate(text: string, episodeId: string | null = null): void {
    if (!this.workflow.narrate) return;
    const m: ChatMessage = { id: `msg-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, at: Date.now(), role: 'agent', text: `旁白 · ${text}`, tool_calls: [], episode_id: episodeId, kind: 'narration' };
    this.store.saveChat(m);
    this.emit('chat.message', m);
  }

  /** One prominent line for the activity timeline (the user-facing "what happened"); raw logs stay separate. */
  activity(kind: ActivityKind, a: { title: string; level?: ActivityItem['level']; symbol?: string | null; thread_id?: string | null; episode_id?: string | null; detail?: string | null; data?: Record<string, unknown> }): ActivityItem {
    const item: ActivityItem = { id: id('act'), at: Date.now(), kind, level: a.level ?? 'info', symbol: a.symbol ?? null, thread_id: a.thread_id ?? null, episode_id: a.episode_id ?? null, title: a.title, detail: a.detail ?? null, data: a.data ?? {} };
    this.store.saveActivity(item);
    this.emit('activity', item);
    return item;
  }

  private progress(step: EpisodeStep, episodeId: string | null = null): void {
    this.queue.progress(step, episodeId);
    this.emit('episode.progress', { step, episode_id: episodeId, at: Date.now() });
  }

  /** The configured launch command for one CLI kind (null for `stub`, which spawns nothing). */
  cliCommandFor(kind: BrainKind): string | null {
    return commandForKind(kind, this.workflow.cli_commands);
  }

  /**
   * Brain for (kind, model). Injected brains (tests) win per kind; otherwise one instance per
   * kind:model:command, built lazily — the launch command is part of the key so editing it in the UI
   * takes effect on the next judgment without a restart.
   */
  brainFor(kind: BrainKind, model: string | null = null): Brain {
    const injected = this.brains[kind];
    if (injected) return injected;
    const command = this.cliCommandFor(kind);
    const key = `${kind}:${model ?? ''}:${command ?? ''}`;
    const cached = this.brainCache.get(key);
    if (cached) return cached;
    const b = makeBrain(kind, model, { command });
    this.brainCache.set(key, b);
    return b;
  }
  /** The judgment/chat brain as currently selected in the workflow. */
  mainBrain(): Brain {
    return this.brainFor(this.workflow.brain, this.workflow.brain_model);
  }
  /** The information officer's brain as currently selected in the workflow. */
  cheapBrain(): Brain {
    return this.brainFor(this.workflow.cheap_brain, this.workflow.cheap_brain_model);
  }

  loopView(): LoopView {
    return {
      running: this.inFlight !== null,
      paused: this.workflow.paused,
      halted: this.halted,
      every_ms: tfToMs(this.workflow.timeframe),
      next_at: this.nextAt,
      last_episode_id: this.lastEpisodeId,
      brain: this.mainBrain().name,
      cheap_brain: this.cheapBrain().name,
      backend: this.backend.kind,
      auto_approve: this.workflow.auto_approve,
    };
  }
  queueView(): QueueView {
    return this.queue.view();
  }
  private emitLoop(): void {
    this.emit('loop.state', this.loopView());
  }
  /** 当前执行通道下的开放线程。别的通道的线程休眠(不复查、不对账),切回去才醒。 */
  openThreads(): StrategyThread[] {
    return this.store.threads({ statuses: ['pending_entry', 'in_position'], backend: this.backend.kind });
  }
  private accountReadError: { at: number; message: string } | null = null;
  get isHalted(): boolean {
    return this.halted;
  }

  // ------------------------------------------------------------ execution backend (v3.3, §9.6)

  /** What the UI needs to show and change the execution channel; `connection` is the last cached probe. */
  executionView(): ExecutionView {
    const blocker = this.switchBlocker();
    // agent_mcp is only selectable when the CONFIGURED launch command resolves (a PATH hit, or a word the
    // login shell knows — a shell alias is not on PATH at all).
    const agentCommand = this.cliCommandFor(this.workflow.exec_agent_cli) ?? this.workflow.exec_agent_cli;
    const options: ExecutionOption[] = BACKENDS.map((kind) => {
      let gate: { available: boolean; note?: string } | null = null;
      try {
        gate = this.backendGates[kind]?.() ?? null;
      } catch (e) {
        gate = { available: false, note: `状态检查失败:${(e as Error).message}` };
      }
      const available = kind === this.backend.kind || (this.backendFactories[kind] !== undefined && (kind !== 'agent_mcp' || cliLaunchStatus(agentCommand).ok) && (gate === null || gate.available));
      const recommended = kind === 'agent_mcp';
      return { kind, label: BACKEND_LABELS[kind], available, note: !available && gate?.note ? gate.note : BACKEND_NOTES[kind], recommended, setup: kind === 'cli' && !available ? (gate?.note ?? '还没接好') : null };
    });
    return {
      backend: this.backend.kind,
      protection: this.protectionStatus(),
      transport: this.backend.transportHealth?.() ?? null,
      options,
      agent: {
        cli: this.workflow.exec_agent_cli,
        // Mirror AgentMcpBackend.argv(): a null model means `--model sonnet` for claude, the CLI's own
        // default for codex. The UI must show what will really run, not an empty field.
        model: this.workflow.exec_agent_model ?? (this.workflow.exec_agent_cli === 'claude' ? 'sonnet' : null),
        model_note: this.workflow.exec_agent_cli === 'claude' ? '默认 sonnet,便宜' : null,
        server_name: DEFAULT_MCP_NAME,
        url: DEFAULT_MCP_URL,
        command: agentCommand,
        resolved: cliLaunchStatus(agentCommand),
      },
      connection: this.conn,
      account_read_error: this.accountReadError,
      account_funded: this.account && this.account.backend === this.backend.kind ? this.account.quality !== 'unfunded' : null,
      can_switch: blocker === null,
      switch_blocker: blocker,
    };
  }

  // ------------------------------------------------------------ v3.11 保护腿自验证(§9.20)

  private protectionKey(): string {
    return `protection_verified:${this.backend.kind}`;
  }
  private protectionRecord(): { at: number; symbol: string; qty: string; algo_id: string | null } | null {
    try {
      const raw = this.store.kvGet(this.protectionKey());
      return raw ? (JSON.parse(raw) as { at: number; symbol: string; qty: string; algo_id: string | null }) : null;
    } catch {
      return null;
    }
  }
  /** 这条通道现在能不能开新仓(保护腿可靠)。paper / Rust / cli 后端天然 verified;agent_mcp 看 env 覆盖或落库的金丝雀记录。 */
  protectionOk(): boolean {
    return this.protectionStatus().status === 'verified' || this.protectionStatus().status === 'not_needed';
  }
  protectionStatus(): ProtectionStatusView {
    const cost_note = '真钱最小仓(约 5 USDT 名义),几分钱手续费,约 2 分钟;过程:开仓 → 挂止损 → 确认挂上 → 撤止损 → 平仓';
    const base = { last_run_at: this.protectionRun.last_run_at, last_error: this.protectionRun.last_error, steps: this.protectionRun.steps, cost_note };
    if (!this.backend.protectionCapability) return { status: 'not_needed', verified_at: null, source: null, ...base };
    if (this.protectionRun.running) return { status: 'verifying', verified_at: null, source: null, ...base };
    if (this.backend.protectionCapability() === 'verified') return { status: 'verified', verified_at: null, source: 'env', ...base };
    const rec = this.protectionRecord();
    if (rec) return { status: 'verified', verified_at: rec.at, source: 'record', ...base };
    return { status: this.protectionRun.last_error ? 'failed' : 'unverified', verified_at: null, source: null, ...base };
  }
  /** 线上真挂止损失败(不是「无持仓」这类预期拒绝)→ 记录作废,重新阻断,并让告警带按钮。 */
  invalidateProtection(reason: string): void {
    if (!this.backend.protectionCapability) return;
    const had = this.protectionRecord();
    this.store.kvSet(this.protectionKey(), '');
    this.protectionRun.last_error = reason;
    this.log('error', 'exec', `保护腿验证记录作废(${had ? '之前已验证' : '未验证'}):${reason};新增开仓重新阻断,请在执行页重新验证`);
    this.emit('execution.changed', this.executionView());
  }
  /**
   * 用户点「用最小仓验证止损」:在当前通道上开最小仓 → 挂 closePosition 止损 → 确认挂着 → 撤 → 平 → 确认 flat。
   * 任一步失败:尽力撤单/平仓,记录失败原因,状态 failed(仍阻断)。通过:落库记录,自动放行。
   * 09-06 事故:金丝雀刚开进去网关就被重启,留下一张不属于任何线程的裸仓,再验证又被「已有持仓」挡住,死锁。
   * 所以:该币若有**无主**持仓(不属于任何线程)就直接接管它、跳过开仓——挂止损→确认→撤→平,顺手把裸仓收掉;
   * 只有线程持有的仓才拒绝。
   */
  async verifyProtection(opts: { symbol?: string } = {}): Promise<ProtectionStatusView> {
    if (!this.backend.protectionCapability) return this.protectionStatus();
    if (this.protectionRun.running) throw Object.assign(new Error('验证正在进行'), { status: 409 });
    if (this.halted) throw Object.assign(new Error('紧急停止中'), { status: 409 });
    const symbol = (opts.symbol ?? this.workflow.watchlist.find((x) => x !== 'BTCUSDT' && x !== 'ETHUSDT') ?? this.workflow.watchlist[0] ?? 'HYPEUSDT').toUpperCase();
    this.protectionRun = { running: true, last_run_at: Date.now(), last_error: null, steps: [] };
    this.emit('execution.changed', this.executionView());
    const steps = this.protectionRun.steps;
    const step = (name: string, ok: boolean, detail: string): void => {
      steps.push({ name, ok, detail });
      this.log(ok ? 'info' : 'error', 'exec', `止损验证 · ${name}:${ok ? 'ok' : '失败'} ${detail}`);
    };
    const tag = Date.now().toString(36).slice(-6);
    const cidE = `tgd-vfy-${tag}-e`;
    const cidS = `tgd-vfy-${tag}-s`;
    const cidC = `tgd-vfy-${tag}-c`;
    let entered = false;
    let stopLive = false;
    let failure: string | null = null;
    this.activity('chat_action', { symbol, level: 'warn', title: `开始在 ${this.backend.kind} 通道上用最小仓验证止损(${symbol})`, detail: this.protectionStatus().cost_note });
    try {
      const acct = await this.backend.account();
      const existing = acct.positions.find((p) => p.symbol === symbol) ?? null;
      const owned = existing !== null && this.openThreads().some((t) => t.symbol === symbol);
      if (existing && owned) throw new Error(`${symbol} 已有线程持仓,换一个没有持仓的币再验证`);
      const adopt = existing !== null;
      step('账户读取', true, adopt ? `权益 ${acct.equity},${symbol} 有一张无主持仓(${existing.side} ${existing.qty}),接管它做验证并顺手平掉` : `权益 ${acct.equity},${symbol} 无持仓`);
      // 残留的条件单(比如上次金丝雀挂上的止损)会让这次同向止损被拒 -4130,先清干净
      if (this.backend.listAlgoOrders && this.backend.cancelAlgoOrder) {
        const stale = await this.backend.listAlgoOrders(symbol);
        if (stale === null) step('清旧条件单', true, '查询不确定,继续(若残留会在挂止损时暴露)');
        else if (stale.length === 0) step('清旧条件单', true, '无');
        else {
          const failed: string[] = [];
          for (const o of stale) {
            const c = await this.backend.cancelAlgoOrder(symbol, o.client_algo_id);
            if (!c.ok) failed.push(`${o.client_algo_id}:${c.error ?? '?'}`);
          }
          step('清旧条件单', failed.length === 0, failed.length === 0 ? `撤了 ${stale.length} 张:${stale.map((o) => o.client_algo_id).join('、')}` : `撤不掉 ${failed.join('; ')}`);
          if (failed.length) throw new Error(`旧条件单撤不掉:${failed.join('; ')}`);
        }
      }
      const rules = await this.backend.symbolRules(symbol);
      const price = Number(await this.backend.markPrice(symbol));
      if (!(price > 0)) throw new Error(`${symbol} 拿不到标记价`);
      const stepSize = Number(rules.step_size) || 0.001;
      const minQty = Number(rules.min_qty) || stepSize;
      const minNotional = Number(rules.min_notional) || 5;
      const rawQty = Math.max(minQty, (minNotional * 1.05) / price);
      const qtyNum = Math.ceil(rawQty / stepSize - 1e-9) * stepSize;
      const decimals = Math.max(0, (rules.step_size.split('.')[1] ?? '').length);
      const qty = qtyNum.toFixed(decimals);
      const tick = Number(rules.tick_size) || 0.01;
      const tickDec = Math.max(0, (rules.tick_size.split('.')[1] ?? '').length);
      const direction: Direction = existing ? existing.side : 'long';
      const stopPrice = (direction === 'long' ? Math.floor((price * 0.95) / tick) * tick : Math.ceil((price * 1.05) / tick) * tick).toFixed(tickDec);
      step(
        '算最小仓',
        true,
        existing ? `沿用无主持仓 ${existing.qty},止损 ${stopPrice}(标记价 ${price} ${direction === 'long' ? '下' : '上'} 5%)` : `数量 ${qty}(≈ ${(qtyNum * price).toFixed(2)} USDT),止损 ${stopPrice}(标记价 ${price} 下 5%)`,
      );
      // 开仓 + 挂止损
      let stopReceiptOk = false;
      if (existing) {
        entered = true;
        step('市价开最小仓', true, '跳过:接管已有的无主持仓');
        const st = await this.backend.placeStop(symbol, direction, stopPrice, cidS);
        stopLive = st.outcome === 'submitted' || st.outcome === 'filled';
        step('挂 closePosition 止损', stopLive, stopLive ? `algo ${cidS}` : `${st.outcome} ${st.error ?? ''}`);
        if (!stopLive) throw new Error(`止损挂不上:${st.error ?? st.outcome}`);
      } else if (this.backend.openWithProtection) {
        const r = await this.backend.openWithProtection({ symbol, direction: 'long', qty, entry: 'market', limit_price: null, client_order_id: cidE, stop_price: stopPrice, stop_client_algo_id: cidS });
        entered = r.entry.outcome === 'filled' || r.entry.outcome === 'submitted' || r.entry.outcome === 'unknown';
        if (r.entry.outcome !== 'filled') throw new Error(`入场未成交:${r.entry.outcome} ${r.entry.error ?? ''}`);
        step('市价开最小仓', true, `成交 @ ${r.entry.avg_price ?? '?'}`);
        stopReceiptOk = r.stop.outcome === 'submitted';
        stopLive = stopReceiptOk;
        step('挂 closePosition 止损', stopReceiptOk, stopReceiptOk ? `algo ${r.stop.algo_id ?? cidS}` : `${r.stop.outcome} ${r.stop.error ?? ''}`);
        if (!stopReceiptOk) throw new Error(`止损挂不上:${r.stop.error ?? r.stop.outcome}`);
      } else {
        const e = await this.backend.placeEntry({ symbol, direction: 'long', qty, entry: 'market', limit_price: null, client_order_id: cidE });
        entered = e.outcome !== 'failed';
        if (e.outcome !== 'filled') throw new Error(`入场未成交:${e.outcome} ${e.error ?? ''}`);
        step('市价开最小仓', true, `成交 @ ${e.avg_price ?? '?'}`);
        const st = await this.backend.placeStop(symbol, 'long', stopPrice, cidS);
        stopLive = st.outcome === 'submitted' || st.outcome === 'filled';
        step('挂 closePosition 止损', stopLive, stopLive ? '已提交' : `${st.outcome} ${st.error ?? ''}`);
        if (!stopLive) throw new Error(`止损挂不上:${st.error ?? st.outcome}`);
      }
      // 确认挂着
      if (this.backend.algoOrderExists) {
        const seen = await this.backend.algoOrderExists(symbol, cidS);
        step('交易所确认止损挂着', seen === true, seen === true ? '查到' : seen === null ? '查询不确定' : '查不到');
        if (seen !== true) throw new Error(seen === null ? '止损单查询不确定' : '止损单在交易所查不到');
      } else step('交易所确认止损挂着', true, '此通道无条件单查询,以回执为准');
      // 撤止损
      const c = this.backend.cancelAlgoOrder ? await this.backend.cancelAlgoOrder(symbol, cidS) : await this.backend.cancelOrder(symbol, cidS);
      step('撤止损', c.ok, c.ok ? 'ok' : c.error ?? '');
      if (!c.ok) throw new Error(`撤止损失败:${c.error}`);
      stopLive = false;
      // 到这里要证明的事已经证明了(止损挂上、交易所查到、撤得掉)——记录立刻落库。
      // 09-06 第二次金丝雀:前四步全过,收尾平仓子代理回「不确定」,善后又平掉了,却把整次判成失败,
      // 闸门继续挡 agent。收尾不是验证对象:平仓/确认 flat 出问题只发告警,不撤销结论。
      this.store.kvSet(this.protectionKey(), JSON.stringify({ at: Date.now(), symbol, qty: existing ? existing.qty : qty, algo_id: cidS, adopted: existing !== null }));
      this.protectionRun.last_error = null;
      // 平仓 + 确认 flat(收尾)
      let tidy = true;
      try {
        const cl = await this.backend.closePosition(symbol, cidC);
        step('平仓', cl.closed, cl.closed ? 'ok' : cl.error ?? '');
        if (cl.closed) entered = false;
        const after = await this.backend.account();
        const flat = !after.positions.some((p) => p.symbol === symbol);
        step('确认已平', flat, flat ? `${symbol} 无持仓` : `${symbol} 仍有持仓,请人工看`);
        if (flat) entered = false;
        tidy = cl.closed && flat;
      } catch (e2) {
        tidy = false;
        step('平仓', false, (e2 as Error).message);
      }
      if (!tidy && entered) {
        try {
          const cl = await this.backend.closePosition(symbol, cidC);
          step('善后平仓', cl.closed, cl.closed ? 'ok' : `${cl.error ?? ''};请人工检查 ${symbol} 持仓`);
          if (cl.closed) entered = false;
        } catch (e3) {
          step('善后平仓', false, `${(e3 as Error).message};请人工检查 ${symbol} 持仓`);
        }
      }
      if (!tidy) this.activity('chat_action', { symbol, level: 'warn', title: `止损验证通过,但收尾平仓没确认(${symbol}),去持仓看一眼`, detail: steps.map((x) => `${x.name} ${x.ok ? '✓' : '✗'}`).join(' · ') });
      this.log('warn', 'exec', `保护腿验证通过(${symbol} ${qty}),${this.backend.kind} 通道放行新增开仓`);
      this.activity('chat_action', { symbol, level: 'success', title: `止损验证通过,${this.backend.kind} 通道已放行新增开仓`, detail: steps.map((x) => `${x.name} ✓`).join(' · ') });
    } catch (e) {
      failure = (e as Error).message;
      // 尽力收拾:撤止损、平仓
      if (stopLive) {
        try {
          const c = this.backend.cancelAlgoOrder ? await this.backend.cancelAlgoOrder(symbol, cidS) : await this.backend.cancelOrder(symbol, cidS);
          step('善后撤止损', c.ok, c.ok ? 'ok' : c.error ?? '');
        } catch (e2) {
          step('善后撤止损', false, (e2 as Error).message);
        }
      }
      if (entered) {
        try {
          const cl = await this.backend.closePosition(symbol, cidC);
          step('善后平仓', cl.closed, cl.closed ? 'ok' : `${cl.error ?? ''};请人工检查 ${symbol} 持仓`);
        } catch (e2) {
          step('善后平仓', false, `${(e2 as Error).message};请人工检查 ${symbol} 持仓`);
        }
      }
      this.protectionRun.last_error = failure;
      this.log('error', 'exec', `保护腿验证失败:${failure}`);
      this.activity('chat_action', { symbol, level: 'danger', title: `止损验证失败:${failure}`, detail: steps.map((x) => `${x.name} ${x.ok ? '✓' : '✗'}`).join(' · ') });
    } finally {
      this.protectionRun.running = false;
      this.emit('execution.changed', this.executionView());
      try {
        this.account = await this.backend.account();
      } catch {
        /* 下一轮巡检会补 */
      }
    }
    return this.protectionStatus();
  }

  private netCheckRunning = false;
  /** 09-07:网络自检,委托给后端;同一时间只跑一个。null = 后端不支持。 */
  async netCheck(n: number): Promise<NetCheckResult | null> {
    if (!this.backend.netCheck) return null;
    if (this.netCheckRunning) throw Object.assign(new Error('网络自检正在跑,别重复点'), { status: 409 });
    this.netCheckRunning = true;
    try {
      const r = await this.backend.netCheck(n);
      this.log(r.transport_errors ? 'warn' : 'info', 'exec', `网络自检:${r.verdict}`);
      this.activity('chat_action', { level: r.transport_errors ? 'warn' : 'info', title: `网络自检:${r.ok}/${r.runs.length} 通`, detail: r.verdict });
      this.emit('execution.changed', this.executionView());
      return r;
    } finally {
      this.netCheckRunning = false;
    }
  }

  /** Probes the agent CLI's MCP session (cached {@link CONN_PROBE_TTL_MS}); emits `execution.changed` on a change. */
  async checkExecutionConnection(force = false): Promise<ExecutionView> {
    const fresh = this.conn.checked_at !== null && Date.now() - this.conn.checked_at < CONN_PROBE_TTL_MS;
    if (!force && fresh) return this.executionView();
    const before = this.conn.status;
    try {
      this.conn = await probeMcpConnection(this.workflow.exec_agent_cli, undefined, undefined, undefined, this.cliCommandFor(this.workflow.exec_agent_cli));
    } catch (e) {
      this.conn = { status: 'unknown', checked_at: Date.now(), detail: `检测失败:${(e as Error).message}` };
    }
    const view = this.executionView();
    if (this.conn.status !== before) {
      this.log('info', 'exec', `币安 MCP 连接状态:${before} → ${this.conn.status}(${this.conn.detail.slice(0, 120)})`);
      this.emit('execution.changed', view);
    }
    return view;
  }

  /** null = a backend switch is allowed right now; otherwise the reason it is refused. */
  switchBlocker(): string | null {
    const open = this.openThreads();
    if (open.length) return `还有 ${open.length} 个进行中的线程(${open.map((t) => t.symbol).join('、')}),先平掉/撤单再换执行后端`;
    if (this.store.intents(50).some((i) => i.status === 'unknown')) return '有一笔订单状态不明,先核对清楚再换执行后端';
    return null;
  }

  /**
   * Swaps the execution backend at runtime. Returns null on success, or the reason it was refused —
   * positions and orders do NOT travel between backends, so this is only allowed with a clean book.
   */
  async switchBackend(kind: Backend): Promise<string | null> {
    if (this.switching) return '正在切换执行后端,稍后再试';
    if (kind === this.backend.kind) return null;
    const factory = this.backendFactories[kind];
    if (!factory) return `执行后端 ${kind} 在这个进程里没注册(缺二进制或缺配置)`;
    const blocker = this.switchBlocker();
    if (blocker) return blocker;
    this.switching = this.switchBackendInner(kind, factory);
    try {
      return await this.switching;
    } finally {
      this.switching = null;
    }
  }

  private async switchBackendInner(kind: Backend, factory: () => ExecBackend): Promise<string | null> {
    let next: ExecBackend;
    try {
      next = factory();
    } catch (e) {
      return `构造 ${kind} 失败:${(e as Error).message}`;
    }
    try {
      await next.start();
    } catch (e) {
      await next.stop().catch(() => undefined);
      return `${kind} 启动失败:${(e as Error).message}`;
    }
    const old = this.backend;
    this.backend = next;
    try {
      await old.stop();
    } catch (e) {
      this.log('warn', 'exec', `旧后端 ${old.kind} 停止时报错(已切换):${(e as Error).message}`);
    }
    this.setWorkflow({ execution: kind });
    this.log('warn', 'exec', `执行后端已切换:${old.kind} → ${kind}`);
    this.activity('execution_changed', { level: 'warn', title: `执行后端已切换为${BACKEND_LABELS[kind]}`, detail: BACKEND_NOTES[kind], data: { from: old.kind, to: kind } });
    await this.pollAccount();
    this.emitLoop();
    this.emit('execution.changed', this.executionView());
    return null;
  }

  /**
   * The async front door for the settings form: `execution` is applied by switching the backend first
   * (a refused switch leaves the field untouched and reports the reason), everything else by setWorkflow.
   */
  async applyWorkflow(patch: Record<string, unknown>): Promise<{ workflow: Workflow; errors: string[] }> {
    const errors: string[] = [];
    let rest = patch;
    if ('execution' in patch && patch['execution'] !== this.backend.kind) {
      const want = patch['execution'];
      if (typeof want !== 'string' || !BACKENDS.includes(want as Backend)) errors.push(`execution 只能是 ${BACKENDS.join('/')}`);
      else {
        const err = await this.switchBackend(want as Backend);
        if (err) errors.push(err);
      }
      rest = { ...patch };
      delete rest['execution'];
    }
    const r = this.setWorkflow(rest);
    return { workflow: r.workflow, errors: [...errors, ...r.errors] };
  }

  // ------------------------------------------------------------ daily judgment cap (v3.3, §9.7)

  /** Episodes recorded since local midnight (scans + reviews); the cap counts these. */
  judgmentsToday(): number {
    return this.store.episodeCountSince(localDayStart(Date.now()));
  }

  /**
   * true = today's judgment budget is spent, so the caller must NOT call a model. Logs + posts one
   * activity per {@link CAP_NOTICE_MS}, however many triggers get skipped in between.
   */
  private capReached(what: string): boolean {
    const cap = this.workflow.daily_judgment_cap;
    if (!cap || cap <= 0) return false;
    const used = this.judgmentsToday();
    if (used < cap) return false;
    const now = Date.now();
    if (now - this.capNoticeAt >= CAP_NOTICE_MS) {
      this.capNoticeAt = now;
      this.log('warn', 'cap', `今日判断已达上限 ${cap} 次(已用 ${used}),跳过${what};要继续就在设置里调高「每日判断上限」(0 = 不限)`);
      this.activity('cap_reached', { level: 'warn', title: `今日判断已达上限 ${cap} 次,后续判断已跳过`, detail: `已用 ${used} 次(本地日历日)。设置里调高 daily_judgment_cap 或设 0 表示不限;你在对话里问问题不受此限制。`, data: { cap, used } });
    }
    return true;
  }

  /** Today's model spend for the overview card. */
  usageToday(): UsageToday {
    const rows = this.store.episodeUsageSince(localDayStart(Date.now()));
    const judgments = rows.reduce((a, r) => a + r.count, 0);
    const cap = this.workflow.daily_judgment_cap;
    return {
      judgments,
      input_tokens: rows.reduce((a, r) => a + r.input_tokens, 0),
      output_tokens: rows.reduce((a, r) => a + r.output_tokens, 0),
      est_cny: estimateCny(rows),
      cap,
      capped: cap > 0 && judgments >= cap,
    };
  }

  // ------------------------------------------------------------ lifecycle

  async start(opts: { runOnStart?: boolean } = {}): Promise<void> {
    await this.backend.start();
    this.log('info', 'runtime', `启动:观察 ${this.workflow.watchlist.join('/')} ${this.workflow.timeframe},执行后端 ${BACKEND_LABELS[this.backend.kind]},大脑 ${this.mainBrain().name}`);
    await this.pollMarkets();
    await this.pollAccount();
    this.pollers.push(setInterval(() => void this.pollMarkets(), this.marketPollMs));
    this.pollers.push(setInterval(() => void this.pollAccount(), this.accountPollMs));
    this.scheduleKline();
    this.scheduleInfo();
    this.radar.start();
    this.lastEpisodeId = this.store.lastEpisode()?.id ?? null;
    this.emitLoop();
    if (opts.runOnStart) {
      const stale = !this.marketState || Date.now() - this.marketState.as_of > this.workflow.info_every_ms;
      // paused = no model calls at all, including the start-up information-officer run (scanAll checks it itself).
      if (stale && !this.workflow.paused) this.runInfoNow('启动');
      else if (stale) this.log('info', 'runtime', '已暂停:启动时不跑信息员');
      this.scanAll({ kind: 'manual', detail: '启动时的首次扫描' });
    }
  }

  async stop(): Promise<void> {
    for (const p of this.pollers) clearInterval(p);
    if (this.klineTimer) clearTimeout(this.klineTimer);
    if (this.infoTimer) clearTimeout(this.infoTimer);
    this.radar.stop();
    await this.backend.stop();
  }

  private scheduleKline(): void {
    if (this.klineTimer) clearTimeout(this.klineTimer);
    const at = nextCloseAfter(Date.now(), this.workflow.timeframe);
    this.nextAt = at;
    this.klineTimer = setTimeout(() => {
      void this.onKlineClose(at).finally(() => this.scheduleKline());
    }, Math.max(1000, at - Date.now()));
    this.emitLoop();
  }

  /**
   * Kline close on the workflow timeframe. v3: code decides who gets a model call —
   *   every_close mode: every watchlist symbol (the demo cadence);
   *   triggered mode: only symbols whose trigger fired, or whose heartbeat is due.
   * Open threads are reviewed on every close only when review_every_close is on; otherwise on a
   * trigger, on price nearing stop/TP, or on heartbeat (fills / SL / TP / info flips are event-driven elsewhere).
   */
  async onKlineClose(at: number): Promise<void> {
    const closed = new Date(at - 5000).toISOString().slice(11, 16);
    const detail = `${this.workflow.timeframe} K 线 ${closed} UTC 收盘`;
    const session = sessionInfo(Date.now());
    const prevSession = this.prevSessionName;
    this.prevSessionName = session.name;
    const open = this.openThreads();
    const needFeatures = this.workflow.scan_mode === 'triggered' || !this.workflow.review_every_close;
    const hitsBySymbol = new Map<string, TriggerHit[]>();
    if (needFeatures) {
      const symbols = new Set<string>([...this.workflow.watchlist, ...open.map((t) => t.symbol)]);
      await Promise.all(
        [...symbols].map(async (sym) => {
          try {
            const [kTf, k1h] = await Promise.all([fetchKlines(sym, this.workflow.timeframe, 60), fetchKlines(sym, '1h', 120)]);
            const f = tfFeatures(this.workflow.timeframe, kTf);
            const h1 = tfFeatures('1h', k1h);
            const prev = this.lastFeatures.get(sym) ?? null;
            const prevSame = prev && prev.tf === f.tf && prev.last_open_time !== f.last_open_time ? prev : null;
            this.lastFeatures.set(sym, f);
            this.lastH1.set(sym, h1);
            hitsBySymbol.set(sym, detectTriggers({ symbol: sym, now_tf: f, prev_tf: prevSame, h1, market: this.markets.get(sym) ?? null, session, fast_move_pct: null, fast_move_threshold_pct: Number(this.workflow.fast_move_pct), prev_session: prevSession }));
          } catch (e) {
            this.log('warn', 'trigger', `${sym} 触发器特征拉取失败:${(e as Error).message}`);
          }
        }),
      );
    }
    for (const t of open) {
      const hits = hitsBySymbol.get(t.symbol) ?? [];
      const heartbeatDue = Date.now() - (this.lastModelCallAt.get(t.symbol) ?? 0) >= this.workflow.heartbeat_every_ms;
      const f = this.lastFeatures.get(t.symbol);
      const mark = Number(this.markets.get(t.symbol)?.mark ?? 0);
      const near = t.status === 'in_position' && f && mark > 0 ? this.nearProtection(t, mark, f.atr14) : null;
      if (hits[0]) this.lastTriggerHits.set(t.symbol, hits);
      if (this.workflow.review_every_close) this.reviewThread(t.id, { kind: 'kline_close', detail });
      else if (hits[0]) this.reviewThread(t.id, { kind: hits[0].kind, detail: `${hits[0].detail}(${detail})` });
      else if (near) this.reviewThread(t.id, { kind: 'position_review', detail: `${near}(${detail})` });
      else if (heartbeatDue) this.reviewThread(t.id, { kind: 'heartbeat', detail: `心跳复查(${detail})` });
    }
    if (this.workflow.paused || this.halted) return;
    if (this.workflow.scan_mode === 'every_close') {
      this.scanAll({ kind: 'kline_close', detail });
      return;
    }
    for (const sym of this.workflow.watchlist) {
      if (open.some((t) => t.symbol === sym)) continue;
      const hits = hitsBySymbol.get(sym) ?? [];
      const heartbeatDue = Date.now() - (this.lastModelCallAt.get(sym) ?? 0) >= this.workflow.heartbeat_every_ms;
      const f = this.lastFeatures.get(sym);
      const fp = f ? heartbeatFingerprint({ tf: f, h1: this.lastH1.get(sym) ?? null, market_state_id: this.marketState?.id ?? null, session: session.name, regime: this.regimeCache.get(sym)?.regime?.regime ?? null }) : null;
      if (hits[0]) {
        this.lastTriggerHits.set(sym, hits);
        this.activity('trigger', { symbol: sym, title: `${sym} 触发:${TRIGGER_LABEL[hits[0].kind] ?? hits[0].kind}`, detail: hits.map((h) => h.detail).join(';'), data: { hits } });
        if (fp) this.lastAskFingerprint.set(sym, fp);
        this.scan(sym, { kind: hits[0].kind, detail: `${hits[0].detail}(${detail})` });
      } else if (heartbeatDue) {
        // Heartbeat de-dup: the 2026-09-04 ledger showed 88% of judgments were routine asks that changed
        // nothing. Same coarse fingerprint as the last model call → nothing new to judge, spend zero tokens.
        if (fp && this.lastAskFingerprint.get(sym) === fp) {
          const n = (this.heartbeatSkipped.get(sym) ?? 0) + 1;
          this.heartbeatSkipped.set(sym, n);
          this.log('info', 'scan', `${sym} 心跳跳过(第 ${n} 次):结构/状态指纹与上次判断相同,不调模型`, { fingerprint: fp });
          if (n === 1 || n % 8 === 0) this.activity('heartbeat_skipped', { symbol: sym, title: `${sym} 心跳跳过 ×${n}`, detail: '15m/1h 结构、ATR 档、量能档、市场状态、时段都没变,省下一次模型调用', data: { fingerprint: fp } });
          continue;
        }
        if (fp) this.lastAskFingerprint.set(sym, fp);
        this.heartbeatSkipped.delete(sym);
        this.scan(sym, { kind: 'heartbeat', detail: `心跳扫描(${detail};${Math.round(this.workflow.heartbeat_every_ms / 60_000)} 分钟没问过模型)` });
      }
    }
  }

  /** Text when the mark is within 0.3 ATR of the stop or the first TP (worth a look before the exchange decides). */
  private nearProtection(t: StrategyThread, mark: number, atr: number): string | null {
    const band = Math.max(atr * 0.3, mark * 0.0005);
    const stop = t.stop_price ? Number(t.stop_price) : null;
    const tp = t.take_profits[0] ? Number(t.take_profits[0]) : null;
    if (stop !== null && Math.abs(mark - stop) <= band) return `价格 ${mark} 逼近止损 ${stop}`;
    if (tp !== null && Math.abs(mark - tp) <= band) return `价格 ${mark} 逼近止盈 ${tp}`;
    return null;
  }

  /** Sudden move seen by the 10-second market poll: wake the agent now instead of at the next close. */
  private onFastMove(symbol: string, movePct: number): void {
    if (this.workflow.paused || this.halted) return;
    const last = this.fastMoveFiredAt.get(symbol) ?? 0;
    if (Date.now() - last < FAST_MOVE_COOLDOWN_MS) return;
    this.fastMoveFiredAt.set(symbol, Date.now());
    const hit: TriggerHit = { kind: 'fast_move', detail: `5 分钟内 ${movePct >= 0 ? '急拉' : '急跌'} ${Math.abs(movePct).toFixed(2)}%(阈值 ${Number(this.workflow.fast_move_pct).toFixed(1)}%)`, score: 1 };
    this.lastTriggerHits.set(symbol, [hit]);
    this.activity('trigger', { symbol, level: 'warn', title: `${symbol} ${movePct >= 0 ? '急拉' : '急跌'} ${Math.abs(movePct).toFixed(2)}%`, detail: hit.detail, data: { move_pct: movePct } });
    this.narrate(`${symbol} ${hit.detail},我现在就去看。`);
    const t = this.openThreads().find((x) => x.symbol === symbol);
    if (t) this.reviewThread(t.id, { kind: 'fast_move', detail: hit.detail });
    else if (this.workflow.watchlist.includes(symbol)) this.scan(symbol, { kind: 'fast_move', detail: hit.detail });
  }

  /** Funding history for the z-score, cached an hour (settlements are 8-hourly; a miss costs the evidence line). */
  private async fundingHistoryFor(symbol: string): Promise<{ at: number; rate: string }[] | undefined> {
    const cached = this.fundingHistory.get(symbol);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.rows;
    try {
      const rows = await fetchFundingRateHistory(symbol, 120);
      this.fundingHistory.set(symbol, { at: Date.now(), rows });
      return rows;
    } catch {
      return cached?.rows;
    }
  }

  private async dailyRegimeFor(symbol: string): Promise<DailyRegime | null> {
    const c = this.regimeCache.get(symbol);
    if (c && Date.now() - c.at < REGIME_TTL_MS) return c.regime;
    try {
      const regime = dailyRegime(await fetchKlines(symbol, '1d', 220));
      this.regimeCache.set(symbol, { at: Date.now(), regime });
      return regime;
    } catch (e) {
      this.log('warn', 'market', `${symbol} 日线拉取失败:${(e as Error).message}`);
      return c?.regime ?? null;
    }
  }

  /** GET /api/market/regime */
  async regime(symbol: string): Promise<RegimeView> {
    return { symbol, as_of: Date.now(), daily: await this.dailyRegimeFor(symbol), session: sessionInfo(Date.now()) };
  }

  private scheduleInfo(): void {
    if (this.infoTimer) clearTimeout(this.infoTimer);
    const last = this.marketState?.as_of ?? 0;
    const due = Math.max(Date.now() + 5000, last + this.workflow.info_every_ms);
    this.infoTimer = setTimeout(() => {
      // The job reschedules on completion (see runInfoNow); only reschedule here when it did not run.
      if (this.workflow.paused || !this.runInfoNow('定时')) {
        this.infoTimer = setTimeout(() => this.scheduleInfo(), this.workflow.info_every_ms);
      }
    }, due - Date.now());
  }

  // ------------------------------------------------------------ polling & reconciliation

  private async pollMarkets(): Promise<void> {
    if (this.marketPolling) return;
    this.marketPolling = true;
    try {
      await this.pollMarketsInner();
    } finally {
      this.marketPolling = false;
    }
  }
  private async pollMarketsInner(): Promise<void> {
    const symbols = new Set<string>([...this.workflow.watchlist, ...this.openThreads().map((t) => t.symbol), ...(this.account?.positions.map((p) => p.symbol) ?? [])]);
    await Promise.all(
      [...symbols].map(async (sym) => {
        try {
          const mv = await fetchMarketView(sym, this.workflow.timeframe);
          this.markets.set(sym, mv);
          const events = this.backend.tick(sym, mv.mark);
          if (events.length) this.pendingPaperEvents.push(...events);
          this.emit('market.tick', mv);
          const hist = this.markHistory.get(sym) ?? [];
          hist.push({ at: mv.as_of, mark: Number(mv.mark) });
          while (hist.length && mv.as_of - hist[0]!.at > 3 * FAST_MOVE_WINDOW_MS) hist.shift();
          this.markHistory.set(sym, hist);
          const move = windowMovePct(hist, mv.as_of, FAST_MOVE_WINDOW_MS);
          if (move !== null && Math.abs(move) >= Number(this.workflow.fast_move_pct)) this.onFastMove(sym, move);
        } catch (e) {
          this.log('warn', 'market', `${sym} 行情拉取失败:${(e as Error).message}`);
        }
      }),
    );
    if (this.pendingPaperEvents.length) await this.pollAccount();
  }

  private pollAccount(): Promise<void> {
    // Single-flight: concurrent callers share the in-progress pass instead of racing reconcileThreads.
    if (this.accountPolling) return this.accountPolling;
    this.accountPolling = this.pollAccountInner().finally(() => {
      this.accountPolling = null;
    });
    return this.accountPolling;
  }
  private async pollAccountInner(): Promise<void> {
    try {
      const acct = await this.backend.account();
      this.account = acct;
      if (this.accountReadError) {
        this.accountReadError = null;
        this.emit('execution.changed', this.executionView());
      }
      this.emit('account.updated', acct);
      this.trackDailyEquity(acct);
      this.recordEquity(acct, false);
      await this.reconcileThreads(acct);
      this.detectExternal(acct);
    } catch (e) {
      const msg = (e as Error).message;
      this.log('warn', 'account', `账户拉取失败:${msg}`);
      const first = this.accountReadError === null;
      this.accountReadError = { at: Date.now(), message: msg.slice(0, 300) };
      if (first) this.emit('execution.changed', this.executionView());
    }
  }

  /** 日起始权益按执行通道分开记(paper 1 万和 agent_mcp 45 混在一起会算出「日亏 99%」)。 */
  private dayStartKey(): string {
    return `demo.day_start_equity:${this.backend.kind}`;
  }
  private trackDailyEquity(acct: AccountView): void {
    const day = String(utcDayStart(Date.now()));
    const dayKey = `demo.day:${this.backend.kind}`;
    if (this.store.kvGet(dayKey) !== day || this.store.kvGet(this.dayStartKey()) === null) {
      this.store.kvSet(dayKey, day);
      this.store.kvSet(this.dayStartKey(), acct.equity);
      return;
    }
    // 划转不是盈亏:没有持仓、没有挂单、今天本通道没有平仓,而权益相对日起点变了 ≥ 20% → 当作入金/出金,日起点跟着重置。
    const start = Number(this.store.kvGet(this.dayStartKey()));
    const eq = Number(acct.equity);
    if (start > 0 && eq > 0 && acct.positions.length === 0 && acct.open_orders.length === 0 && Math.abs(eq - start) / start >= 0.2) {
      const closedToday = this.store.closedThreads(20, this.backend.kind).some((t) => (t.closed_at ?? 0) >= utcDayStart(Date.now()));
      if (!closedToday) {
        this.store.kvSet(this.dayStartKey(), acct.equity);
        this.log('info', 'account', `权益 ${start} → ${eq} 且无持仓无交易,按划转处理,日起始权益重置为 ${eq}`);
      }
    }
  }
  /** Equity curve points (design notes): at most one a minute, plus one on every thread close. */
  private recordEquity(acct: AccountView, force: boolean): void {
    const now = Date.now();
    if (!force && now - this.store.lastEquityAt(this.backend.kind) < EQUITY_POINT_MS) return;
    const equity = Number(acct.equity);
    if (!Number.isFinite(equity)) return;
    this.store.saveEquity({ at: now, equity, unrealized: Number(acct.unrealized_pnl) || 0, backend: this.backend.kind });
  }
  dailyLossPct(): number {
    if (!this.account || this.account.backend !== this.backend.kind) return 0;
    const start = Number(this.store.kvGet(this.dayStartKey()) ?? this.account.equity);
    if (!(start > 0) || !this.account) return 0;
    return ((start - Number(this.account.equity)) / start) * 100;
  }
  dailyLossHit(): boolean {
    return this.dailyLossPct() >= Number(this.workflow.daily_loss_stop_pct);
  }

  private async reconcileThreads(acct: AccountView): Promise<void> {
    const paperEvents = this.pendingPaperEvents.splice(0);
    for (const ev of paperEvents) this.log(ev.kind === 'entry_filled' ? 'info' : 'warn', 'paper', `${ev.symbol}: ${ev.message}`);
    for (const t of this.openThreads()) {
      const position = acct.positions.find((p) => p.symbol === t.symbol) ?? null;
      const openOrders = acct.open_orders.filter((o) => o.symbol === t.symbol);
      if (this.halted) {
        // Halted: the only allowed work is finishing the halt (cancel + flatten); never place protection.
        if (t.attention === 'HALT_INCOMPLETE' || position || openOrders.length) await this.retryHalt(t, position !== null);
        continue;
      }
      if (t.attention === 'ENTRY_REMAINDER' && t.entry_client_order_id) {
        // Partial fill: keep trying to cancel the remainder until it is provably terminal.
        const rem = await this.backend.getOrder(t.symbol, t.entry_client_order_id).catch(() => null);
        const live = rem !== null && !['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(rem.status);
        if (live) {
          const c = await this.backend.cancelOrder(t.symbol, t.entry_client_order_id);
          this.log(c.ok ? 'info' : 'warn', 'exec', `${t.symbol} 重试撤余量:${c.ok ? '成功' : c.error}`, { thread_id: t.id });
          if (!c.ok) continue;
        }
        const cur = this.store.thread(t.id);
        if (cur && cur.attention === 'ENTRY_REMAINDER') {
          if (rem && rem.status === 'FILLED' && Number(rem.executed_qty) > 0) cur.qty = rem.executed_qty;
          this.saveThread({ ...cur, attention: null, version: cur.version + 1, updated_at: Date.now() });
          this.log('info', 'thread', `${t.symbol} 余量已终态,保护覆盖按已成交量 ${cur.qty}`, { thread_id: t.id });
        }
        continue;
      }
      let entryOrder: Awaited<ReturnType<ExecBackend['getOrder']>> | 'unqueried' = 'unqueried';
      if (t.status === 'pending_entry' && t.entry_client_order_id && typeof t.entry_submitting_since === 'number' && Date.now() - t.entry_submitting_since < SUBMIT_PHASE_MAX_MS) {
        // Entry call still in flight (CID minted, request maybe not at the exchange yet): don't query, don't judge.
        continue;
      }
      if (t.status === 'pending_entry' && t.entry_client_order_id) {
        try {
          entryOrder = await this.backend.getOrder(t.symbol, t.entry_client_order_id);
        } catch (e) {
          this.log('warn', 'reconcile', `${t.symbol} 入场单查询失败:${(e as Error).message}`);
          continue;
        }
      }
      const paperClose = paperEvents.find((e) => e.symbol === t.symbol && (e.kind === 'sl_hit' || e.kind === 'tp_hit'));
      const r = reconcileThread(t, { now: Date.now(), position, entry_order: entryOrder, open_orders: openOrders, mark: this.markets.get(t.symbol)?.mark ?? null });
      if (!r.changed) continue;
      const next = r.next;
      if (next.status === 'closed' && paperClose) {
        next.close_reason = paperClose.kind === 'sl_hit' ? `止损触发 @ ${paperClose.price}` : `止盈触发 @ ${paperClose.price}`;
        next.realized_pnl = paperClose.realized_pnl;
        next.exit_price = paperClose.price;
      }
      this.saveThread(next);
      for (const e of r.events) {
        this.log(e.kind === 'attention' ? 'warn' : 'info', 'thread', `${next.symbol} ${next.side === 'long' ? '多' : '空'}:${e.message}`, { thread_id: next.id });
        if (e.kind === 'entry_filled' || e.kind === 'closed' || e.kind === 'canceled') this.narrate(`${next.symbol} ${next.side === 'long' ? '多' : '空'}:${e.message}${e.kind === 'closed' && next.realized_pnl ? `,盈亏 ${next.realized_pnl} USDT` : ''}`);
        this.activityForThreadEvent(next, e.kind, e.message, paperClose?.kind ?? null);
      }
      if (next.status === 'closed' || next.status === 'canceled') this.recordEquity(acct, true);
      if (r.events.some((e) => e.kind === 'attention_cleared' || e.kind === 'entry_filled') && entryOrder !== 'unqueried') this.resolveUnknownIntents(next, entryOrder);
      if (r.events.some((e) => e.kind === 'entry_filled')) {
        if (next.attention === 'ENTRY_REMAINDER' && next.entry_client_order_id) {
          const c = await this.backend.cancelOrder(next.symbol, next.entry_client_order_id);
          this.log(c.ok ? 'info' : 'warn', 'exec', `${next.symbol} 部分成交,${c.ok ? '已撤余量' : `撤余量失败:${c.error}`}`, { thread_id: next.id });
          if (c.ok) this.saveThread({ ...next, attention: null, version: next.version + 1, updated_at: Date.now() });
        }
        await this.placeProtection(next, '入场成交后');
        this.reviewThread(next.id, { kind: 'order_filled', detail: `入场成交 @ ${next.filled_avg_price}` });
      }
      if (next.status === 'closed') {
        const c = await this.backend.cancelAll(next.symbol);
        if (!c.ok) this.log('warn', 'exec', `${next.symbol} 撤剩余挂单失败:${c.error}`);
        this.resolveOpenIntents(next, 'filled');
      }
      if (next.status === 'canceled') this.resolveOpenIntents(next, 'failed');
      if (next.attention === 'PROTECTION_MISSING') await this.placeProtection(next, '巡检发现止损缺失');
    }
  }

  private activityForThreadEvent(t: StrategyThread, kind: string, message: string, paperKind: 'sl_hit' | 'tp_hit' | 'entry_filled' | null): void {
    const side = t.side === 'long' ? '做多' : '做空';
    const pnl = t.realized_pnl ? Number(t.realized_pnl) : null;
    const pnlText = pnl === null ? '' : `,盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`;
    const base = { symbol: t.symbol, thread_id: t.id, detail: message, data: { side: t.side, qty: t.qty, pnl: t.realized_pnl, close_reason: t.close_reason, exit_price: t.exit_price ?? null, filled_avg_price: t.filled_avg_price } };
    if (kind === 'entry_filled') this.activity('entry_filled', { ...base, level: 'success', title: `${t.symbol} ${side} 已成交${t.filled_avg_price ? ` @ ${t.filled_avg_price}` : ''}` });
    else if (kind === 'closed') {
      const reason = t.close_reason ?? '';
      // Only a proven SL/TP fill is labelled as such; "position gone on the exchange side" stays a plain close.
      const k: ActivityKind = paperKind === 'sl_hit' || reason.startsWith('止损触发') ? 'sl_hit' : paperKind === 'tp_hit' || reason.startsWith('止盈触发') ? 'tp_hit' : 'thread_closed';
      const label = k === 'sl_hit' ? '止损离场' : k === 'tp_hit' ? '止盈离场' : '已平仓';
      const level: ActivityItem['level'] = pnl === null ? 'info' : pnl < 0 ? 'danger' : 'success';
      this.activity(k, { ...base, level, title: `${t.symbol} ${side} ${label}${pnlText}${reason && k === 'thread_closed' ? `:${reason.slice(0, 40)}` : ''}` });
    } else if (kind === 'canceled') this.activity('thread_canceled', { ...base, level: 'info', title: `${t.symbol} ${side} 挂单已撤${t.close_reason ? `:${t.close_reason}` : ''}` });
    else if (kind === 'attention') this.activity('attention', { ...base, level: 'danger', title: `${t.symbol} 需要你处理:${t.attention ?? ''}` });
    else if (kind === 'attention_cleared') this.activity('attention_cleared', { ...base, level: 'info', title: `${t.symbol} 异常已解除` });
  }

  /** The entry order was found again (or filled): thaw the intents that were parked as `unknown`. */
  private resolveUnknownIntents(t: StrategyThread, order: Awaited<ReturnType<ExecBackend['getOrder']>>): void {
    for (const i of this.store.intentsForThread(t.id)) {
      if (i.status !== 'unknown') continue;
      const status: DemoIntent['status'] = order === null ? 'unknown' : order.status === 'FILLED' ? 'filled' : ['CANCELED', 'EXPIRED', 'REJECTED'].includes(order.status) ? 'failed' : 'submitted';
      if (status !== 'unknown') this.updateIntent(null, i, { status, error: null });
    }
  }
  /** Thread reached a terminal state: no intent may stay pending/unknown for it. */
  private resolveOpenIntents(t: StrategyThread, fallback: DemoIntent['status']): void {
    for (const i of this.store.intentsForThread(t.id)) {
      if (i.status === 'pending_approval' || i.status === 'unknown' || i.status === 'approved') this.updateIntent(null, i, { status: i.status === 'pending_approval' ? 'rejected' : fallback, error: i.status === 'pending_approval' ? '线程已结束' : i.error });
      // ACK-only entry (agent_mcp 常见)后线程已结束:成交过就是 filled,否则按线程终态兜底,不能留在 submitted 占预留。
      else if (i.status === 'submitted' && i.kind === 'open') this.updateIntent(null, i, { status: t.filled_avg_price ? 'filled' : fallback, error: i.error });
    }
  }

  /** While halted, keep retrying cancel + flatten for a thread until the exchange is provably clean. */
  private async retryHalt(t: StrategyThread, hasPosition: boolean): Promise<void> {
    const c = await this.backend.cancelAll(t.symbol);
    let closed = !hasPosition;
    if (hasPosition) {
      const { cid, next } = nextLegCid(t, 'x');
      this.saveThread(next);
      const r = await this.backend.closePosition(t.symbol, cid);
      closed = r.closed && !r.error;
    }
    if (c.ok && closed) {
      const fresh = await this.backend.account();
      if (!fresh.positions.some((p) => p.symbol === t.symbol)) {
        this.saveThread({ ...(this.store.thread(t.id) ?? t), status: t.status === 'pending_entry' ? 'canceled' : 'closed', closed_at: Date.now(), close_reason: '紧急停止(重试后完成)', attention: null, version: (this.store.thread(t.id)?.version ?? t.version) + 1, updated_at: Date.now() });
        this.log('warn', 'exec', `${t.symbol} 紧急停止重试完成`, { thread_id: t.id });
        return;
      }
    }
    this.log('error', 'exec', `${t.symbol} 紧急停止重试未完成(撤单 ${c.ok ? 'ok' : c.error};平仓 ${closed ? 'ok' : '未确认'}),下轮再试`, { thread_id: t.id });
  }

  private detectExternal(acct: AccountView): void {
    const open = this.openThreads();
    const now = Date.now();
    const foreignPos = acct.positions.filter(
      (p) =>
        !open.some(
          (t) =>
            t.symbol === p.symbol &&
            (t.status === 'in_position' ||
              // pending attribution: our entry is in flight / just returned on this symbol+side
              (t.status === 'pending_entry' && t.side === p.side && ((typeof t.entry_submitting_since === 'number' && now - t.entry_submitting_since < SUBMIT_PHASE_MAX_MS) || (typeof t.entry_submitted_at === 'number' && now - t.entry_submitted_at < ATTRIBUTION_GRACE_MS)))),
        ),
    );
    if (foreignPos.length && Date.now() - this.externalWarnedAt > 10 * 60_000) {
      this.externalWarnedAt = Date.now();
      this.log('warn', 'reconcile', `账户上有不属于任何线程的持仓:${foreignPos.map((p) => `${p.symbol} ${p.side} ${p.qty}`).join(', ')}(不会自动碰它)`);
    }
  }

  private saveThread(t: StrategyThread): void {
    this.store.saveThread(t);
    this.emit('thread.changed', t);
  }

  /** Places the stop (mandatory) and TP legs for an in-position thread; on stop failure, flattens. */
  private async placeProtection(tIn: StrategyThread, why: string, placed?: { stop: { id: string; receipt: OrderReceipt }; tp?: { id: string; receipt: OrderReceipt } }): Promise<void> {
    if (tIn.status !== 'in_position' || this.halted) return;
    const last = this.protectionRetryAt.get(tIn.id) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.protectionRetryAt.set(tIn.id, Date.now());
    let t = this.store.thread(tIn.id) ?? tIn;
    const prefix = threadClientPrefix(t.id);
    const ids = t.protection_client_order_ids.filter((id) => id !== placed?.stop.id && id !== placed?.tp?.id);
    const stopPrice = t.stop_price;
    if (stopPrice) {
      const minted = placed ? { cid: placed.stop.id, next: t } : nextLegCid(t, 's');
      t = minted.next;
      this.saveThread(t);
      const stopId = minted.cid;
      let stop = placed?.stop.receipt ?? await this.backend.placeStop(t.symbol, t.side, stopPrice, stopId);
      if (isTransportError(stop.error)) stop = { ...stop, outcome: 'unknown' };
      if (stop.outcome === 'unknown') {
        // Algo orders are invisible to getOrder; null means the query itself is uncertain.
        let seen: boolean | null = null;
        try {
          if (this.backend.algoOrderExists) seen = await this.backend.algoOrderExists(t.symbol, stopId);
          else {
            const found = await this.backend.getOrder(t.symbol, stopId);
            if (found) seen = !['CANCELED', 'EXPIRED', 'REJECTED'].includes(found.status);
          }
        } catch {
          /* still uncertain */
        }
        if (seen === null) {
          this.saveThread({ ...t, attention: 'PROTECTION_MISSING', version: t.version + 1, updated_at: Date.now() });
          this.log('warn', 'exec', `${t.symbol} 止损 ${stopId} 回执及存在性查询不确定,保持持仓、不补偿平仓,等待巡检重试`, { thread_id: t.id });
          return;
        }
        if (seen) {
          stop = { ...stop, outcome: 'submitted', error: null };
          this.log('info', 'exec', `${t.symbol} 交易所确认止损 ${stopId} 已存在,按已提交处理`, { thread_id: t.id });
        } else {
          this.log('warn', 'exec', `${t.symbol} 交易所确认查不到止损 ${stopId},使用同一 client algo id 重发一次`, { thread_id: t.id });
          stop = await this.backend.placeStop(t.symbol, t.side, stopPrice, stopId);
          if (isTransportError(stop.error)) stop = { ...stop, outcome: 'unknown' };
          else if (stop.outcome === 'failed' && /duplicate.*(?:id|order)|(?:client.*id).*already exists|-4111\b/i.test(stop.error ?? '')) {
            stop = { ...stop, outcome: 'submitted', error: null };
            this.log('info', 'exec', `${t.symbol} 止损 ${stopId} 重发收到重复 ID 拒绝,确认首次已提交`, { thread_id: t.id });
          }
        }
      }
      // -4130 = 这个方向已经挂着一张 closePosition 止损(上一次回执丢了但其实成功了,或巡检用新 id 重挂撞上旧的):那是「有保护」的证据,不是失败。
      if (stop.outcome === 'failed' && /-4130\b/.test(stop.error ?? '')) {
        stop = { ...stop, outcome: 'submitted', error: null };
        this.log('info', 'exec', `${t.symbol} 交易所回 -4130:同向 closePosition 止损已存在,按已挂处理`, { thread_id: t.id });
      }
      if (stop.outcome === 'failed' || stop.outcome === 'unknown') {
        this.log('error', 'exec', `${t.symbol} 止损单${stop.outcome === 'unknown' ? '状态不明' : '失败'}(${stop.error}),${why},立刻补偿平仓`, { thread_id: t.id });
        if (stop.outcome === 'failed' && !isTransportError(stop.error) && /-\d{4}\b|rejected|invalid/i.test(stop.error ?? '') && !/-4509|-2022|no open position|ReduceOnly/i.test(stop.error ?? '')) this.invalidateProtection(`${t.symbol} 线上挂止损失败:${stop.error}`);
        const mx = nextLegCid(t, 'x');
        t = mx.next;
        this.saveThread(t);
        const c = await this.backend.closePosition(t.symbol, mx.cid);
        if (c.closed && !c.error) {
          this.saveThread({ ...t, status: 'closed', closed_at: Date.now(), close_reason: '止损单失败,补偿平仓', attention: null, version: t.version + 1, updated_at: Date.now() });
          this.resolveOpenIntents(t, 'filled');
          this.activity('thread_closed', { level: 'danger', symbol: t.symbol, thread_id: t.id, title: `${t.symbol} 止损单挂不上,已补偿平仓`, detail: stop.error });
        } else {
          // Do NOT close the thread: keep it under reconciliation until a human or the next pass resolves it.
          this.saveThread({ ...t, attention: 'CLOSE_FAILED', version: t.version + 1, updated_at: Date.now() });
          this.log('error', 'exec', `${t.symbol} 补偿平仓失败(${c.error}),线程保持巡检,请人工处理`, { thread_id: t.id });
        }
        return;
      }
      ids.push(stopId);
      this.log('info', 'exec', `${t.symbol} 止损单已挂 @ ${stopPrice}(${why})`, { thread_id: t.id });
      this.activity('protection_placed', { symbol: t.symbol, thread_id: t.id, title: `${t.symbol} 止损已挂 @ ${stopPrice}${t.take_profits[0] ? `,止盈 ${t.take_profits[0]}` : ''}`, detail: why, data: { stop: stopPrice, tp: t.take_profits[0] ?? null } });
    }
    const existingTp = ids.filter((x) => /-t\d+$/.test(x)).length;
    const tp0 = t.take_profits[0];
    if (tp0 && existingTp === 0) {
      const mt = placed?.tp ? { cid: placed.tp.id, next: t } : nextLegCid(t, 't');
      t = mt.next;
      this.saveThread(t);
      const tpId = mt.cid;
      const tp = placed?.tp?.receipt ?? await this.backend.placeTakeProfit(t.symbol, t.side, tp0, tpId);
      if (tp.outcome === 'failed' || tp.outcome === 'unknown') this.log('warn', 'exec', `${t.symbol} 止盈单失败(${tp.error}),只靠止损保护`, { thread_id: t.id });
      else {
        ids.push(tpId);
        this.log('info', 'exec', `${t.symbol} 止盈单已挂 @ ${tp0}`, { thread_id: t.id });
      }
    }
    const cur = this.store.thread(t.id) ?? t;
    const next: StrategyThread = { ...cur, protection_client_order_ids: ids, attention: cur.attention === 'ENTRY_REMAINDER' ? 'ENTRY_REMAINDER' : null, version: cur.version + 1, updated_at: Date.now() };
    this.saveThread(next);
    void prefix;
  }

  // ------------------------------------------------------------ controls

  /** Applies every valid field and reports the invalid ones (design notes); nothing changed → no events. */
  setWorkflow(patch: Record<string, unknown>): { workflow: Workflow; errors: string[] } {
    const { next, errors } = applyWorkflowPatch(this.workflow, patch);
    // Invariant: `execution` names the backend actually running. Changing it goes through
    // applyWorkflow()/switchBackend(), which flips the real backend first and only then lands here.
    if (next.execution !== this.backend.kind) next.execution = this.backend.kind;
    const changedKeys = (Object.keys(next) as (keyof Workflow)[]).filter((k) => k !== 'updated_at' && JSON.stringify(next[k]) !== JSON.stringify(this.workflow[k]));
    if (changedKeys.length === 0) return { workflow: this.workflow, errors };
    const tfChanged = next.timeframe !== this.workflow.timeframe;
    const infoChanged = next.info_every_ms !== this.workflow.info_every_ms;
    const pausedChanged = next.paused !== this.workflow.paused;
    this.workflow = next;
    this.store.saveWorkflow(next);
    this.emit('workflow.changed', next);
    if (tfChanged) this.scheduleKline();
    if (infoChanged) this.scheduleInfo();
    if (changedKeys.some((k) => String(k).startsWith('screener_') || k === 'paused')) this.radar.reschedule();
    if (pausedChanged) this.log('info', 'runtime', next.paused ? '已暂停:到点不再调模型,只采行情与对账' : '已恢复');
    this.log('info', 'runtime', `工作流已更新:${changedKeys.join(', ')}${errors.length ? `(未应用:${errors.join('; ')})` : ''}`);
    if (pausedChanged && changedKeys.length === 1) this.activity(next.paused ? 'paused' : 'resumed', { level: next.paused ? 'warn' : 'info', title: next.paused ? '已暂停:到点不再调模型' : '已恢复运行' });
    else this.activity('workflow_changed', { title: `工作流已更新:${changedKeys.join('、')}`, detail: errors.length ? `未应用:${errors.join('; ')}` : null, data: { keys: changedKeys } });
    this.emitLoop();
    return { workflow: next, errors };
  }

  pause(): void {
    this.setWorkflow({ paused: true });
  }
  resume(confirmHalt?: string): { ok: boolean; message: string } {
    if (this.halted) {
      if (confirmHalt !== 'RESUME') return { ok: false, message: '处于紧急停止,解除需要 confirm=RESUME' };
      this.halted = false;
      this.store.kvSet('demo.halted', '0');
      this.log('warn', 'runtime', '紧急停止已解除');
      this.activity('resume', { level: 'warn', title: '紧急停止已解除' });
    }
    this.setWorkflow({ paused: false });
    return { ok: true, message: 'resumed' };
  }
  async halt(): Promise<void> {
    this.halted = true;
    this.store.kvSet('demo.halted', '1');
    this.log('error', 'runtime', '紧急停止:撤单 + 市价平仓,之后拒绝一切开仓');
    this.activity('halt', { level: 'danger', title: '紧急停止:撤单 + 市价平仓,拒绝一切开仓' });
    this.emitLoop();
    const symbols = new Set<string>([...this.openThreads().map((t) => t.symbol), ...(this.account?.positions.map((p) => p.symbol) ?? [])]);
    const failed = new Set<string>();
    for (const sym of symbols) {
      const c = await this.backend.cancelAll(sym);
      if (!c.ok) {
        failed.add(sym);
        this.log('error', 'exec', `${sym} 撤单失败:${c.error}`);
      }
      const r = await this.backend.closePosition(sym, `tgd-halt-${Date.now().toString(36).slice(-6)}`);
      if (r.error) {
        failed.add(sym);
        this.log('error', 'exec', `${sym} 平仓失败:${r.error}`, r.receipt);
      } else if (r.closed) this.log('warn', 'exec', `${sym} 紧急平仓已提交`, r.receipt);
      else if (this.account?.positions.some((p) => p.symbol === sym)) {
        // closed=false with no error while we believe a position exists: not proven flat.
        failed.add(sym);
        this.log('error', 'exec', `${sym} 平仓返回未平且无错误,按未完成处理`, r.receipt);
      }
    }
    for (const t of this.openThreads()) {
      if (failed.has(t.symbol)) {
        // Exchange state unknown: keep the thread open under reconciliation instead of pretending it ended.
        this.saveThread({ ...t, attention: 'HALT_INCOMPLETE', version: t.version + 1, updated_at: Date.now() });
        continue;
      }
      this.saveThread({ ...t, status: t.status === 'pending_entry' ? 'canceled' : 'closed', closed_at: Date.now(), close_reason: '紧急停止', version: t.version + 1, updated_at: Date.now() });
    }
    await this.pollAccount();
  }

  // ------------------------------------------------------------ information officer

  runInfoNow(why: string): boolean {
    if (this.capReached('信息员')) return false;
    return this.queue.enqueue({
      key: 'info',
      kind: 'info',
      symbol: null,
      run: async () => {
        this.log('info', 'info', `信息员开始(${why})`);
        try {
          const prev = this.marketState;
          const { state, events } = await runInformationOfficer(this.cheapBrain(), this.workflow, prev, (l, m) => this.log(l, 'info', m));
          const n = this.store.saveInfoEvents(events);
          this.store.saveMarketState(state);
          this.marketState = state;
          this.emit('market_state.updated', state);
          this.log(state.error ? 'warn' : 'info', 'info', `市场状态:${state.regime}/${state.bias} · ${state.summary.slice(0, 80)}(新闻 ${events.length},新 ${n};${state.usage?.latency_ms ?? 0} ms)`);
          const regimeText: Record<string, string> = { trend_up: '趋势向上', trend_down: '趋势向下', range: '区间震荡', volatile: '高波动', unclear: '方向不明' };
          this.narrate(`信息员更新:${regimeText[state.regime] ?? state.regime},偏${state.bias === 'long' ? '多' : state.bias === 'short' ? '空' : '中性'}。${state.summary.slice(0, 120)}${state.candidates.length ? ` 候选:${state.candidates.map((c) => `${c.symbol} ${c.direction === 'long' ? '多' : '空'}`).join('、')}。` : ''}${state.risk_events.length ? ` 风险:${state.risk_events[0]}` : ''}`);
          this.activity('info_update', { title: `信息员:${regimeText[state.regime] ?? state.regime},偏${state.bias === 'long' ? '多' : state.bias === 'short' ? '空' : '中性'}`, detail: state.summary, data: { regime: state.regime, bias: state.bias, candidates: state.candidates, risk_events: state.risk_events } });
          const flipped = prev && prev.bias !== state.bias;
          if (flipped || state.risk_events.length) for (const t of this.openThreads()) this.reviewThread(t.id, { kind: 'info_update', detail: flipped ? `信息员偏向从 ${prev!.bias} 变为 ${state.bias}` : `信息员标了风险事件:${state.risk_events[0]}` });
        } catch (e) {
          this.log('error', 'info', `信息员失败:${(e as Error).message}`);
        } finally {
          this.scheduleInfo();
        }
      },
    });
  }

  // ------------------------------------------------------------ scans & reviews (episodes)

  scanAll(trigger: Trigger): number {
    let n = 0;
    for (const sym of this.workflow.watchlist) if (this.scan(sym, trigger)) n++;
    return n;
  }

  scan(symbol: string, trigger: Trigger): boolean {
    if (this.halted || this.workflow.paused) return false; // paused = no model calls at all
    if (this.openThreads().some((t) => t.symbol === symbol)) return false;
    if (this.capReached(`${symbol} 扫描`)) return false;
    return this.queue.enqueue({ key: `scan:${symbol}`, kind: 'scan', symbol, run: () => this.runEpisode({ symbol, trigger, mode: 'scan', threadId: null }).then(() => undefined) });
  }

  reviewThread(threadId: string, trigger: Trigger): boolean {
    const t = this.store.thread(threadId);
    if (!t || !isOpen(t)) return false;
    if (this.capReached(`${t.symbol} 复查`)) return false;
    return this.queue.enqueue({ key: `review:${threadId}`, kind: 'review', symbol: t.symbol, run: () => this.runEpisode({ symbol: t.symbol, trigger, mode: 'review', threadId }).then(() => undefined) });
  }

  private async runEpisode(args: { symbol: string; trigger: Trigger; mode: 'scan' | 'review'; threadId: string | null }): Promise<Episode> {
    const now = Date.now();
    const thread = args.threadId ? this.store.thread(args.threadId) : null;
    const ep: Episode = {
      id: id('ep'),
      at: now,
      as_of: now,
      symbol: args.symbol,
      thread_id: args.threadId,
      trigger: args.trigger,
      strategy_before: { state: thread ? (thread.status === 'in_position' ? 'active' : 'watching') : 'researching', version: thread?.version ?? 0 },
      evidence: [],
      context_text: '',
      context_hash: '',
      prompt_version: PROMPT_VERSION,
      model: this.mainBrain().name,
      judgment: null,
      judgment_raw: null,
      schema_errors: [],
      reducer: null,
      gates: [],
      intent: null,
      usage: null,
      status: 'running',
      error: null,
      strategy_after: null,
    };
    this.inFlight = ep;
    this.store.saveEpisode(ep);
    this.emit('episode.started', { id: ep.id, trigger: ep.trigger, symbol: ep.symbol, thread_id: ep.thread_id });
    this.emitLoop();
    this.log('info', 'episode', `${args.symbol} 开始${args.mode === 'scan' ? '扫描' : '复查'}:${args.trigger.detail}`, { episode_id: ep.id });
    this.progress('fetching', ep.id);
    try {
      await this.executeEpisode(ep, args.mode, thread);
      ep.status = 'done';
    } catch (e) {
      ep.status = 'failed';
      ep.error = (e as Error).message;
      this.log('error', 'episode', `${args.symbol} 判断失败:${ep.error}`, { episode_id: ep.id });
    } finally {
      const after = ep.thread_id ? this.store.thread(ep.thread_id) : null;
      ep.strategy_after = { state: after ? (after.status === 'in_position' ? 'active' : after.status === 'pending_entry' ? 'ready' : 'closed') : ep.intent ? 'ready' : ep.judgment?.action === 'WATCH' ? 'watching' : 'researching', version: after?.version ?? 0 };
      this.store.saveEpisode(ep);
      this.inFlight = null;
      this.lastEpisodeId = ep.id;
      this.progress('done', ep.id);
      this.emit('episode.finished', summarize(ep));
      this.emitLoop();
      if (ep.judgment) {
        const j = ep.judgment;
        const what = args.mode === 'scan' ? '看了' : '复查了';
        const act: Record<string, string> = { NO_TRADE: '不交易', WATCH: '先观察', PROPOSE: `提议${j.direction === 'long' ? '做多' : '做空'}`, HOLD: '继续持有', REDUCE: '减半', EXIT: '离场', INVALIDATE: '论点失效', ADD: '想加仓(演示版不执行)' };
        const gateNote = ep.reducer && !ep.reducer.accepted ? `;不过${ep.reducer.reason.slice(0, 60)}` : '';
        const watch = j.watch_conditions[0] ? `。下次看:${j.watch_conditions[0].slice(0, 50)}` : '';
        this.narrate(`刚${what} ${args.symbol}(${args.trigger.detail.slice(0, 24)}):${act[j.action] ?? j.action} —— ${j.headline}${gateNote}${watch}`, ep.id);
      } else if (ep.error) this.narrate(`${args.symbol} 这次判断没跑完:${ep.error.slice(0, 80)}`, ep.id);
    }
    return ep;
  }

  private async executeEpisode(ep: Episode, mode: 'scan' | 'review', thread: StrategyThread | null): Promise<void> {
    const symbol = ep.symbol;
    const tf = this.workflow.timeframe;
    const [kTf, k1h, k4h, oiHist, t24, market] = await Promise.all([
      fetchKlines(symbol, tf, 60),
      fetchKlines(symbol, '1h', 120),
      fetchKlines(symbol, '4h', 80),
      fetchOpenInterestHist(symbol, '1h', 2).catch(() => []),
      fetchTicker24h(symbol),
      fetchMarketView(symbol, tf),
    ]);
    this.markets.set(symbol, market);
    const pe = this.backend.tick(symbol, market.mark);
    if (pe.length) this.pendingPaperEvents.push(...pe);
    const account = await this.backend.account();
    this.account = account;
    this.progress('context', ep.id);
    const features: TfFeatures[] = [tfFeatures(tf, kTf), tfFeatures('1h', k1h), tfFeatures('4h', k4h)];
    const oiChange = oiHist.length >= 2 ? ((Number(oiHist[1]!.sumOpenInterest) - Number(oiHist[0]!.sumOpenInterest)) / Number(oiHist[0]!.sumOpenInterest)) * 100 : null;
    const last = this.store.episodes(50).find((e) => e.symbol === symbol && e.status === 'done' && e.action);
    const lastSummary = last ? `${new Date(last.at).toISOString().slice(11, 16)} UTC ${last.action}${last.direction ? `(${last.direction})` : ''}:${last.headline}` : null;
    const regime = await this.dailyRegimeFor(symbol);
    const hits = this.lastTriggerHits.get(symbol) ?? [];
    this.lastTriggerHits.delete(symbol);
    this.lastModelCallAt.set(symbol, Date.now());


    // v3.5 strategy library: only strategies at paper or above may drive a live judgment, and only the ones
    // this episode's triggers actually wake get rendered (an empty set falls back to playbook_text alone).
    const active = this.store.strategies.resolve(this.workflow.active_strategies ?? [], { allow_below_paper: false });
    if (active.errors.length) this.log('warn', 'strategy', `active_strategies 有问题:${active.errors.join(';')}`);
    const woken = hits.length ? active.specs.filter((st) => strategyWakes(st, tf, hits)) : active.specs;
    const fundingHistory = woken.some((st) => st.checklist.required.includes('funding_stats')) ? await this.fundingHistoryFor(symbol) : undefined;

    const built = buildContext({
      now: ep.at,
      symbol,
      trigger: ep.trigger,
      mode,
      thread,
      open_threads: this.openThreads(),
      account,
      market,
      features,
      oi_change_1h_pct: oiChange,
      ticker24h: t24,
      market_state: this.marketState,
      playbook_text: this.workflow.playbook_text,
      last_judgment_summary: lastSummary,
      halted: this.halted,
      daily_regime: regime,
      session: sessionInfo(ep.at),
      trigger_hits: hits,
      strategies: woken,
      klines: { [tf]: kTf, '1h': k1h, '4h': k4h },
      watch_only: this.workflow.watch_only.includes(symbol),
      invalidation_confirm_bars: this.workflow.invalidation_confirm_bars,
      invalidation_buffer_atr: this.workflow.invalidation_buffer_atr,
      ...(fundingHistory ? { funding_history: fundingHistory } : {}),
    });
    ep.evidence = built.evidence;
    ep.context_text = built.context_text;
    ep.context_hash = built.context_hash;
    this.store.saveEpisode(ep);

    const brain = this.mainBrain();
    const validRefs = new Set(built.evidence.map((e) => e.ref));
    this.progress('thinking', ep.id);
    let result = await brain.complete(built.system_text, built.user_text);
    this.progress('validating', ep.id);
    ep.judgment_raw = result.text;
    let judgment: Judgment | null = null;
    let errors: string[] = [];
    const tryParse = (text: string): void => {
      try {
        const v = validateJudgment(extractJson(text), validRefs, { strategies: built.strategy_ids });
        judgment = v.judgment;
        errors = v.errors;
      } catch (e) {
        errors = [(e as Error).message];
      }
    };
    tryParse(result.text);
    let usage = { input_tokens: result.input_tokens, output_tokens: result.output_tokens, latency_ms: result.latency_ms };
    // Illegal edge attempt (action not allowed at this graph node): rejected here and repaired once, but the
    // FIRST attempt is what eval's illegal_edge_attempts counts, so remember it for episode.graph.
    let illegalFirst: string | null = null;
    if (judgment && !built.allowed_actions.includes((judgment as Judgment).action)) {
      illegalFirst = (judgment as Judgment).action;
      errors = [`action ${illegalFirst} 不在允许范围 ${built.allowed_actions.join('/')}`];
      judgment = null;
    }
    if (!judgment) {
      this.log('warn', 'brain', `${symbol} 输出不合契约,修一次:${errors.join('; ')}`, { episode_id: ep.id });
      result = await brain.complete(built.system_text, `${built.user_text}\n\n你上一次的输出不符合契约,错误:\n- ${errors.join('\n- ')}\n上一次输出:\n${result.text.slice(0, 2000)}\n请只输出修正后的 JSON。`);
      ep.judgment_raw = result.text;
      usage = { input_tokens: usage.input_tokens + result.input_tokens, output_tokens: usage.output_tokens + result.output_tokens, latency_ms: usage.latency_ms + result.latency_ms };
      tryParse(result.text);
      if (judgment && !built.allowed_actions.includes((judgment as Judgment).action)) {
        illegalFirst = illegalFirst ?? (judgment as Judgment).action;
        errors = [`action ${(judgment as Judgment).action} 不在允许范围`];
        judgment = null;
      }
    }
    ep.schema_errors = errors;
    ep.usage = { ...usage, cost_estimate: 'n/a' };
    if (!judgment) {
      const failClosed: Judgment['action'] = mode === 'review' ? 'HOLD' : 'NO_TRADE';
      judgment = { action: failClosed, direction: null, confidence: 0, headline: '模型输出无法解析,按保守处理', thesis: '两次输出都不符合契约,系统 fail-closed。', reasons: [`契约错误:${errors.slice(0, 3).join('; ')}`], evidence_refs: [], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null };
      this.log('error', 'brain', `${symbol} 两次输出都不合契约,fail-closed 为 ${failClosed}`, { episode_id: ep.id });
      this.activity('brain_error', { level: 'warn', symbol, episode_id: ep.id, thread_id: ep.thread_id, title: `${symbol} 模型输出无法解析,按 ${failClosed} 处理`, detail: errors.slice(0, 3).join('; ') });
    }
    const j: Judgment = judgment;
    ep.judgment = j;
    // Judgment-graph bookkeeping: which node we were at, which edge the model picked (null = not an allowed
    // edge here — fail-safe below still applies, but the attempt is now counted instead of silently absorbed).
    const edge = edgeFor(built.node, j.action);
    ep.graph = { version: GRAPH_VERSION, node: built.node, edge: edge?.id ?? null, guards: [], illegal_action: illegalFirst ?? (edge ? null : j.action) };
    if (illegalFirst) this.log('warn', 'graph', `${symbol} 模型第一次在节点 ${built.node} 选了不允许的边 ${illegalFirst}(允许:${built.allowed_actions.join('/')}),已修正为 ${j.action}`, { episode_id: ep.id });
    if (!edge) {
      this.log('warn', 'graph', `${symbol} 模型在节点 ${built.node} 选了不允许的边 ${j.action}(允许:${built.allowed_actions.join('/') || '无'}),按不动处理`, { episode_id: ep.id });
      this.activity('brain_error', { level: 'warn', symbol, episode_id: ep.id, thread_id: ep.thread_id, title: `${symbol} 模型输出了当前状态不允许的动作 ${j.action}`, detail: `节点 ${built.node} 只允许 ${built.allowed_actions.join(' / ') || '无'}`, data: { node: built.node, action: j.action } });
    }
    this.log('info', 'brain', `${symbol} 判断:${j.action}${j.direction ? ` ${j.direction}` : ''} · ${j.headline}(信心 ${j.confidence.toFixed(2)},${usage.latency_ms} ms)`, { episode_id: ep.id });

    this.progress('gating', ep.id);
    if (mode === 'review' && thread) {
      const current = this.store.thread(thread.id);
      if (!current || !isOpen(current)) {
        ep.reducer = { from: ep.strategy_before.state, to: 'closed', accepted: false, reason: '线程在判断期间已结束' };
        return;
      }
      const d = reduceReview(current, j);
      ep.reducer = { from: ep.strategy_before.state, to: d.effect === 'none' ? ep.strategy_before.state : 'closing', accepted: d.accepted, reason: d.reason };
      ep.gates = [];
      if (ep.graph) ep.graph = { ...ep.graph, edge: d.edge, guards: ['thread_still_open'] };
      this.store.saveEpisode(ep);
      const next: StrategyThread = { ...current, ...d.patch, episode_ids: [...current.episode_ids, ep.id], version: current.version + 1, updated_at: Date.now() };
      this.saveThread(next);
      if (!d.accepted) {
        this.log('info', 'thread', `${symbol} 线程不变:${d.reason}`, { episode_id: ep.id });
        return;
      }
      if (d.effect === 'cancel_entry') await this.cancelEntry(next, ep, d.patch.close_reason ?? '撤单');
      else if (d.effect === 'close') await this.closeThreadNow(next, ep, d.patch.close_reason ?? '离场');
      else if (d.effect === 'reduce_half') await this.reduceHalf(next, ep);
      return;
    }

    // scan
    if (j.action !== 'PROPOSE' || !j.proposal) {
      ep.reducer = { from: 'researching', to: j.action === 'WATCH' ? 'watching' : 'researching', accepted: true, reason: j.action === 'WATCH' ? '有苗头,记为观察' : '没有优势' };
      return;
    }
    const opensToday = this.store.threadOpensSince(utcDayStart(ep.at));
    const blockers = openingBlockers(this.openThreads(), this.workflow, symbol, opensToday, this.dailyLossHit());
    const staleRefs = new Set(built.evidence.filter((e) => e.stale).map((e) => e.ref));
    const unknownOpen = this.store.intents(50).some((i) => i.status === 'unknown');
    ep.gates = evaluateGates(j, { halted: this.halted, paused: this.workflow.paused, account: { ...account, positions: account.positions.filter((p) => p.symbol === symbol) }, market, opens_today: opensToday, stale_refs: staleRefs, now: Date.now() }, { ...this.gatesCfg, risk_pct: Number(this.workflow.risk_pct), max_opens_per_day: this.workflow.max_opens_per_day });
    for (const b of blockers) ep.gates.push({ name: '线程/日内限制', passed: false, reason: b });
    ep.gates.push({ name: '没有状态不明的订单', passed: !unknownOpen, reason: unknownOpen ? '有一笔订单状态不明,先核对再开新仓' : '通过' });
    const gatesOk = ep.gates.every((g) => g.passed);
    ep.reducer = { from: 'researching', to: gatesOk ? 'ready' : 'watching', accepted: gatesOk, reason: gatesOk ? '提议通过代码闸,建线程' : `提议被拒:${ep.gates.filter((g) => !g.passed).map((g) => `${g.name}(${g.reason})`).join(';')}` };
    if (ep.graph) ep.graph = { ...ep.graph, guards: guardsFromGates(ep.gates) };
    this.store.saveEpisode(ep);
    if (!gatesOk) {
      this.log('warn', 'gate', `${symbol} 提议被代码闸拒绝:${ep.reducer.reason}`, { episode_id: ep.id });
      this.activity('proposal_blocked', { level: 'warn', symbol, episode_id: ep.id, title: `${symbol} 提议${j.direction === 'long' ? '做多' : '做空'}被代码闸拦下`, detail: ep.gates.filter((g) => !g.passed).map((g) => `${g.name}:${g.reason}`).join(';'), data: { direction: j.direction, proposal: j.proposal } });
      return;
    }
    this.activity('proposal', { level: 'success', symbol, episode_id: ep.id, title: `${symbol} 出策略:${j.direction === 'long' ? '做多' : '做空'} ${j.proposal.entry === 'market' ? '市价' : `限价 ${j.proposal.limit_price ?? ''}`},止损 ${j.proposal.stop_price}`, detail: j.headline, data: { direction: j.direction, proposal: j.proposal, confidence: j.confidence } });
    this.progress('executing', ep.id);
    await this.openThreadFromProposal(ep, j, account, market, 'agent');
  }

  // ------------------------------------------------------------ opening

  /** Fresh, last-moment checks that do not depend on the (possibly minutes-old) judgment inputs. */
  private preflightOpen(symbol: string, account: AccountView, excludeThreadId: string | null = null): string[] {
    const out: string[] = [];
    if (this.halted) out.push('紧急停止中');
    if (this.workflow.paused) out.push('已暂停');
    // An unverified channel no longer blocks an automatic open; a stop that fails to attach is caught
    // later by the "position without protection" watchdog on the thread.
    if (account.positions.some((p) => p.symbol === symbol)) out.push(`${symbol} 已有持仓(可能是外部的)`);
    // When re-checking right before sending, the thread being opened already exists — don't count it.
    const others = this.openThreads().filter((t) => t.id !== excludeThreadId);
    out.push(...openingBlockers(others, this.workflow, symbol, this.store.threadOpensSince(utcDayStart(Date.now()), excludeThreadId), this.dailyLossHit()));
    const info = this.symbolsCache?.find((x) => x.symbol === symbol);
    if (info && info.status !== 'TRADING') out.push(`${symbol} 当前状态 ${info.status},不可交易`);
    return out;
  }

  private async openThreadFromProposal(ep: Episode, j: Judgment, _staleAccount: AccountView, staleMarket: MarketView, source: StrategyThread['source'], opts: { forceApproval?: boolean } = {}): Promise<StrategyThread> {
    const p = j.proposal!;
    const rules = await this.backend.symbolRules(ep.symbol);
    // Re-pull account + mark right before sizing: the model may have taken minutes.
    const account = await this.backend.account();
    this.account = account;
    const market = await fetchMarketView(ep.symbol, this.workflow.timeframe).catch(() => staleMarket);
    const blockers = this.preflightOpen(ep.symbol, account);
    if (blockers.length) {
      ep.gates.push({ name: '提交前重闸', passed: false, reason: blockers.join(';') });
      if (ep.graph) ep.graph = { ...ep.graph, guards: guardsFromGates(ep.gates) };
      ep.reducer = { from: 'researching', to: 'watching', accepted: false, reason: `提交前重闸拒绝:${blockers.join(';')}` };
      this.store.saveEpisode(ep);
      this.log('warn', 'gate', `${ep.symbol} 提交前重闸拒绝:${blockers.join(';')}`, { episode_id: ep.id });
      throw Object.assign(new Error(`提交前重闸拒绝:${blockers.join(';')}`), { status: 409 });
    }
    const sizing = computeSizing(j, account, market, rules, { ...this.gatesCfg, risk_pct: Number(this.workflow.risk_pct) });
    ep.sizing = sizing.sizing;
    this.store.saveEpisode(ep);
    const thread = newThread({
      id: id('thr'),
      backend: this.backend.kind,
      symbol: ep.symbol,
      side: p.direction,
      source,
      timeframe: this.workflow.timeframe,
      thesis: j.thesis,
      invalidation_text: j.invalidation,
      watch_conditions: j.watch_conditions,
      entry: { type: p.entry, price: p.entry === 'limit' ? p.limit_price : null, zone: p.entry_zone },
      stop_price: p.stop_price,
      take_profits: p.take_profits,
      qty: sizing.qty,
      margin_usdt: (Number(sizing.qty) * Number(p.entry === 'limit' && p.limit_price ? p.limit_price : market.mark) / this.workflow.leverage).toFixed(2),
      leverage: this.workflow.leverage,
      margin_mode: this.workflow.margin_mode,
      now: Date.now(),
    });
    thread.episode_ids = [ep.id];
    this.saveThread(thread);
    ep.thread_id = thread.id;
    const intent = this.newIntent(ep, thread, 'agent', { kind: 'open', direction: p.direction, quantity: sizing.qty, entry: p.entry, limit_price: p.limit_price, stop_price: p.stop_price, take_profit_price: p.take_profits[0] ?? null, sizing: sizing.sizing });
    if (!sizing.ok) {
      this.updateIntent(ep, intent, { status: 'rejected', error: `数量不可用:${sizing.sizing.note}` });
      this.saveThread({ ...thread, status: 'canceled', closed_at: Date.now(), close_reason: '数量不可用', version: 2, updated_at: Date.now() });
      return thread;
    }
    this.log('info', 'exec', `${ep.symbol} 开仓意图:${p.direction === 'long' ? '做多' : '做空'} ${sizing.qty},${p.entry === 'market' ? '市价' : `限价 ${p.limit_price}`},止损 ${p.stop_price}${p.take_profits.length ? `,止盈 ${p.take_profits.join('/')}` : ''}(${sizing.sizing.note})`, { thread_id: thread.id });
    if ((!this.workflow.auto_approve || opts.forceApproval) && source !== 'manual') {
      this.log('info', 'exec', `${ep.symbol} 等待你在界面上确认`, { intent_id: intent.id });
      this.activity('approval_needed', { level: 'warn', symbol: ep.symbol, thread_id: thread.id, episode_id: ep.id, title: `${ep.symbol} ${p.direction === 'long' ? '做多' : '做空'} ${sizing.qty} 等你确认`, detail: `${p.entry === 'market' ? '市价' : `限价 ${p.limit_price}`},止损 ${p.stop_price}`, data: { intent_id: intent.id } });
      return thread;
    }
    await this.executeOpen(thread, intent, ep);
    return thread;
  }

  private newIntent(ep: Episode | null, thread: StrategyThread | null, principal: DemoIntent['principal'], partial: Pick<DemoIntent, 'kind' | 'direction' | 'quantity' | 'entry' | 'limit_price' | 'stop_price' | 'take_profit_price' | 'sizing'>): DemoIntent {
    const intent: DemoIntent = {
      id: id('int'),
      episode_id: ep?.id ?? '',
      thread_id: thread?.id ?? null,
      principal,
      at: Date.now(),
      symbol: thread?.symbol ?? ep?.symbol ?? '',
      status: 'pending_approval',
      client_order_id: null,
      backend: this.backend.kind,
      receipts: [],
      error: null,
      ...partial,
    };
    this.store.saveIntent(intent);
    if (ep) {
      ep.intent = intent;
      this.store.saveEpisode(ep);
    }
    if (thread) {
      const t = this.store.thread(thread.id);
      if (t) this.saveThread({ ...t, intent_ids: [...t.intent_ids, intent.id] });
    }
    this.emit('intent.changed', intent);
    return intent;
  }
  private updateIntent(ep: Episode | null, intent: DemoIntent, patch: Partial<DemoIntent>): void {
    Object.assign(intent, patch);
    this.store.saveIntent(intent);
    if (ep) {
      ep.intent = intent;
      this.store.saveEpisode(ep);
    }
    this.emit('intent.changed', intent);
  }

  private async executeOpen(threadIn: StrategyThread, intent: DemoIntent, ep: Episode | null): Promise<void> {
    const t = this.store.thread(threadIn.id) ?? threadIn;
    if (t.status !== 'pending_entry' || t.entry_client_order_id) throw Object.assign(new Error(`thread ${t.id} is ${t.status}${t.entry_client_order_id ? ' (entry already sent)' : ''}`), { status: 409 });
    const minted = nextLegCid(t, 'e');
    const cid = minted.cid;
    // Persist the CID BEFORE the network call so an unknown outcome can always be reconciled.
    // entry_submitting_since: the reconcile loop must not query this CID (→ false ORDER_UNKNOWN) while the
    // leverage/margin/entry calls are in flight.
    this.saveThread({ ...minted.next, entry_client_order_id: cid, entry_submitting_since: Date.now(), entry_submitted_at: null, version: t.version + 1, updated_at: Date.now() });
    this.updateIntent(ep, intent, { status: 'approved', client_order_id: cid });
    const abort = async (why: string): Promise<void> => {
      this.updateIntent(ep, intent, { status: 'rejected', error: why });
      this.saveThread({ ...(this.store.thread(t.id) ?? t), status: 'canceled', entry_client_order_id: null, closed_at: Date.now(), close_reason: why, version: t.version + 2, updated_at: Date.now() });
      this.log('warn', 'exec', `${t.symbol} 未发送入场单:${why}`, { thread_id: t.id });
    };
    const fresh = await this.backend.account();
    this.account = fresh;
    const blockers = this.preflightOpen(t.symbol, fresh, t.id);
    if (blockers.length) return abort(`发送前重闸拒绝:${blockers.join(';')}`);
    // Agent PROPOSE: revalidate the immutable approved quantity against fresh caps; never resize it.
    if (Number(intent.sizing.risk_pct) > 0) {
      try {
        const [market, ticker, rules] = await Promise.all([
          fetchMarketView(t.symbol, t.timeframe), fetchTicker24h(t.symbol), this.backend.symbolRules(t.symbol),
        ]);
        this.markets.set(t.symbol, market);
        void ticker;
        const proposal = { direction: t.side, entry: t.entry.type, limit_price: t.entry.price, stop_price: t.stop_price };
        const checked = computeSizing({ proposal } as Judgment, fresh, market, rules,
          { ...this.gatesCfg, risk_pct: Math.min(Number(intent.sizing.risk_pct), Number(this.workflow.risk_pct)) },
          { fixed_qty: t.qty });
        if (!checked.ok) return abort(`发送前数量硬闸:${checked.sizing.note}`);
      } catch { return abort('发送前硬闸数据不可用'); }
    }
    const lev = await this.backend.setLeverage(t.symbol, t.leverage);
    if (!lev.ok) return abort(`设杠杆失败:${lev.error}`);
    const mt = await this.backend.setMarginType(t.symbol, t.margin_mode);
    if (!mt.ok) return abort(`设保证金模式失败:${mt.error}`);
    if (this.halted) return abort('发送前发现紧急停止');
    const req = { symbol: t.symbol, direction: t.side, qty: t.qty, entry: t.entry.type, limit_price: t.entry.price, client_order_id: cid };
    let placed: Parameters<DemoRuntime['placeProtection']>[2];
    let entry: OrderReceipt;
    if (this.backend.openWithProtection && t.entry.type === 'market' && t.stop_price) {
      const stop = nextLegCid(this.store.thread(t.id) ?? minted.next, 's');
      const tp = t.take_profits[0] ? nextLegCid(stop.next, 't') : null;
      // All client IDs survive a crash during this single CLI run.
      this.saveThread({ ...(tp?.next ?? stop.next), protection_client_order_ids: [stop.cid, ...(tp ? [tp.cid] : [])] });
      const combined = await this.backend.openWithProtection({ ...req, entry: 'market', stop_price: t.stop_price, stop_client_algo_id: stop.cid,
        ...(tp ? { take_profit: { trigger_price: t.take_profits[0]!, client_algo_id: tp.cid } } : {}),
      });
      entry = combined.entry;
      const receipt = (leg: typeof combined.stop): OrderReceipt => ({ outcome: leg.outcome === 'skipped' || leg.outcome === 'filled' ? 'failed' : leg.outcome, receipt: leg, avg_price: null, error: leg.error ?? (leg.outcome === 'filled' ? '保护腿已触发,不再是活动止损' : leg.outcome === 'skipped' ? '保护腿未发送' : null) });
      placed = { stop: { id: stop.cid, receipt: receipt(combined.stop) }, ...(tp ? { tp: { id: tp.cid, receipt: receipt(combined.tp) } } : {}) };
      intent.receipts.push({ leg: 'open_with_protection', ...combined });
    } else entry = await this.backend.placeEntry(req);
    intent.receipts.push({ leg: 'entry', ...entry });
    let outcome = entry.outcome;
    {
      // The call returned (whatever it said): open the 45 s attribution grace, close the submit phase.
      const c = this.store.thread(t.id) ?? t;
      this.saveThread({ ...c, entry_submitting_since: null, entry_submitted_at: Date.now(), version: c.version + 1, updated_at: Date.now() });
    }
    const cur = this.store.thread(t.id) ?? t;
    if (outcome === 'unknown') {
      this.log('warn', 'exec', `${t.symbol} 入场单状态不明,2 秒后按 clientOrderId 核对`, { thread_id: t.id });
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const found = await this.backend.getOrder(t.symbol, cid);
        intent.receipts.push({ leg: 'entry-reconcile', found });
        if (found) outcome = found.status === 'FILLED' ? 'filled' : ['CANCELED', 'EXPIRED', 'REJECTED'].includes(found.status) ? 'failed' : 'submitted';
      } catch {
        /* still unknown */
      }
      if (outcome === 'unknown') {
        // null/failed lookup is not a negative fact: leave the thread pending under reconciliation, never re-send.
        this.updateIntent(ep, intent, { status: 'unknown', error: '入场单状态不明,巡检继续按 clientOrderId 核对' });
        this.saveThread({ ...cur, attention: 'ORDER_UNKNOWN', version: cur.version + 1, updated_at: Date.now() });
        this.log('error', 'exec', `${t.symbol} 入场单状态不明,线程保持待入场并持续核对;冻结新开仓`, { thread_id: t.id });
        return;
      }
    }
    if (outcome === 'failed') {
      this.updateIntent(ep, intent, { status: 'failed', error: entry.error ?? '入场失败' });
      this.saveThread({ ...cur, status: 'canceled', closed_at: Date.now(), close_reason: `入场失败:${entry.error}`, version: cur.version + 1, updated_at: Date.now() });
      this.log('error', 'exec', `${t.symbol} 入场失败:${entry.error}`, { thread_id: t.id, receipt: entry.receipt });
      return;
    }
    this.updateIntent(ep, intent, { status: outcome === 'filled' ? 'filled' : 'submitted' });
    let next: StrategyThread = { ...cur, version: cur.version + 1, updated_at: Date.now() };
    if (outcome === 'filled') {
      next = { ...next, status: 'in_position', opened_at: Date.now(), filled_avg_price: entry.avg_price ?? this.markets.get(t.symbol)?.mark ?? null };
      this.saveThread(next);
      this.log('info', 'exec', `${t.symbol} 入场已成交${entry.avg_price ? ` @ ${entry.avg_price}` : ''}`, { thread_id: t.id });
      this.activity('entry_filled', { level: 'success', symbol: t.symbol, thread_id: t.id, episode_id: ep?.id ?? null, title: `${t.symbol} ${t.side === 'long' ? '做多' : '做空'} ${t.qty} 已成交${next.filled_avg_price ? ` @ ${next.filled_avg_price}` : ''}`, detail: `止损 ${t.stop_price ?? '无'}${t.take_profits[0] ? `,止盈 ${t.take_profits.join('/')}` : ''}`, data: { side: t.side, qty: t.qty, price: next.filled_avg_price, source: t.source } });
      this.narrate(`${t.symbol} ${t.side === 'long' ? '做多' : '做空'} ${t.qty} 已成交${entry.avg_price ? ` @ ${entry.avg_price}` : ''}${t.stop_price ? `,止损 ${t.stop_price}` : ''}${t.take_profits[0] ? `,止盈 ${t.take_profits[0]}` : ''}。`);
      // A combined receipt is consumed directly; no second CLI stop or account/get_order round trip.
      await this.placeProtection(next, '入场成交后', placed);
    } else if (t.entry.type === 'market') {
      // MARKET 只拿到 ACK(agent_mcp 常见):不是限价挂单,成交要靠巡检按 CID 核对。
      this.saveThread(next);
      this.log('info', 'exec', `${t.symbol} 市价入场单已提交,等回执确认成交`, { thread_id: t.id });
      this.activity('thread_opened', { symbol: t.symbol, thread_id: t.id, episode_id: ep?.id ?? null, title: `${t.symbol} ${t.side === 'long' ? '做多' : '做空'} 市价单已提交`, detail: `数量 ${t.qty},止损 ${t.stop_price ?? '无'};成交确认中`, data: { side: t.side, qty: t.qty, price: null, source: t.source } });
      this.narrate(`${t.symbol} 市价单已提交,等交易所回执确认成交。`);
    } else {
      this.saveThread(next);
      this.log('info', 'exec', `${t.symbol} 限价入场单已挂 @ ${t.entry.price},等成交`, { thread_id: t.id });
      this.activity('thread_opened', { symbol: t.symbol, thread_id: t.id, episode_id: ep?.id ?? null, title: `${t.symbol} ${t.side === 'long' ? '做多' : '做空'} 限价 ${t.entry.price} 已挂`, detail: `数量 ${t.qty},止损 ${t.stop_price ?? '无'}`, data: { side: t.side, qty: t.qty, price: t.entry.price, source: t.source } });
      this.narrate(`${t.symbol} 限价 ${t.entry.price} 已挂,等成交;不成交我会在下一根 K 线复查要不要撤。`);
    }
    await this.pollAccount();
  }

  /** 意图指纹:批准 token 绑定它,内容变了 token 作废。 */
  intentFingerprint(i: DemoIntent): string {
    return fingerprintOf({ id: i.id, kind: i.kind, symbol: i.symbol, direction: i.direction, quantity: i.quantity, entry: i.entry, limit_price: i.limit_price, stop_price: i.stop_price, take_profit_price: i.take_profit_price, status: i.status, backend: i.backend });
  }
  /** 界面先取一张 token 再批;返回摘要让人核对四项。 */
  issueIntentConfirmation(intentId: string): { token: ConfirmToken; intent: DemoIntent } {
    const intent = this.store.intent(intentId);
    if (!intent) throw Object.assign(new Error('intent not found'), { status: 404 });
    if (intent.status !== 'pending_approval') throw Object.assign(new Error(`intent is ${intent.status}`), { status: 409 });
    return { token: this.confirmations.issue('intent', intent.id, this.intentFingerprint(intent)), intent };
  }

  /**
   * v3.10.1:人在界面批 → 必须带一次性 confirm token(§9.19);agent 在对话里批(opts.by='agent')→ 只在
   * workflow.chat_requires_approval=false 时放行,否则 428。扫描自动路径不走这里。
   */
  async approveIntent(intentId: string, nonce?: string | null, opts: { by?: 'human' | 'agent' } = {}): Promise<DemoIntent> {
    if (this.approving.has(intentId)) throw Object.assign(new Error('approval already in progress'), { status: 409 });
    this.approving.add(intentId);
    try {
      const intent = this.store.intent(intentId);
      if (!intent) throw Object.assign(new Error('intent not found'), { status: 404 });
      if (intent.status !== 'pending_approval') throw Object.assign(new Error(`intent is ${intent.status}`), { status: 409 });
      if (opts.by === 'agent') {
        if (this.workflow.chat_requires_approval) throw Object.assign(new Error('设置里开了「对话执行需人批」:agent 不能自批,请用户在界面上点确认'), { status: 428, code: 'confirm_required' });
      } else {
        const c = this.confirmations.consume(nonce, 'intent', intent.id, this.intentFingerprint(intent));
        if (!c.ok) throw Object.assign(new Error(c.message), { status: c.code === 'confirm_required' ? 428 : 409, code: c.code });
      }
      const thread = intent.thread_id ? this.store.thread(intent.thread_id) : null;
      if (!thread) throw Object.assign(new Error('thread not found'), { status: 404 });
      if (!isOpen(thread)) throw Object.assign(new Error(`thread is ${thread.status}`), { status: 409 });
      if (this.halted) throw Object.assign(new Error('紧急停止中,不能批准开仓'), { status: 409 });
      if (this.workflow.paused) throw Object.assign(new Error('已暂停,不能批准开仓'), { status: 409 });
      const ep = intent.episode_id ? this.store.episode(intent.episode_id) : null;
      this.activity('approved', { symbol: thread.symbol, thread_id: thread.id, episode_id: ep?.id ?? null, title: `${thread.symbol} 你批准了${intent.kind === 'open' ? '开仓' : '平仓'}` });
      if (intent.kind === 'open') await this.executeOpen(thread, intent, ep);
      else if (intent.kind === 'close') {
        this.updateIntent(ep, intent, { status: 'approved' });
        await this.closeThreadNow(thread, ep, intent.error ?? '用户确认平仓');
        const after = this.store.thread(thread.id);
        this.updateIntent(ep, intent, { status: after && !isOpen(after) ? 'filled' : 'failed' });
      }
      return intent;
    } finally {
      this.approving.delete(intentId);
    }
  }
  // ------------------------------------------------------------ v3.10 设置提议(对话改高风险设置只到提议)

  workflowProposals(): WorkflowProposal[] {
    const now = Date.now();
    for (const p of this.proposals.values()) if (p.status === 'pending' && p.expires_at <= now) { p.status = 'expired'; p.resolved_at = now; }
    return [...this.proposals.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 50);
  }
  proposeWorkflow(patch: Record<string, unknown>, ctx: { session_id: string | null }): WorkflowProposal {
    const keys = Object.keys(patch);
    const before = Object.fromEntries(keys.map((k) => [k, (this.workflow as unknown as Record<string, unknown>)[k] ?? null]));
    const preview = applyWorkflowPatch(this.workflow, patch);
    const after = Object.fromEntries(keys.map((k) => [k, (preview.next as unknown as Record<string, unknown>)[k] ?? null]));
    const now = Date.now();
    const p: WorkflowProposal = { id: `wfp-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, created_at: now, expires_at: now + PROPOSAL_TTL_MS, status: preview.errors.length ? 'rejected' : 'pending', via: 'chat', session_id: ctx.session_id, patch, before, after, errors: preview.errors, resolved_at: preview.errors.length ? now : null };
    this.proposals.set(p.id, p);
    this.emit('workflow.proposal', { id: p.id, status: p.status, keys });
    if (p.status === 'pending') this.activity('chat_action', { level: 'warn', title: `对话提议改设置:${keys.join('、')},等你在界面上确认`, detail: keys.map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`).join('; '), data: { proposal_id: p.id } });
    return p;
  }
  private proposalFingerprint(p: WorkflowProposal): string {
    const current = Object.fromEntries(Object.keys(p.patch).map((k) => [k, (this.workflow as unknown as Record<string, unknown>)[k] ?? null]));
    return fingerprintOf({ id: p.id, patch: p.patch, current });
  }
  issueProposalConfirmation(id: string): { token: ConfirmToken; proposal: WorkflowProposal } {
    const p = this.proposals.get(id);
    if (!p) throw Object.assign(new Error('proposal not found'), { status: 404 });
    if (p.status !== 'pending' || p.expires_at <= Date.now()) throw Object.assign(new Error(`proposal is ${p.status === 'pending' ? 'expired' : p.status}`), { status: 409 });
    return { token: this.confirmations.issue('workflow_proposal', p.id, this.proposalFingerprint(p)), proposal: p };
  }
  applyWorkflowProposal(id: string, nonce: string | null | undefined): { proposal: WorkflowProposal; workflow: Workflow; errors: string[] } {
    const p = this.proposals.get(id);
    if (!p) throw Object.assign(new Error('proposal not found'), { status: 404 });
    if (p.status !== 'pending' || p.expires_at <= Date.now()) throw Object.assign(new Error(`proposal is ${p.status === 'pending' ? 'expired' : p.status}`), { status: 409 });
    const c = this.confirmations.consume(nonce, 'workflow_proposal', p.id, this.proposalFingerprint(p));
    if (!c.ok) throw Object.assign(new Error(c.message), { status: c.code === 'confirm_required' ? 428 : 409, code: c.code });
    const r = this.setWorkflow(p.patch);
    p.status = r.errors.length ? 'rejected' : 'applied';
    p.errors = r.errors;
    p.resolved_at = Date.now();
    this.emit('workflow.proposal', { id: p.id, status: p.status, keys: Object.keys(p.patch) });
    this.log('warn', 'chat', `用户确认了设置提议 ${p.id}:${Object.keys(p.patch).join('、')}${r.errors.length ? `(有错:${r.errors.join('; ')})` : ''}`);
    return { proposal: p, workflow: r.workflow, errors: r.errors };
  }
  rejectWorkflowProposal(id: string): WorkflowProposal {
    const p = this.proposals.get(id);
    if (!p) throw Object.assign(new Error('proposal not found'), { status: 404 });
    if (p.status === 'pending') { p.status = 'rejected'; p.resolved_at = Date.now(); this.emit('workflow.proposal', { id: p.id, status: p.status, keys: Object.keys(p.patch) }); }
    return p;
  }

  rejectIntent(intentId: string): DemoIntent {
    const intent = this.store.intent(intentId);
    if (!intent) throw Object.assign(new Error('intent not found'), { status: 404 });
    if (intent.status !== 'pending_approval') throw Object.assign(new Error(`intent is ${intent.status}`), { status: 409 });
    const ep = intent.episode_id ? this.store.episode(intent.episode_id) : null;
    this.updateIntent(ep, intent, { status: 'rejected', error: '用户拒绝' });
    const t = intent.thread_id ? this.store.thread(intent.thread_id) : null;
    if (t) this.saveThread({ ...t, status: 'canceled', closed_at: Date.now(), close_reason: '用户拒绝了提议', version: t.version + 1, updated_at: Date.now() });
    this.activity('rejected', { symbol: intent.symbol, thread_id: intent.thread_id, title: `${intent.symbol} 你拒绝了${intent.kind === 'open' ? '开仓' : '平仓'}提议` });
    return intent;
  }

  // ------------------------------------------------------------ closing / reducing

  private async cancelEntry(t: StrategyThread, ep: Episode | null, reason: string): Promise<void> {
    if (t.entry_client_order_id) {
      const c = await this.backend.cancelOrder(t.symbol, t.entry_client_order_id);
      if (!c.ok) {
        // Cancel not confirmed: the order may still be live. Keep the thread pending under reconciliation.
        this.saveThread({ ...t, attention: 'CANCEL_UNKNOWN', close_reason: reason, version: t.version + 1, updated_at: Date.now() });
        this.log('error', 'exec', `${t.symbol} 撤入场单失败(${c.error}),线程保持待入场并继续核对`, { thread_id: t.id });
        await this.pollAccount();
        return;
      }
    }
    this.saveThread({ ...t, status: 'canceled', closed_at: Date.now(), close_reason: reason, attention: null, version: t.version + 1, updated_at: Date.now() });
    this.log('info', 'thread', `${t.symbol} 线程已撤:${reason}`, { thread_id: t.id, episode_id: ep?.id });
    this.activity(reason.includes('失效') ? 'thread_invalidated' : 'thread_canceled', { symbol: t.symbol, thread_id: t.id, episode_id: ep?.id ?? null, title: `${t.symbol} ${t.side === 'long' ? '做多' : '做空'} 挂单已撤:${reason}` });
    await this.pollAccount();
  }

  private async closeThreadNow(tIn: StrategyThread, ep: Episode | null, reason: string): Promise<void> {
    let t = tIn;
    if (t.status === 'pending_entry') return this.cancelEntry(t, ep, reason);
    const pos = this.account?.positions.find((p) => p.symbol === t.symbol);
    const intent = this.newIntent(ep, t, ep ? 'agent' : 'user', { kind: 'close', direction: t.side, quantity: pos?.qty ?? t.qty, entry: 'market', limit_price: null, stop_price: null, take_profit_price: null, sizing: { equity: this.account?.equity ?? '0', risk_pct: '0', risk_usdt: '0', stop_distance: '0', raw_qty: pos?.qty ?? t.qty, step_size: '0', note: '全部平仓' } });
    const minted = nextLegCid(t, 'x');
    const cid = minted.cid;
    this.saveThread(minted.next);
    t = minted.next;
    this.updateIntent(ep, intent, { status: 'approved', client_order_id: cid });
    const c = await this.backend.cancelAll(t.symbol);
    if (!c.ok) this.log('warn', 'exec', `${t.symbol} 撤单失败:${c.error}`);
    const r = await this.backend.closePosition(t.symbol, cid);
    intent.receipts.push({ leg: 'close', ...r });
    let proven = r.closed && !r.error;
    if (!proven && !r.error) {
      // closed=false without an error: only accept if a fresh account read proves we are flat.
      const fresh = await this.backend.account();
      this.account = fresh;
      proven = !fresh.positions.some((p) => p.symbol === t.symbol);
    }
    if (!proven) {
      this.updateIntent(ep, intent, { status: 'failed', error: r.error ?? '平仓未被证实' });
      this.saveThread({ ...t, attention: 'CLOSE_FAILED', version: t.version + 1, updated_at: Date.now() });
      this.log('error', 'exec', `${t.symbol} 平仓失败:${r.error ?? '未证实已平'}`, { thread_id: t.id });
      return;
    }
    this.updateIntent(ep, intent, { status: 'filled' });
    const rec = r.receipt as { realizedPnl?: string; avgPrice?: string; avg_price?: string } | null;
    const closedThread: StrategyThread = { ...t, status: 'closed', closed_at: Date.now(), close_reason: reason, realized_pnl: rec?.realizedPnl ?? null, exit_price: rec?.avgPrice ?? rec?.avg_price ?? this.markets.get(t.symbol)?.mark ?? null, attention: null, version: t.version + 1, updated_at: Date.now() };
    this.saveThread(closedThread);
    this.log('info', 'exec', `${t.symbol} 已平仓:${reason}`, { thread_id: t.id, receipt: r.receipt });
    this.activityForThreadEvent(closedThread, 'closed', reason, null);
    await this.pollAccount();
    if (this.account) this.recordEquity(this.account, true);
  }

  private async reduceHalf(t: StrategyThread, ep: Episode): Promise<void> {
    const pos = this.account?.positions.find((p) => p.symbol === t.symbol);
    if (!pos) return;
    const rules = await this.backend.symbolRules(t.symbol);
    const step = Number(rules.step_size) || 0.001;
    const decimals = Math.max(0, (rules.step_size.split('.')[1] ?? '').replace(/0+$/, '').length);
    const half = (Math.floor(Number(pos.qty) / 2 / step) * step).toFixed(decimals);
    if (!(Number(half) > 0)) {
      this.log('warn', 'exec', `${t.symbol} 持仓太小,减不了一半,保持不动`, { thread_id: t.id });
      return;
    }
    const intent = this.newIntent(ep, t, 'agent', { kind: 'reduce', direction: t.side, quantity: half, entry: 'market', limit_price: null, stop_price: null, take_profit_price: null, sizing: { equity: this.account?.equity ?? '0', risk_pct: '0', risk_usdt: '0', stop_distance: '0', raw_qty: half, step_size: rules.step_size, note: '减半' } });
    const minted = nextLegCid(t, 'r');
    const cid = minted.cid;
    this.saveThread(minted.next);
    this.updateIntent(ep, intent, { status: 'approved', client_order_id: cid });
    const r = await this.backend.reducePosition(t.symbol, half, cid);
    intent.receipts.push({ leg: 'reduce', ...r });
    this.updateIntent(ep, intent, { status: r.outcome === 'failed' ? 'failed' : r.outcome === 'unknown' ? 'unknown' : 'filled', error: r.error });
    this.log(r.outcome === 'failed' ? 'error' : 'info', 'exec', `${t.symbol} 减仓 ${half}:${r.outcome}${r.error ? ` ${r.error}` : ''}`, { thread_id: t.id });
    // Local qty is derived from fills only; unknown/failed leaves it to the next reconcile pass.
    if (r.outcome === 'filled') this.saveThread({ ...(this.store.thread(t.id) ?? t), qty: (Number(pos.qty) - Number(half)).toFixed(decimals), version: (this.store.thread(t.id)?.version ?? t.version) + 1, updated_at: Date.now() });
    await this.pollAccount();
  }

  /** UI / chat: close (or cancel) a thread now. */
  async closeThread(threadId: string, reason = '手动平仓'): Promise<StrategyThread> {
    const t = this.store.thread(threadId);
    if (!t) throw Object.assign(new Error('thread not found'), { status: 404 });
    if (!isOpen(t)) throw Object.assign(new Error(`thread is ${t.status}`), { status: 409 });
    // 09-07 事故:入场单还在子代理手里飞(agent_mcp 一次运行 40 多秒),界面点撤单走了「撤入场单」,交易所那边其实已成交,
    // 撤单回「已不存在」被当成功,线程标成已撤,留下一张界面上碰不到的仓。发送中一律不许撤,等回执。
    if (t.status === 'pending_entry' && typeof t.entry_submitting_since === 'number') {
      const secs = Math.round((Date.now() - t.entry_submitting_since) / 1000);
      throw Object.assign(new Error(`${t.symbol} 入场单正在发送中(已 ${secs} 秒,agent_mcp 通道一次约 40 秒),交易所可能已成交;等回执回来再平仓或撤单`), { status: 409 });
    }
    await this.closeThreadNow(t, null, reason);
    return this.store.thread(threadId)!;
  }

  /**
   * 09-07:把一张不属于任何线程的持仓(手动单、撤单竞态留下的孤儿仓)交给 agent 管。
   * 建一条 in_position 线程:方向/数量/入场价从交易所读;止损优先用交易所上已挂的反向止损单,没有就必须由人给一个;
   * 有交易所止损就登记它的 id 不重复挂,没有就走 placeProtection 挂上。之后它和 agent 自己开的仓一样进复查循环。
   */
  async adoptPosition(symbolIn: string, opts: { stop_price?: string | null; take_profit?: string | null } = {}): Promise<StrategyThread> {
    const symbol = symbolIn.toUpperCase();
    if (this.halted) throw Object.assign(new Error('紧急停止中'), { status: 409 });
    const owned = this.openThreads().find((t) => t.symbol === symbol);
    if (owned) throw Object.assign(new Error(`${symbol} 已经有线程 ${owned.id}(${owned.status}),不用接管`), { status: 409 });
    const acct = await this.backend.account();
    this.account = acct;
    const pos = acct.positions.find((p) => p.symbol === symbol && Number(p.qty) !== 0);
    if (!pos) throw Object.assign(new Error(`${symbol} 交易所上没有持仓`), { status: 409 });
    const exchangeStop = acct.open_orders.find((o) => o.symbol === symbol && o.stop_price && /STOP/i.test(o.type) && !/TAKE_PROFIT/i.test(o.type) && (pos.side === 'long' ? /sell/i.test(o.side) : /buy/i.test(o.side))) ?? null;
    const exchangeTp = acct.open_orders.find((o) => o.symbol === symbol && o.stop_price && /TAKE_PROFIT/i.test(o.type) && (pos.side === 'long' ? /sell/i.test(o.side) : /buy/i.test(o.side))) ?? null;
    const stopPrice = (opts.stop_price && String(opts.stop_price).trim()) || exchangeStop?.stop_price || null;
    if (!stopPrice) throw Object.assign(new Error(`${symbol} 交易所上没有止损单,接管必须给一个止损价`), { status: 400 });
    const ref = Number(pos.mark_price) > 0 ? Number(pos.mark_price) : Number(pos.entry_price);
    const stopOk = pos.side === 'long' ? Number(stopPrice) < ref : Number(stopPrice) > ref;
    if (!(Number(stopPrice) > 0) || !stopOk) throw Object.assign(new Error(`止损 ${stopPrice} 必须在${pos.side === 'long' ? '标记价下方' : '标记价上方'}(标记价 ${ref})`), { status: 400 });
    const tp = (opts.take_profit && String(opts.take_profit).trim()) || exchangeTp?.stop_price || null;
    const useExchangeStop = !opts.stop_price && exchangeStop !== null;
    const useExchangeTp = tp !== null && !opts.take_profit && exchangeTp !== null;
    const leverage = pos.leverage > 0 ? pos.leverage : this.workflow.leverage;
    const now = Date.now();
    const base = newThread({
      id: id('thr'),
      backend: this.backend.kind,
      symbol,
      side: pos.side,
      source: 'manual',
      timeframe: this.workflow.timeframe,
      thesis: `人工持仓交给 agent 接管:${pos.side === 'long' ? '做多' : '做空'} ${pos.qty} @ ${pos.entry_price}`,
      invalidation_text: null,
      watch_conditions: [],
      entry: { type: 'market', price: pos.entry_price, zone: null },
      stop_price: stopPrice,
      take_profits: tp ? [tp] : [],
      qty: pos.qty,
      margin_usdt: ((Math.abs(Number(pos.qty)) * ref) / leverage).toFixed(2),
      leverage,
      margin_mode: this.workflow.margin_mode,
      now,
    });
    let thread: StrategyThread = {
      ...base,
      status: 'in_position',
      opened_at: now,
      filled_avg_price: pos.entry_price,
      protection_client_order_ids: [...(useExchangeStop && exchangeStop?.client_order_id ? [exchangeStop.client_order_id] : []), ...(useExchangeTp && exchangeTp?.client_order_id ? [exchangeTp.client_order_id] : [])],
    };
    this.saveThread(thread);
    this.log('warn', 'thread', `${symbol} 接管外部持仓:${pos.side} ${pos.qty} @ ${pos.entry_price},止损 ${stopPrice}${useExchangeStop ? '(交易所已挂)' : '(待挂)'}${tp ? `,止盈 ${tp}${useExchangeTp ? '(交易所已挂)' : '(待挂)'}` : ''}`, { thread_id: thread.id });
    this.activity('thread_opened', { symbol, thread_id: thread.id, episode_id: null, level: 'warn', title: `${symbol} 持仓已交给 agent 接管`, detail: `${pos.side === 'long' ? '做多' : '做空'} ${pos.qty} @ ${pos.entry_price},止损 ${stopPrice}${tp ? `,止盈 ${tp}` : ''};之后按线程复查` });
    if (!useExchangeStop || (tp && !useExchangeTp)) {
      // 没有交易所止损(或人给了新止损):先撤掉该币旧的条件单再挂,免得同向 closePosition 冲突(-4130)
      if (!useExchangeStop && this.backend.listAlgoOrders && this.backend.cancelAlgoOrder) {
        const stale = await this.backend.listAlgoOrders(symbol);
        for (const o of stale ?? []) await this.backend.cancelAlgoOrder(symbol, o.client_algo_id);
      }
      await this.placeProtection(thread, '接管持仓');
      thread = this.store.thread(thread.id) ?? thread;
    }
    this.emit('thread.changed', thread);
    await this.pollAccount();
    return thread;
  }

  // ------------------------------------------------------------ manual orders (order panel)

  async manualOrder(req: ManualOrderRequest): Promise<{ thread: StrategyThread | null; intent: DemoIntent | null; message: string }> {
    if (this.halted) throw Object.assign(new Error('紧急停止中,不接受下单'), { status: 409 });
    const symbol = req.symbol.toUpperCase();
    const market = this.markets.get(symbol) ?? (await fetchMarketView(symbol, this.workflow.timeframe));
    this.markets.set(symbol, market);
    if (req.action === 'close') {
      const t = this.openThreads().find((x) => x.symbol === symbol);
      if (t) {
        if (t.side !== req.side) throw Object.assign(new Error(`${symbol} 的线程方向是 ${t.side === 'long' ? '多' : '空'},与请求不符`), { status: 409 });
        await this.closeThreadNow(t, null, '手动平仓');
        return { thread: this.store.thread(t.id), intent: null, message: '已平仓' };
      }
      const pos = this.account?.positions.find((p) => p.symbol === symbol);
      if (!pos) throw Object.assign(new Error(`${symbol} 没有持仓`), { status: 409 });
      if (pos.side !== req.side) throw Object.assign(new Error(`${symbol} 持仓方向是 ${pos.side === 'long' ? '多' : '空'},与请求不符`), { status: 409 });
      await this.backend.cancelAll(symbol);
      const r = await this.backend.closePosition(symbol, `tgd-manual-${Date.now().toString(36).slice(-6)}`);
      if (r.error) throw Object.assign(new Error(r.error), { status: 502 });
      await this.pollAccount();
      return { thread: null, intent: null, message: '已平掉外部持仓' };
    }
    const maxLev = WORKFLOW_BOUNDS.leverage[1];
    const leverage = Math.max(1, Math.round(req.leverage ?? this.workflow.leverage));
    if (leverage > maxLev) throw Object.assign(new Error(`杠杆最高 ${maxLev}x`), { status: 400 });
    if (!req.sl) throw Object.assign(new Error('手动开仓必须带止损'), { status: 400 });
    const ref = req.type === 'limit' && req.price ? Number(req.price) : Number(market.mark);
    const rules = await this.backend.symbolRules(symbol);
    const step = Number(rules.step_size) || 0.001;
    const decimals = Math.max(0, (rules.step_size.split('.')[1] ?? '').replace(/0+$/, '').length);
    let qtyNum = req.qty ? Number(req.qty) : req.margin_usdt ? (Number(req.margin_usdt) * leverage) / ref : 0;
    qtyNum = Math.floor(qtyNum / step + 1e-9) * step;
    const qty = qtyNum.toFixed(decimals);
    if (!(qtyNum > 0)) throw Object.assign(new Error('数量为 0:请填保证金或数量'), { status: 400 });
    if (qtyNum * ref < Number(rules.min_notional)) throw Object.assign(new Error(`名义 ${(qtyNum * ref).toFixed(2)} USDT 低于交易所最小 ${rules.min_notional}`), { status: 400 });
    if (req.sl) {
      const ok = req.side === 'long' ? Number(req.sl) < ref : Number(req.sl) > ref;
      if (!ok) throw Object.assign(new Error('止损价在入场价的错误一侧'), { status: 400 });
    }
    if (req.tp) {
      const ok = req.side === 'long' ? Number(req.tp) > ref : Number(req.tp) < ref;
      if (!ok) throw Object.assign(new Error('止盈价在入场价的错误一侧'), { status: 400 });
    }
    const account = this.account ?? (await this.backend.account());
    const maxNotional = Number(account.equity) * this.gatesCfg.max_notional_multiple;
    if (qtyNum * ref > maxNotional) throw Object.assign(new Error(`名义 ${(qtyNum * ref).toFixed(2)} USDT 超过上限(权益 × ${this.gatesCfg.max_notional_multiple} = ${maxNotional.toFixed(2)})`), { status: 400 });
    const blockers = this.preflightOpen(symbol, account);
    if (blockers.length) throw Object.assign(new Error(`不能开仓:${blockers.join(';')}`), { status: 409 });
    const thread = newThread({
      id: id('thr'),
      backend: this.backend.kind,
      symbol,
      side: req.side,
      source: 'manual',
      timeframe: this.workflow.timeframe,
      thesis: '手动下单',
      invalidation_text: null,
      watch_conditions: [],
      entry: { type: req.type, price: req.type === 'limit' ? (req.price ?? null) : null, zone: null },
      stop_price: req.sl ?? null,
      take_profits: req.tp ? [req.tp] : [],
      qty,
      margin_usdt: req.margin_usdt ?? ((qtyNum * ref) / leverage).toFixed(2),
      leverage,
      margin_mode: req.margin_mode ?? this.workflow.margin_mode,
      now: Date.now(),
    });
    this.saveThread(thread);
    const intent = this.newIntent(null, thread, 'user', { kind: 'open', direction: req.side, quantity: qty, entry: req.type, limit_price: req.type === 'limit' ? (req.price ?? null) : null, stop_price: req.sl ?? null, take_profit_price: req.tp ?? null, sizing: { equity: this.account?.equity ?? '0', risk_pct: '0', risk_usdt: '0', stop_distance: '0', raw_qty: qty, step_size: rules.step_size, note: `手动:保证金 ${thread.margin_usdt} × ${leverage}x` } });
    this.log('info', 'exec', `${symbol} 手动下单:${req.side === 'long' ? '做多' : '做空'} ${qty},${req.type === 'market' ? '市价' : `限价 ${req.price}`}${req.sl ? `,止损 ${req.sl}` : ''}${req.tp ? `,止盈 ${req.tp}` : ''}`, { thread_id: thread.id });
    this.activity('manual_order', { symbol, thread_id: thread.id, title: `${symbol} 手动${req.side === 'long' ? '做多' : '做空'} ${qty}(${req.type === 'market' ? '市价' : `限价 ${req.price}`})`, detail: `止损 ${req.sl}${req.tp ? `,止盈 ${req.tp}` : ''},${leverage}x`, data: { side: req.side, qty, type: req.type, price: req.price ?? null, sl: req.sl, tp: req.tp ?? null, leverage } });
    await this.executeOpen(thread, intent, null);
    return { thread: this.store.thread(thread.id), intent: this.store.intent(intent.id), message: '已提交' };
  }

  private symbolsFetchedAt = 0;
  async symbols(): Promise<SymbolInfo[]> {
    if (this.symbolsCache && Date.now() - this.symbolsFetchedAt < 10 * 60_000) return this.symbolsCache;
    this.symbolsCache = await this.backend.symbols();
    this.symbolsFetchedAt = Date.now();
    return this.symbolsCache;
  }

  // ------------------------------------------------------------ chat

  chatStateSummary(): string {
    const a = this.account;
    const ms = this.marketState;
    const th = this.openThreads();
    return [
      `账户:权益 ${a?.equity ?? '?'} USDT,未实现 ${a?.unrealized_pnl ?? '?'},持仓 ${a?.positions.map((p) => `${p.symbol} ${p.side} ${p.qty}@${p.entry_price}(${p.unrealized_pnl})`).join('; ') || '无'}`,
      `行情:${[...this.markets.values()].map((m) => `${m.symbol} ${m.last}`).join(', ')}`,
      `线程:${th.map((t) => `${t.id} ${t.symbol} ${t.side} ${t.status}`).join('; ') || '无'}`,
      `工作流:观察 ${this.workflow.watchlist.join('/')},${this.workflow.timeframe},风险 ${this.workflow.risk_pct}%,杠杆 ${this.workflow.leverage}x,自动执行 ${this.workflow.auto_approve ? '开' : '关'},${this.workflow.paused ? '已暂停' : '运行中'}${this.halted ? ',紧急停止中' : ''}`,
      `队列:${JSON.stringify(this.queue.view())}`,
      ms ? `信息员(${new Date(ms.as_of).toISOString().slice(11, 16)} UTC):${ms.regime}/${ms.bias} ${ms.summary.slice(0, 200)}` : '信息员:还没有总结',
      `待批意图:${this.store.intents(100).filter((i) => i.status === 'pending_approval').length} 条`,
    ].join('\n');
  }

  chatTools(chatSessionId: string | null = null): ChatTools {
    return {
      get_state: () => ({ loop: this.loopView(), workflow: this.workflow, account: this.account, markets: Object.fromEntries(this.markets), market_state: this.marketState, queue: this.queue.view(), daily_loss_pct: this.dailyLossPct().toFixed(2) }),
      list_threads: (a) => (a.status === 'all' ? this.store.threads({ limit: 30 }) : this.openThreads()),
      get_thread: (a) => {
        const t = this.store.thread(a.id);
        return t ? { thread: t, episodes: this.store.episodesForThread(t.id, 10), intents: this.store.intentsForThread(t.id), activity: this.store.activity(30, undefined, t.id) } : { error: 'not found' };
      },
      get_episode: (a) => {
        const e = this.store.episode(a.id);
        if (!e) return { error: 'not found' };
        // The model gets what the judgment saw, not the raw prompt: evidence lines + the judgment + gates.
        return { id: e.id, at: e.at, symbol: e.symbol, thread_id: e.thread_id, trigger: e.trigger, evidence: e.evidence.map((x) => `${x.ref} [${x.label}] ${x.value}${x.stale ? ' (STALE)' : ''}`), judgment: e.judgment, gates: e.gates, reducer: e.reducer, schema_errors: e.schema_errors, error: e.error, model: e.model };
      },
      list_history: (a) => {
        const h = this.history(a.limit ?? 20);
        return { stats: h.stats, threads: h.threads.map((t) => ({ id: t.id, symbol: t.symbol, side: t.side, source: t.source, status: t.status, entry: t.filled_avg_price ?? t.entry.price, exit: t.exit_price, pnl: t.realized_pnl, r: t.r_multiple, hold_ms: t.hold_ms, close_reason: t.close_reason, closed_at: t.closed_at })) };
      },
      propose_thread: async (a) => {
        const symbol = String(a.symbol).toUpperCase();
        const market = this.markets.get(symbol) ?? (await fetchMarketView(symbol, this.workflow.timeframe));
        const account = this.account ?? (await this.backend.account());
        const j: Judgment = { action: 'PROPOSE', direction: a.side, confidence: 0.6, headline: '对话中提议', thesis: a.thesis, reasons: ['用户/agent 对话中提议'], evidence_refs: [], invalidation: null, invalidation_price: a.stop_price, target_price: a.take_profits?.[0] ?? null, watch_conditions: [], proposal: { direction: a.side, entry: a.entry, limit_price: a.limit_price ?? null, entry_zone: null, stop_price: a.stop_price, take_profit_price: a.take_profits?.[0] ?? null, take_profits: a.take_profits ?? [], rationale: a.thesis } };
        const blockers = openingBlockers(this.openThreads(), this.workflow, symbol, this.store.threadOpensSince(utcDayStart(Date.now())), this.dailyLossHit());
        const gates = evaluateGates(j, { halted: this.halted, paused: this.workflow.paused, account: { ...account, positions: account.positions.filter((p) => p.symbol === symbol) }, market, opens_today: 0, stale_refs: new Set() }, { ...this.gatesCfg, risk_pct: Number(this.workflow.risk_pct) });
        const failed = [...gates.filter((g) => !g.passed).map((g) => `${g.name}:${g.reason}`), ...blockers];
        if (failed.length) return { accepted: false, blocked_by: failed };
        const ep: Episode = { id: id('ep'), at: Date.now(), as_of: Date.now(), symbol, thread_id: null, trigger: { kind: 'chat', detail: '对话中提议' }, strategy_before: { state: 'researching', version: 0 }, evidence: [], context_text: '', context_hash: '', prompt_version: PROMPT_VERSION, model: 'chat', judgment: j, judgment_raw: null, schema_errors: [], reducer: { from: 'researching', to: 'ready', accepted: true, reason: '对话提议' }, gates, intent: null, usage: null, status: 'done', error: null, strategy_after: null };
        this.store.saveEpisode(ep);
        // Chat proposals ALWAYS wait for the user's click, regardless of auto_approve (chat only proposes).
        const thread = await this.openThreadFromProposal(ep, j, account, market, 'chat', { forceApproval: true });
        ep.strategy_after = { state: 'ready', version: 1 };
        this.store.saveEpisode(ep);
        this.emit('episode.finished', summarize(ep));
        this.activity('chat_action', { symbol, thread_id: thread.id, episode_id: ep.id, title: `对话中提议 ${symbol} ${a.side === 'long' ? '做多' : '做空'},等你确认` });
        return { accepted: true, thread: this.store.thread(thread.id), waiting_for_user: true, note: '已生成待确认的开仓意图,用户在界面上确认后才会下单' };
      },
      close_thread: async (a) => {
        const t = this.store.thread(a.id);
        if (!t || !isOpen(t)) return { error: '线程不存在或已结束' };
        const pos = this.account?.positions.find((p) => p.symbol === t.symbol);
        const intent = this.newIntent(null, t, 'agent', { kind: 'close', direction: t.side, quantity: pos?.qty ?? t.qty, entry: 'market', limit_price: null, stop_price: null, take_profit_price: null, sizing: { equity: this.account?.equity ?? '0', risk_pct: '0', risk_usdt: '0', stop_distance: '0', raw_qty: pos?.qty ?? t.qty, step_size: '0', note: '对话中提议平仓' } });
        this.updateIntent(null, intent, { error: '对话中提议平仓' });
        this.log('info', 'chat', `${t.symbol} 对话提议平仓,等待用户确认`, { intent_id: intent.id, thread_id: t.id });
        this.activity('chat_action', { symbol: t.symbol, thread_id: t.id, level: 'warn', title: `对话中提议平掉 ${t.symbol},等你确认`, data: { intent_id: intent.id } });
        return { needs_confirmation: true, intent_id: intent.id, note: '已生成待确认的平仓意图,用户在界面上确认后才会平仓' };
      },
      set_workflow: (a) => {
        // v3.10:三档(confirm.ts splitWorkflowPatch)。`cli_commands`/风险/杠杆/上限/自动执行/执行通道永远拒。
        const { direct, proposal, refused } = splitWorkflowPatch(a.patch ?? {});
        const applied = Object.keys(direct).length ? this.setWorkflow(direct) : null;
        if (applied && Object.keys(direct).length) this.activity('chat_action', { title: `对话中改了工作流:${Object.keys(direct).join('、')}`, detail: applied.errors.length ? applied.errors.join('; ') : null });
        const p = Object.keys(proposal).length ? this.proposeWorkflow(proposal, { session_id: chatSessionId }) : null;
        return {
          applied_keys: Object.keys(direct),
          errors: applied?.errors ?? [],
          proposal: p ? { id: p.id, status: p.status, keys: Object.keys(p.patch), before: p.before, after: p.after, errors: p.errors, note: p.status === 'pending' ? '已生成设置提议卡,用户在界面上点确认才生效' : `提议无效:${p.errors.join('; ')}` } : null,
          refused_keys: refused,
          note: refused.length ? '风险/杠杆/上限/自动执行/执行通道只能由用户在界面上改' : undefined,
        };
      },
      run_scan: (a) => ({ queued: a.symbol ? this.scan(String(a.symbol).toUpperCase(), { kind: 'chat', detail: '对话中要求扫描' }) : this.scanAll({ kind: 'chat', detail: '对话中要求扫描' }) }),
      run_info: () => ({ queued: this.runInfoNow('对话') }),
      run_review: (a) => ({ queued: this.reviewThread(a.id, { kind: 'chat', detail: '对话中要求复查' }) }),
      get_screen: (a) => {
        const h = a.horizon ?? 'short';
        const sc = this.store.screens.latest(h);
        return sc ? { screen: { id: sc.id, horizon: sc.horizon, finished_at: sc.finished_at, symbols: sc.symbols.length, proposal: sc.proposal, cost_cny: sc.cost_cny }, candidates: this.store.screens.candidates(sc.id, 12).map((c) => ({ rank: c.rank, symbol: c.symbol, strategy_id: c.strategy_id, fit_score: c.fit_score, reasons: c.reasons })) , schedule: this.radar.schedule() } : { screen: null, schedule: this.radar.schedule() };
      },
      run_screen: async (a) => {
        const h = a.horizon ?? 'short';
        if (this.radar.isRunning(h)) return { started: false, reason: '该周期筛选正在进行' };
        void this.radar.run(h, 'manual').catch(() => {});
        return { started: true, horizon: h, note: this.workflow.paused ? '已暂停:这次不调模型,只用确定性排名' : null };
      },
      list_intents: (a) => this.store.intents(100).filter((i) => !a.status || i.status === a.status).slice(0, 20).map((i) => ({ id: i.id, status: i.status, kind: i.kind, symbol: i.symbol, direction: i.direction, quantity: i.quantity, entry: i.entry, limit_price: i.limit_price, stop_price: i.stop_price, take_profit_price: i.take_profit_price, principal: i.principal, at: i.at, error: i.error })),
      // By default the agent may approve its own intent; turning on chat_requires_approval makes it push a
      // confirmation card to the UI instead, so a human clicks.
      approve_intent: async (a) => {
        const it = this.store.intents(200).find((i) => i.id === a.id);
        if (!it) return { error: '没有这条意图' };
        if (it.status !== 'pending_approval') return { error: `意图状态是 ${it.status},只能批准 pending_approval 的` };
        if (this.workflow.chat_requires_approval) {
          this.activity('chat_action', { symbol: it.symbol, level: 'warn', title: `${it.symbol} ${it.kind === 'open' ? (it.direction === 'long' ? '开多' : '开空') : '平仓'}意图等你在界面上确认执行(设置要求人批)`, detail: `数量 ${it.quantity},止损 ${it.stop_price ?? '无'}`, data: { intent_id: it.id, confirm: 'ui' } });
          this.emit('intent.changed', it);
          return { needs_confirmation: true, intent_id: it.id, note: '设置里开了「对话执行需人批」:确认卡已推到界面,用户点了才会下单' };
        }
        try {
          const r = await this.approveIntent(String(a.id), null, { by: 'agent' });
          this.activity('chat_action', { symbol: r.symbol, level: 'warn', title: `对话中批准了 ${r.symbol} ${r.kind === 'open' ? (r.direction === 'long' ? '开多' : '开空') : '平仓'}意图`, data: { intent_id: r.id } });
          return { id: r.id, status: r.status, error: r.error };
        } catch (e) {
          return { error: (e as Error).message };
        }
      },
      reject_intent: (a) => {
        try {
          const r = this.rejectIntent(String(a.id));
          this.activity('chat_action', { symbol: r.symbol, title: `对话中否决了 ${r.symbol} 的意图`, data: { intent_id: r.id } });
          return { id: r.id, status: r.status };
        } catch (e) {
          return { error: (e as Error).message };
        }
      },
      request_execution: (a) => {
        const it = this.store.intents(200).find((i) => i.id === a.id);
        if (!it) return { error: '没有这条意图' };
        if (it.status !== 'pending_approval') return { error: `意图状态是 ${it.status},只有 pending_approval 的才能请求确认` };
        this.activity('chat_action', { symbol: it.symbol, level: 'warn', title: `${it.symbol} ${it.kind === 'open' ? (it.direction === 'long' ? '开多' : '开空') : '平仓'}意图等你在界面上确认执行`, detail: `数量 ${it.quantity},止损 ${it.stop_price ?? '无'}`, data: { intent_id: it.id, confirm: 'ui' } });
        this.emit('intent.changed', it);
        return { needs_confirmation: true, intent_id: it.id, symbol: it.symbol, direction: it.direction, quantity: it.quantity, stop_price: it.stop_price, note: '确认卡已推到界面;用户点「执行」(取一次性 token)后才会下单,你不能替他点' };
      },
    };
  }

  sendChat(text: string, session: string | null = null): { queued: boolean } {
    const sid = session ?? 'default';
    const sess = this.store.chatSession(sid);
    const queued = this.queue.enqueue(
      {
      key: `chat:${Date.now()}`,
      kind: 'chat',
      symbol: null,
      run: async () => {
        try {
          await runChatTurn(
            {
              brain: () => this.mainBrain(),
              tools: this.chatTools(sid),
              session_id: sid,
              can_execute: sess?.can_execute ?? false,
              role: sess?.role ?? null,
              stateSummary: () => this.chatStateSummary(),
              history: () => this.store.chat(30, 'chat', sid),
              save: (m) => this.store.saveChat(m),
              emit: (m: ChatMessage) => this.emit('chat.message', m),
              log: (l, m) => this.log(l, 'chat', m),
            },
            text,
          );
        } catch (e) {
          const err: ChatMessage = { id: id('msg'), at: Date.now(), role: 'system', text: `回复失败:${(e as Error).message}`, tool_calls: [], episode_id: null, kind: 'chat', session_id: sid };
          this.store.saveChat(err);
          this.emit('chat.message', err);
        }
      },
      },
      { priority: true }, // the user's turn jumps the scan queue (never interrupts the running job)
    );
    return { queued };
  }

  // ------------------------------------------------------------ history (design notes)

  history(limit = 200): HistoryResponse {
    const rows = this.store.closedThreads(limit, this.backend.kind);
    const threads: HistoryThreadRow[] = rows.map((t) => {
      const pnl = t.realized_pnl !== null && t.realized_pnl !== undefined ? Number(t.realized_pnl) : 0;
      const entry = t.filled_avg_price ? Number(t.filled_avg_price) : t.entry.price ? Number(t.entry.price) : null;
      const stop = t.stop_price ? Number(t.stop_price) : null;
      const risk = entry !== null && stop !== null ? Math.abs(entry - stop) * Number(t.qty) : null;
      const start = t.opened_at ?? t.created_at;
      return { ...t, hold_ms: Math.max(0, (t.closed_at ?? t.updated_at) - start), pnl_num: Number.isFinite(pnl) ? pnl : 0, exit_price: t.exit_price ?? null, episode_count: this.store.episodeCountForThread(t.id), r_multiple: risk && risk > 0 && t.status === 'closed' ? Math.round((pnl / risk) * 100) / 100 : null };
    });
    const closed = threads.filter((t) => t.status === 'closed');
    const wins = closed.filter((t) => t.pnl_num > 0);
    const losses = closed.filter((t) => t.pnl_num < 0);
    const sum = (xs: HistoryThreadRow[]): number => xs.reduce((a, b) => a + b.pnl_num, 0);
    const grossWin = sum(wins);
    const grossLoss = -sum(losses);
    const group = <K extends string>(key: (t: HistoryThreadRow) => K): Map<K, HistoryThreadRow[]> => {
      const m = new Map<K, HistoryThreadRow[]>();
      for (const t of closed) {
        const k = key(t);
        m.set(k, [...(m.get(k) ?? []), t]);
      }
      return m;
    };
    const best = closed.length ? closed.reduce((a, b) => (b.pnl_num > a.pnl_num ? b : a)) : null;
    const worst = closed.length ? closed.reduce((a, b) => (b.pnl_num < a.pnl_num ? b : a)) : null;
    const stats: HistoryResponse['stats'] = {
      count: closed.length,
      wins: wins.length,
      losses: losses.length,
      flat: closed.length - wins.length - losses.length,
      win_rate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 1000 : 0,
      total_pnl: sum(closed).toFixed(2),
      avg_pnl: closed.length ? (sum(closed) / closed.length).toFixed(2) : '0.00',
      avg_hold_ms: closed.length ? Math.round(closed.reduce((a, b) => a + b.hold_ms, 0) / closed.length) : 0,
      profit_factor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
      best: best ? { thread_id: best.id, symbol: best.symbol, pnl: best.pnl_num.toFixed(2) } : null,
      worst: worst ? { thread_id: worst.id, symbol: worst.symbol, pnl: worst.pnl_num.toFixed(2) } : null,
      by_symbol: [...group((t) => t.symbol)].map(([symbol, xs]) => ({ symbol, count: xs.length, wins: xs.filter((x) => x.pnl_num > 0).length, pnl: sum(xs).toFixed(2) })).sort((a, b) => Number(b.pnl) - Number(a.pnl)),
      by_source: [...group((t) => t.source)].map(([source, xs]) => ({ source, count: xs.length, pnl: sum(xs).toFixed(2) })),
      by_close_reason: [...group((t) => (t.close_reason ?? '未知').replace(/\s*@.*$/, '').slice(0, 12))].map(([reason, xs]) => ({ reason, count: xs.length, pnl: sum(xs).toFixed(2) })).sort((a, b) => b.count - a.count),
    };
    return { stats, threads, equity: this.store.equity(2000, this.backend.kind) };
  }
}
