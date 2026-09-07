// v3.11 (§9.20): the gateway verifies its own protective leg with a canary and unblocks itself — no env var, no restart.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type OpenWithProtectionReceipt, type OpenWithProtectionRequest, type ProtectionCapability } from '../../src/demo/execution.js';
import { newThread } from '../../src/demo/threads.js';
import { stubBrain } from '../../src/demo/brain.js';
import type { Backend } from '../../src/demo/types.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
});
afterAll(async () => {
  await fakeMarket.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});

/** Paper simulator wearing the agent_mcp hat: unverified until a canary passes; algo query/cancel are scriptable. */
class FakeAgentBackend extends PaperBackend {
  override readonly kind = 'agent_mcp' as Backend;
  algoSeen: boolean | null = true;
  cancelOk = true;
  protectionCapability(): ProtectionCapability {
    return 'unverified';
  }
  async openWithProtection(req: OpenWithProtectionRequest): Promise<OpenWithProtectionReceipt> {
    const entry = await this.placeEntry(req);
    const stop = await this.placeStop(req.symbol, req.direction, req.stop_price, req.stop_client_algo_id);
    return { entry: { ...entry, executed_qty: req.qty, order_id: '1' }, stop: { outcome: stop.outcome === 'failed' ? 'failed' : 'submitted', algo_id: '77', error: stop.error }, tp: { outcome: 'skipped', algo_id: null, error: null } };
  }
  async algoOrderExists(): Promise<boolean | null> {
    return this.algoSeen;
  }
  /** 残留条件单:纸面模拟器里就是这个币的挂单(金丝雀止损也在里面) */
  async listAlgoOrders(symbol: string): Promise<{ client_algo_id: string; algo_id: string | null }[] | null> {
    return (await this.account()).open_orders.filter((o) => o.symbol === symbol).map((o) => ({ client_algo_id: o.client_order_id, algo_id: null }));
  }
  async cancelAlgoOrder(symbol: string, id: string): Promise<{ ok: boolean; error: string | null }> {
    if (!this.cancelOk) return { ok: false, error: 'simulated cancel failure' };
    return this.cancelOrder(symbol, id);
  }
}

let state: StateDb | null = null;
let rt: InstanceType<typeof DemoRuntime> | null = null;
async function setup(): Promise<{ rt: InstanceType<typeof DemoRuntime>; backend: FakeAgentBackend; store: DemoStore }> {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new FakeAgentBackend(10_000);
  rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  return { rt, backend, store };
}
afterEach(async () => {
  if (rt) await rt.stop();
  state?.close();
  rt = null;
  state = null;
});

describe('verifyProtection', () => {
  it('starts unverified, passes the canary, persists the record, unblocks', async () => {
    const { rt, store } = await setup();
    expect(rt.protectionStatus().status).toBe('unverified');
    expect(rt.protectionOk()).toBe(false);
    const st = await rt.verifyProtection({ symbol: 'BTCUSDT' });
    expect(st.status).toBe('verified');
    expect(st.source).toBe('record');
    expect(st.steps.every((s) => s.ok)).toBe(true);
    expect(st.steps.map((s) => s.name)).toEqual(['账户读取', '清旧条件单', '算最小仓', '市价开最小仓', '挂 closePosition 止损', '交易所确认止损挂着', '撤止损', '平仓', '确认已平']);
    expect(JSON.parse(store.kvGet('protection_verified:agent_mcp')!)).toMatchObject({ symbol: 'BTCUSDT' });
    expect(rt.protectionOk()).toBe(true);
    const after = await rt['backend'].account();
    expect(after.positions).toEqual([]);
    expect(after.open_orders).toEqual([]);
  });

  it('a stop the exchange cannot see fails the canary, cleans up (cancel + close), stays blocked with the reason; a live stop failure later invalidates the record', async () => {
    const { rt, backend, store } = await setup();
    backend.algoSeen = false;
    const st = await rt.verifyProtection({ symbol: 'BTCUSDT' });
    expect(st.status).toBe('failed');
    expect(st.last_error).toMatch(/查不到/);
    expect(st.steps.find((s) => s.name === '善后平仓')?.ok).toBe(true);
    expect(rt.protectionOk()).toBe(false);
    expect((await backend.account()).positions).toEqual([]);
    backend.algoSeen = true;
    expect((await rt.verifyProtection({ symbol: 'BTCUSDT' })).status).toBe('verified');
    rt.invalidateProtection('BTCUSDT 线上挂止损失败:schema');
    expect(rt.protectionStatus().status).toBe('failed');
    expect(store.kvGet('protection_verified:agent_mcp')).toBe('');
  });

  it('adopts an ownerless position (e.g. a canary orphaned by a restart) instead of refusing: skips the entry, verifies the stop, closes it', async () => {
    const { rt, backend, store } = await setup();
    // 裸仓:直接在后端开一张,不经过任何线程 —— 就是 09-06 网关重启留下的那种
    const e = await backend.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.001', entry: 'market', limit_price: null, client_order_id: 'orphan-1' });
    expect(e.outcome).toBe('filled');
    // 上次金丝雀残留的止损也还挂着(真实事故里交易所因此拒了新止损 -4130)
    expect((await backend.placeStop('BTCUSDT', 'long', '1', 'tgd-vfy-old-s')).outcome).toBe('submitted');
    expect((await backend.account()).positions.map((p) => p.symbol)).toEqual(['BTCUSDT']);
    const st = await rt.verifyProtection({ symbol: 'BTCUSDT' });
    expect(st.status).toBe('verified');
    expect(st.steps.find((s) => s.name === '账户读取')?.detail).toMatch(/无主持仓/);
    expect(st.steps.find((s) => s.name === '清旧条件单')?.detail).toMatch(/tgd-vfy-old-s/);
    expect(st.steps.find((s) => s.name === '市价开最小仓')?.detail).toMatch(/跳过/);
    expect(st.steps.every((s) => s.ok)).toBe(true);
    expect(JSON.parse(store.kvGet('protection_verified:agent_mcp')!)).toMatchObject({ symbol: 'BTCUSDT', adopted: true, qty: '0.001' });
    expect((await backend.account()).positions).toEqual([]);
  });
});


