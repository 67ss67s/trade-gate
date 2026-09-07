// v3.3: runtime backend switching (§9.6) and the daily judgment cap (§9.7), end to end against a real
// DemoRuntime (in-memory sqlite, PaperBackend, stub brain, fake market server) plus the HTTP surface.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type ExecBackend, type OrderReceipt, type OrderStatusView, type PaperEvent } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { AccountView, Backend, Episode, StrategyThread } from '../../src/demo/types.js';
import type { TerminalOpener } from '../../src/demo/execution-agent.js';

let fakeMarket: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
  ({ createServer } = await import('../../src/demo/http.js'));
});
afterAll(async () => {
  await fakeMarket.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});

type RT = InstanceType<typeof DemoRuntime>;

/** A backend that records lifecycle calls, so a switch can be observed without any exchange or CLI. */
class SpyBackend implements ExecBackend {
  started = 0;
  stopped = 0;
  constructor(readonly kind: Backend) {}
  async start(): Promise<void> {
    this.started++;
  }
  async stop(): Promise<void> {
    this.stopped++;
  }
  async account(): Promise<AccountView> {
    return { backend: this.kind, equity: '5000.00', available: '5000.00', unrealized_pnl: '0.00', positions: [], open_orders: [], as_of: Date.now() };
  }
  async symbolRules(): Promise<{ step_size: string; tick_size: string; min_qty: string; min_notional: string }> {
    return { step_size: '0.001', tick_size: '0.1', min_qty: '0.001', min_notional: '5' };
  }
  async markPrice(): Promise<string> {
    return '77050';
  }
  async placeEntry(): Promise<OrderReceipt> {
    return { outcome: 'failed', receipt: null, avg_price: null, error: 'spy' };
  }
  async placeStop(): Promise<OrderReceipt> {
    return { outcome: 'failed', receipt: null, avg_price: null, error: 'spy' };
  }
  async placeTakeProfit(): Promise<OrderReceipt> {
    return { outcome: 'failed', receipt: null, avg_price: null, error: 'spy' };
  }
  async closePosition(): Promise<{ closed: boolean; receipt: unknown; error: string | null }> {
    return { closed: false, receipt: null, error: null };
  }
  async reducePosition(): Promise<OrderReceipt> {
    return { outcome: 'failed', receipt: null, avg_price: null, error: 'spy' };
  }
  async cancelAll(): Promise<{ ok: boolean; error: string | null }> {
    return { ok: true, error: null };
  }
  async cancelOrder(): Promise<{ ok: boolean; error: string | null }> {
    return { ok: true, error: null };
  }
  async getOrder(): Promise<OrderStatusView | null> {
    return null;
  }
  async setLeverage(): Promise<{ ok: boolean; error: string | null }> {
    return { ok: true, error: null };
  }
  async setMarginType(): Promise<{ ok: boolean; error: string | null }> {
    return { ok: true, error: null };
  }
  async symbols(): Promise<[]> {
    return [];
  }
  tick(): PaperEvent[] {
    return [];
  }
}

let activeHttp: http.Server | null = null;
let activeRt: RT | null = null;
let activeState: StateDb | null = null;
let baseUrl = '';
let spy: SpyBackend;

async function setup(opts: { openTerminal?: TerminalOpener } = {}): Promise<{ rt: RT; store: DemoStore }> {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  spy = new SpyBackend('cli');
  const rt = new DemoRuntime({
    store,
    backend: new PaperBackend(10_000),
    backends: { cli: () => spy },
    brains: { stub: stubBrain() },
    marketPollMs: 600_000,
    accountPollMs: 600_000,
  });
  await rt.start();
  // codex short-circuits the MCP probe (login blocked upstream), so no CLI is ever spawned in tests.
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], exec_agent_cli: 'codex' });
  const httpServer = createServer(rt, store, opts.openTerminal ? { openTerminal: opts.openTerminal } : {});
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  activeHttp = httpServer;
  activeRt = rt;
  activeState = state;
  return { rt, store };
}

