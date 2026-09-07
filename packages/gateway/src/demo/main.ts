// Entry: `node dist/demo/main.js` (or `npm run demo` in packages/gateway). Config via env:
//   TG_DEMO_PORT=18800  TG_DEMO_BRAIN=claude|codex|pi|stub (initial workflow.brain; default = claude if the CLI is on PATH, else stub)
//   TG_DEMO_BACKEND=auto|paper|demo|cli|agent_mcp (auto = demo iff <state dir>/secrets/apikey-demo.json exists)
//   cli = Agent OS channel: official binance-cli (Skills Hub `binance` skill) with BINANCE_API_ENV=demo and
//         profile TG_DEMO_CLI_PROFILE (default tswarm-demo, created via `binance-cli profile create`)
//   agent_mcp = an agent CLI (TG_EXEC_AGENT_CLI=claude|codex, TG_EXEC_AGENT_MODEL) driving Binance's official
//         MCP server; the CLI owns the OAuth session, the gateway holds nothing. See execution-agent.ts.
//   TG_DEMO_JUDGMENT_CAP=300 (0 = unlimited) initial daily_judgment_cap
//   TG_DEMO_AUTO_APPROVE=1  TG_DEMO_RUN_ON_START=1
//   TG_DEMO_HOME=~/.trading-swarm  state directory (sqlite db + secrets); TG_DEMO_DB overrides the db path alone

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStateDb } from '../state-db.js';
import { defaultBrainKind, stubBrain } from './brain.js';
import { DemoBackend, PaperBackend, defaultDemoExecBin, type ExecBackend } from './execution.js';
import { CliBackend, cliAvailability, defaultBinanceCliBin } from './execution-cli.js';
import { AgentMcpBackend } from './execution-agent.js';
import { loadWorkflow } from './workflow.js';
import type { AgentCliKind, Backend } from './types.js';
import { createServer } from './http.js';
import { DemoRuntime } from './runtime.js';
import { DemoStore } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
/** demo_kv row holding the PaperBackend snapshot. */
const PAPER_STATE_KEY = 'paper_state';

/**
 * Everything this process persists lives under ONE directory, so a fresh checkout never reads (or
 * writes) somebody else's state. Override with TG_DEMO_HOME; defaults to ~/.trading-swarm.
 */
function stateHome(): string {
  return process.env['TG_DEMO_HOME'] || path.join(os.homedir(), '.trading-swarm');
}