describe('unknown stop recovery', () => {
  it.each([
    { seen: true, retry: 'submitted', error: null, closed: false, invalidated: false },
    { seen: false, retry: 'submitted', error: null, closed: false, invalidated: false },
    { seen: false, retry: 'failed', error: '-4111', closed: false, invalidated: false },
    { seen: null, retry: 'submitted', error: null, closed: false, invalidated: false },
    { seen: false, retry: 'unknown', error: 'timed out', closed: true, invalidated: false },
    { seen: false, retry: 'failed', error: 'fetch failed', closed: true, invalidated: false },
    { seen: false, retry: 'failed', error: '-2021 Order would immediately trigger.', closed: true, invalidated: true },
    { seen: false, retry: 'failed', error: '-2022 ReduceOnly', closed: true, invalidated: false },
  ] as const)('exists=$seen retry=$retry error=$error', async ({ seen, retry, error, closed, invalidated }) => {
    const { rt, backend, store } = await setup();
    expect((await rt.verifyProtection({ symbol: 'BTCUSDT' })).status).toBe('verified');
    const record = store.kvGet('protection_verified:agent_mcp');
    const thread = { ...newThread({ id: 'thr-transport', backend: 'agent_mcp', symbol: 'BTCUSDT', side: 'long', source: 'manual', timeframe: '15m', thesis: 'test', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '1', take_profits: [], qty: '0.001', margin_usdt: null, leverage: 3, margin_mode: 'cross', now: Date.now() }), status: 'in_position' as const };
    store.saveThread(thread);
    backend.algoSeen = seen;
    const query = vi.spyOn(backend, 'algoOrderExists');
    const plain = vi.spyOn(backend, 'getOrder');
    const resend = vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: retry, error, receipt: null, avg_price: null });
    const close = vi.spyOn(backend, 'closePosition').mockResolvedValue({ closed: true, error: null });
    const invalidate = vi.spyOn(rt, 'invalidateProtection');
    await rt['placeProtection'](thread, 'test', { stop: { id: 'tgd-transport-s1', receipt: { outcome: 'unknown', error: 'Socket connection closed unexpectedly before a response was received; result not confirmed.', receipt: null, avg_price: null } } });
    expect(query).toHaveBeenCalledWith('BTCUSDT', 'tgd-transport-s1');
    expect(plain).not.toHaveBeenCalled();
    expect(resend).toHaveBeenCalledTimes(seen === false ? 1 : 0);
    if (seen === false) expect(resend).toHaveBeenCalledWith('BTCUSDT', 'long', '1', 'tgd-transport-s1');
    expect(close).toHaveBeenCalledTimes(closed ? 1 : 0);
    expect(invalidate).toHaveBeenCalledTimes(invalidated ? 1 : 0);
    expect(store.kvGet('protection_verified:agent_mcp')).toBe(invalidated ? '' : record);
    expect(store.thread(thread.id)?.status).toBe(closed ? 'closed' : 'in_position');
    expect(store.thread(thread.id)?.attention).toBe(seen === null ? 'PROTECTION_MISSING' : null);
    if (!closed && seen !== null) expect(store.thread(thread.id)?.protection_client_order_ids).toContain('tgd-transport-s1');
  });
});