afterEach(async () => {
  if (activeHttp) {
    activeHttp.closeAllConnections?.();
    await new Promise<void>((r) => activeHttp!.close(() => r()));
  }
  if (activeRt) await activeRt.stop();
  activeState?.close();
  activeHttp = null;
  activeRt = null;
  activeState = null;
});

function get(p: string): Promise<Response> {
  return fetch(`${baseUrl}${p}`);
}
function post(p: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function openThread(store: DemoStore): StrategyThread {
  const t: StrategyThread = {
    id: 'th-open-1', symbol: 'BTCUSDT', side: 'long', status: 'in_position', source: 'agent', timeframe: '15m', thesis: '测试', invalidation_text: null, watch_conditions: [],
    entry: { type: 'market', price: null, zone: null }, stop_price: '70000', take_profits: [], qty: '0.01', margin_usdt: null, leverage: 3, margin_mode: 'cross',
    entry_client_order_id: 'tgd-x', protection_client_order_ids: [], filled_avg_price: '77000', realized_pnl: null, close_reason: null, attention: null,
    entry_lookup_misses: 0, leg_seq: 1, episode_ids: [], intent_ids: [], created_at: Date.now(), updated_at: Date.now(), opened_at: Date.now(), closed_at: null, version: 1,
  };
  store.saveThread(t);
  return t;
}

function fakeEpisode(store: DemoStore, i: number, model = 'pi:zai/glm-5.3', input = 1000, output = 200): void {
  const at = Date.now() - i * 1000;
  const ep: Episode = {
    id: `ep-fake-${i}`, at, as_of: at, symbol: 'BTCUSDT', thread_id: null, trigger: { kind: 'manual', detail: '测试' },
    strategy_before: { state: 'researching', version: 0 }, evidence: [], context_text: '', context_hash: '', prompt_version: 'v', model,
    judgment: null, judgment_raw: null, schema_errors: [], reducer: null, gates: [], intent: null,
    usage: { input_tokens: input, output_tokens: output, latency_ms: 10, cost_estimate: 'n/a' },
    status: 'done', error: null, strategy_after: null,
  };
  store.saveEpisode(ep);
}

describe('execution backend switching (§9.6)', () => {
  it('workflow.execution names the backend actually running at boot', async () => {
    const { rt } = await setup();
    expect(rt.workflow.execution).toBe('paper');
    expect(rt.loopView().backend).toBe('paper');
    // setWorkflow alone can never lie about it
    const r = rt.setWorkflow({ execution: 'cli' });
    expect(r.workflow.execution).toBe('paper');
  });

  it('switches with a clean book: old backend stopped, new one started, account refreshed, event emitted', async () => {
    const { rt } = await setup();
    const seen: unknown[] = [];
    rt.on('execution.changed', (v) => seen.push(v));
    const err = await rt.switchBackend('cli');
    expect(err).toBeNull();
    expect(rt.backend.kind).toBe('cli');
    expect(spy.started).toBe(1);
    expect(rt.workflow.execution).toBe('cli');
    expect(rt.account?.backend).toBe('cli');
    expect(rt.account?.equity).toBe('5000.00');
    expect(seen).toHaveLength(1);
  });

  it('refuses to switch while a thread is open, and leaves the workflow field untouched', async () => {
    const { rt, store } = await setup();
    openThread(store);
    expect(rt.switchBlocker()).toContain('BTCUSDT');
    const err = await rt.switchBackend('cli');
    expect(err).toContain('先平掉');
    expect(rt.backend.kind).toBe('paper');
    expect(spy.started).toBe(0);

    const r = await rt.applyWorkflow({ execution: 'cli', risk_pct: '0.7' });
    expect(r.errors.join(';')).toContain('先平掉');
    expect(r.workflow.execution).toBe('paper');
    expect(r.workflow.risk_pct).toBe('0.7'); // the rest of the patch still applies
  });

  it('refuses to switch while an order is state-unknown', async () => {
    const { rt, store } = await setup();
    store.saveIntent({ id: 'in-1', episode_id: 'ep-1', thread_id: null, principal: 'agent', at: Date.now(), kind: 'open', symbol: 'BTCUSDT', direction: 'long', quantity: '0.01', entry: 'market', limit_price: null, stop_price: null, take_profit_price: null, sizing: { equity: '1', risk_pct: '1', risk_usdt: '1', stop_distance: '1', raw_qty: '1', step_size: '1', note: '' }, status: 'unknown', client_order_id: 'tgd-u', backend: 'paper', receipts: [], error: null });
    expect(await rt.switchBackend('cli')).toContain('状态不明');
  });

  it('refuses an unregistered backend', async () => {
    const { rt } = await setup();
    expect(await rt.switchBackend('agent_mcp')).toContain('没注册');
    expect(rt.backend.kind).toBe('paper');
  });

  it('POST /api/workflow switches the backend and reports the new one', async () => {
    const { rt } = await setup();
    const res = await post('/api/workflow', { execution: 'cli' });
    const body = (await res.json()) as { workflow: { execution: string }; errors: string[] };
    expect(body.errors).toEqual([]);
    expect(body.workflow.execution).toBe('cli');
    expect(rt.backend.kind).toBe('cli');
  });

  it('GET /api/execution has the documented shape', async () => {
    await setup();
    const body = (await (await get('/api/execution')).json()) as {
      backend: string;
      options: { kind: string; label: string; available: boolean; note: string }[];
      agent: { cli: string; model: string | null; model_note: string | null; server_name: string; url: string };
      connection: { status: string; checked_at: number | null; detail: string };
      can_switch: boolean;
      switch_blocker: string | null;
    };
    expect(body.backend).toBe('paper');
    expect(body.options.map((o) => o.kind)).toEqual(['paper', 'demo', 'cli', 'agent_mcp']);
    expect(body.options.find((o) => o.kind === 'paper')!.available).toBe(true);
    expect(body.options.find((o) => o.kind === 'cli')!.available).toBe(true);
    expect(body.options.find((o) => o.kind === 'demo')!.available).toBe(false);
    // model 默认就是 sonnet(workflow 默认值,便宜);model_note 只对 claude 有意义
    // `command`/`resolved` = 这台机器上真正会执行的启动命令(默认裸命令名),见 cli-launch.ts
    expect(body.agent).toEqual({
      cli: 'codex',
      model: 'sonnet',
      model_note: null,
      server_name: 'binance-mcp-server',
      url: 'https://agent.binance.com/mcp/agentic',
      command: 'codex',
      resolved: expect.objectContaining({ via: expect.stringMatching(/^(direct|shell)$/) }),
    });
    expect(body.connection.status).toBe('unavailable'); // codex login blocked upstream
    expect(typeof body.connection.checked_at).toBe('number');
    expect(body.can_switch).toBe(true);
    expect(body.switch_blocker).toBeNull();

    const forced = (await (await post('/api/execution/check')).json()) as { connection: { status: string } };
    expect(forced.connection.status).toBe('unavailable');

    const conn = (await (await post('/api/execution/connect')).json()) as { started: boolean; instructions: string };
    expect(conn.started).toBe(false);
    expect(conn.instructions).toContain('CIMD');
  });

});

describe('daily judgment cap (§9.7)', () => {
  it('skips scans / reviews / the information officer once today’s episodes reach the cap', async () => {
    const { rt, store } = await setup();
    rt.setWorkflow({ daily_judgment_cap: 3 });
    for (let i = 0; i < 3; i++) fakeEpisode(store, i);
    expect(rt.judgmentsToday()).toBe(3);

    expect(rt.scan('BTCUSDT', { kind: 'manual', detail: '测试' })).toBe(false);
    expect(rt.scanAll({ kind: 'manual', detail: '测试' })).toBe(0);
    expect(rt.runInfoNow('测试')).toBe(false);
    const t = openThread(store);
    expect(rt.reviewThread(t.id, { kind: 'manual', detail: '测试' })).toBe(false);
    expect(rt.queueView().pending).toBe(0);

    // one notice per 10 minutes, however many triggers were skipped
    const notices = store.activity(50).filter((a) => a.kind === 'cap_reached');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain('3');
    expect(store.logs(200).filter((l) => l.scope === 'cap')).toHaveLength(1);
  });

  it('cap 0 = unlimited, and a cap above today’s count lets the scan through', async () => {
    const { rt, store } = await setup();
    for (let i = 0; i < 5; i++) fakeEpisode(store, i);
    rt.setWorkflow({ daily_judgment_cap: 0 });
    expect(rt.usageToday().capped).toBe(false);
    expect(rt.scan('BTCUSDT', { kind: 'manual', detail: '测试' })).toBe(true);
    rt.setWorkflow({ daily_judgment_cap: 50 });
    expect(rt.runInfoNow('测试')).toBe(true);
  });

  it('chat replies are never capped', async () => {
    const { rt, store } = await setup();
    rt.setWorkflow({ daily_judgment_cap: 1 });
    fakeEpisode(store, 0);
    expect(rt.scan('BTCUSDT', { kind: 'manual', detail: '测试' })).toBe(false);
    expect(rt.sendChat('还好吗?').queued).toBe(true);
  });

  it('usage_today sums today’s episodes and estimates the CNY spend', async () => {
    const { rt, store } = await setup();
    for (let i = 0; i < 4; i++) fakeEpisode(store, i, 'pi:zai/glm-5.3', 250_000, 50_000);
    rt.setWorkflow({ daily_judgment_cap: 4 });
    const u = rt.usageToday();
    expect(u).toEqual({ judgments: 4, input_tokens: 1_000_000, output_tokens: 200_000, est_cny: 3.6, cap: 4, capped: true });

    const body = (await (await get('/api/overview')).json()) as { usage_today: typeof u };
    expect(body.usage_today).toEqual(u);
  });

  it('subscription CLIs have no per-token price → est_cny is null, tokens still counted', async () => {
    const { rt, store } = await setup();
    fakeEpisode(store, 0, 'claude:sonnet', 8000, 900);
    const u = rt.usageToday();
    expect(u.judgments).toBe(1);
    expect(u.input_tokens).toBe(8000);
    expect(u.est_cny).toBeNull();
  });
});

// POST /api/execution/connect:币安拒绝网关自己的 OAuth 客户端(3346001),所以「连接」= 弹一个终端
// 让人在 claude 里走一次 /mcp。网关不读任何凭证,只负责把窗口弹出来。
describe('execution connect(弹终端跑 claude /mcp)', () => {
  it('claude:调用注入的 opener,命令里带 claude,返回 started:true', async () => {
    const seen: string[] = [];
    const { rt } = await setup({ openTerminal: (cmd) => (seen.push(cmd), { ok: true, error: null }) });
    rt.setWorkflow({ exec_agent_cli: 'claude' });
    const body = (await (await post('/api/execution/connect')).json()) as { started: boolean; instructions: string; url?: string };
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('claude');
    expect(seen[0]).toContain('/mcp');
    expect(body.started).toBe(true);
    expect(body.instructions).toContain('binance-mcp-server');
    expect(body.url).toBeUndefined(); // 网关自己的 OAuth 路已经封掉,不再返回同意页 URL
  });

  it('opener 失败(非 macOS / osascript 报错)→ started:false + 手动步骤', async () => {
    const { rt } = await setup({ openTerminal: () => ({ ok: false, error: 'osascript 退出码 1' }) });
    rt.setWorkflow({ exec_agent_cli: 'claude' });
    const body = (await (await post('/api/execution/connect')).json()) as { started: boolean; instructions: string; detail: string | null };
    expect(body.started).toBe(false);
    expect(body.instructions).toContain('/mcp');
    expect(body.detail).toContain('osascript');
  });

  it('codex:不弹终端,只解释为什么登不上', async () => {
    let opened = false;
    const { rt } = await setup({
      openTerminal: () => {
        opened = true;
        return { ok: true, error: null };
      },
    });
    rt.setWorkflow({ exec_agent_cli: 'codex' });
    const body = (await (await post('/api/execution/connect')).json()) as { started: boolean; instructions: string };
    expect(opened).toBe(false);
    expect(body.started).toBe(false);
    expect(body.instructions).toContain('Dynamic client registration');
  });
});