async function main(): Promise<void> {
  const port = Number(process.env['TG_DEMO_PORT'] ?? '18800');
  const home = stateHome();
  const dbPath = process.env['TG_DEMO_DB'] ?? path.join(home, 'demo', 'state.sqlite');
  const secretsFile = path.join(home, 'secrets', 'apikey-demo.json');
  const wantBackend = process.env['TG_DEMO_BACKEND'] ?? 'auto';
  const hasDemoKey = existsSync(secretsFile) || (Boolean(process.env['TG_DEMO_API_KEY']) && Boolean(process.env['TG_DEMO_API_SECRET']));
  const state = openStateDb(dbPath);
  const store = new DemoStore(state);
  // auto = whatever channel was last selected in the UI (workflow.execution is persisted); only when
  // nothing was ever selected does the presence of a demo key decide. Without this the process fell back
  // to paper on every restart, so a user who had switched to agent_mcp saw "it went back to simulation".
  const persistedExec = loadWorkflow(store.loadWorkflowJson()).execution;
  const resumable = new Set(['paper', 'demo', 'cli', 'agent_mcp']);
  const backendKind = wantBackend === 'auto' ? (persistedExec && resumable.has(persistedExec) && (persistedExec !== 'demo' || hasDemoKey) ? persistedExec : hasDemoKey ? 'demo' : 'paper') : wantBackend;
  const logFn = (level: 'info' | 'warn' | 'error', message: string, data?: unknown): void => {
    store.log({ at: Date.now(), level, scope: 'demo-exec', message, ...(data === undefined ? {} : { data }) });
    console.error(`${new Date().toISOString()} ${level} [demo-exec] ${message}`);
  };
  // One factory per backend so the UI can switch channels at runtime (v3-ui-contract §9.6). The
  // agent factory reads the LIVE workflow, so changing exec_agent_cli/model then switching picks it up.
  const bootWorkflow = loadWorkflow(store.loadWorkflowJson());
  let rt: DemoRuntime | null = null;
  const agentCli = (): AgentCliKind => (rt?.workflow.exec_agent_cli ?? (process.env['TG_EXEC_AGENT_CLI'] === 'codex' ? 'codex' : bootWorkflow.exec_agent_cli));
  const agentModel = (): string | null => rt?.workflow.exec_agent_model ?? (process.env['TG_EXEC_AGENT_MODEL'] || bootWorkflow.exec_agent_model);
  // The machine-specific launch command for that CLI (alias / env prefix / path), read LIVE like the rest.
  const agentCommand = (): string => (rt?.workflow ?? bootWorkflow).cli_commands[agentCli()];
  const backends: Partial<Record<Backend, () => ExecBackend>> = {
    paper: () =>
      new PaperBackend(Number(process.env['TG_DEMO_PAPER_EQUITY'] ?? '10000'), {
        symbols: 'live',
        // Paper positions/orders/balance survive a restart (design notes); the
        // demo/cli/agent_mcp backends keep their state on the exchange side and need no snapshot.
        persist: { load: () => store.kvGet(PAPER_STATE_KEY), save: (json) => store.kvSet(PAPER_STATE_KEY, json) },
      }),
    demo: () => new DemoBackend(defaultDemoExecBin(REPO_ROOT), logFn),
    cli: () => new CliBackend({ bin: defaultBinanceCliBin(REPO_ROOT), profile: process.env['TG_DEMO_CLI_PROFILE'] ?? 'tswarm-demo', env: 'demo', log: logFn }),
    agent_mcp: () =>
      new AgentMcpBackend({
        cli: agentCli(),
        model: agentModel(),
        command: agentCommand(),
        log: logFn,
        // 没有开放线程也没有待批/进行中的意图 → 账户读用 15 分钟缓存(省 CLI token);有仓位/挂单时回到 5 分钟。
        idle: () => (rt ? rt.openThreads().length === 0 && !rt.store.intents(50).some((i) => i.status === 'pending_approval' || i.status === 'approved' || i.status === 'submitted' || i.status === 'unknown') : false),
      }),
  };
  const backend: ExecBackend = (backends[backendKind as Backend] ?? backends.paper!)();
  const backendGates = {
    // The official binance-cli is an alternative channel; when it is missing (or has no profile) the
    // availability probe carries the setup steps, which executionView() passes to the UI.
    cli: () => cliAvailability(defaultBinanceCliBin(REPO_ROOT), process.env['TG_DEMO_CLI_PROFILE'] ?? 'tswarm-demo'),
  };
  rt = new DemoRuntime({ store, backend, backends, backendGates, brains: { stub: stubBrain() } });
  // Env overrides for the initial workflow (later edits come from the UI and persist in state.sqlite).
  const patch: Record<string, unknown> = {};
  const freshState = store.loadWorkflowJson() === undefined;
  if (process.env['TG_DEMO_BRAIN']) patch['brain'] = process.env['TG_DEMO_BRAIN'];
  else if (freshState) patch['brain'] = patch['cheap_brain'] = defaultBrainKind();
  if (process.env['TG_DEMO_CHEAP_BRAIN']) patch['cheap_brain'] = process.env['TG_DEMO_CHEAP_BRAIN'];
  if (process.env['TG_DEMO_TF']) patch['timeframe'] = process.env['TG_DEMO_TF'];
  if (process.env['TG_DEMO_WATCHLIST']) patch['watchlist'] = process.env['TG_DEMO_WATCHLIST'].split(',');
  if (process.env['TG_DEMO_AUTO_APPROVE']) patch['auto_approve'] = process.env['TG_DEMO_AUTO_APPROVE'] !== '0';
  if (process.env['TG_EXEC_AGENT_CLI']) patch['exec_agent_cli'] = process.env['TG_EXEC_AGENT_CLI'];
  if (process.env['TG_EXEC_AGENT_MODEL']) patch['exec_agent_model'] = process.env['TG_EXEC_AGENT_MODEL'];
  if (process.env['TG_DEMO_JUDGMENT_CAP']) patch['daily_judgment_cap'] = Number(process.env['TG_DEMO_JUDGMENT_CAP']);
  // Showcase preset: everything visible inside ~10 minutes.
  if (process.env['TG_DEMO_SHOWCASE'] === '1') Object.assign(patch, { timeframe: '1m', info_every_ms: 3 * 60_000, narrate: true, scan_mode: 'every_close', review_every_close: true, watchlist: patch['watchlist'] ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'] });
  if (Object.keys(patch).length) {
    const r = rt.setWorkflow(patch);
    if (r.errors.length) console.error('workflow env overrides rejected:', r.errors.join('; '));
  }
  const server = createServer(rt, store);
  server.listen(port, '127.0.0.1', () => console.error(`demo gateway listening on http://127.0.0.1:${port}  (backend=${backend.kind}, brain=${rt.workflow.brain}, db=${dbPath})`));
  await rt.start({ runOnStart: process.env['TG_DEMO_RUN_ON_START'] === '1' });

  const shutdown = async (): Promise<void> => {
    console.error('shutting down');
    server.close();
    await rt.stop();
    state.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
