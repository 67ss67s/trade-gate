// runtime.ts: DemoRuntime end-to-end against an in-memory sqlite store, PaperBackend, a scripted
// stub brain, and a local fake market server. TG_DEMO_MARKET_BASE is set BEFORE dynamic-importing
// runtime.ts (and everything it statically imports, including market.ts/info.ts, which read the
// env var as a module-level const).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { Judgment, Trigger } from '../../src/demo/types.js';

let server: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;

beforeAll(async () => {
  server = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = server.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
});

afterAll(async () => {
  await server.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});

type RT = InstanceType<typeof DemoRuntime>;

async function drained(rt: RT): Promise<void> {
  const start = Date.now();
  for (;;) {
    const v = rt.queueView();
    if (v.pending === 0 && v.running === null) return;
    if (Date.now() - start > 5000) throw new Error('queue did not drain within 5s');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------- scripted stub brain

type Mode = 'no_trade' | 'propose' | 'hold' | 'exit' | 'invalidate' | 'reduce';

function noTradeJudgment(): Judgment {
  return { action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '桩:不交易', thesis: '测试', reasons: ['测试 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null };
}
function proposeJudgment(mark: number): Judgment {
  const stop = (mark * 0.99).toFixed(2);
  const tp = (mark * 1.02).toFixed(2);
  return {
    action: 'PROPOSE', direction: 'long', confidence: 0.75, headline: '桩:测试做多', thesis: '测试用提议,验证执行链路', strategy_id: 'breakout_retest',
    reasons: ['测试原因 [E1]'], evidence_refs: ['E1'], invalidation: '跌破止损', invalidation_price: stop, target_price: tp, watch_conditions: [],
    proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: stop, take_profit_price: tp, take_profits: [tp], rationale: '测试' },
  };
}
function reviewJudgment(action: 'HOLD' | 'EXIT' | 'INVALIDATE' | 'REDUCE'): Judgment {
  return { action, direction: 'long', confidence: 0.6, headline: `桩:${action}`, thesis: '测试复查', reasons: ['测试原因 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null };
}

function scriptFor(mode: Mode, user: string): string {
  const isReview = /## 复查的线程/.test(user);
  const markMatch = /mark (\d+(?:\.\d+)?)/.exec(user);
  const mark = markMatch ? Number(markMatch[1]) : 0;
  if (isReview) {
    if (mode === 'hold') return JSON.stringify(reviewJudgment('HOLD'));
    if (mode === 'exit') return JSON.stringify(reviewJudgment('EXIT'));
    if (mode === 'invalidate') return JSON.stringify(reviewJudgment('INVALIDATE'));
    if (mode === 'reduce') return JSON.stringify(reviewJudgment('REDUCE'));
    return JSON.stringify(reviewJudgment('HOLD'));
  }
  if (mode === 'propose') return JSON.stringify(proposeJudgment(mark));
  return JSON.stringify(noTradeJudgment());
}

function mkRuntime(sizingReply?: string, onSizing?: () => void): { rt: RT; store: DemoStore; state: StateDb; backend: PaperBackend; setMode: (m: Mode) => void } {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new PaperBackend(10_000);
  let mode: Mode = 'no_trade';
  const brain = stubBrain((system, user) => {
    if (system.includes('Portfolio 仓位顾问')) { onSizing?.(); return sizingReply ?? 'garbage'; }
    return scriptFor(mode, user);
  });
  const rt = new DemoRuntime({ store, backend, brains: { stub: brain }, marketPollMs: 600_000, accountPollMs: 600_000 });
  return { rt, store, state, backend, setMode: (m) => (mode = m) };
}

let activeRt: RT | null = null;
let activeState: StateDb | null = null;

function useRuntime(): { rt: RT; store: DemoStore; backend: PaperBackend; setMode: (m: Mode) => void } {
  const r = mkRuntime();
  activeRt = r.rt;
  activeState = r.state;
  return r;
}

afterEach(async () => {
  if (activeRt) await activeRt.stop();
  if (activeState) activeState.close();
  activeRt = null;
  activeState = null;
});

const T = (detail: string): Trigger => ({ kind: 'manual', detail });

// ---------------------------------------------------------------- (a) scan → NO_TRADE

describe('scan(): NO_TRADE', () => {
  it('produces a done episode and opens no thread', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'] });
    setMode('no_trade');

    expect(rt.scan('BTCUSDT', T('test scan'))).toBe(true);
    await drained(rt);

    expect(rt.openThreads()).toHaveLength(0);
    const eps = store.episodes(10).filter((e) => e.symbol === 'BTCUSDT');
    expect(eps).toHaveLength(1);
    expect(eps[0]!.status).toBe('done');
    expect(eps[0]!.action).toBe('NO_TRADE');
    expect(eps[0]!.has_intent).toBe(false);
    expect(eps[0]!.thread_id).toBeNull();
  });
});

// ---------------------------------------------------------------- (b) PROPOSE → in_position → HOLD → EXIT

describe('scan(): PROPOSE with auto_approve → in_position → review HOLD → review EXIT', () => {
  it('opens a thread with protection orders, HOLD keeps it open (version bumps), EXIT closes it with realized_pnl', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true });
    setMode('propose');

    expect(rt.scan('BTCUSDT', T('scan'))).toBe(true);
    await drained(rt);

    let threads = rt.openThreads();
    expect(threads).toHaveLength(1);
    let thread = threads[0]!;
    expect(thread.status).toBe('in_position');
    expect(thread.protection_client_order_ids.length).toBeGreaterThan(0);
    expect(thread.entry_client_order_id).not.toBeNull();

    const account = await rt.backend.account();
    expect(account.positions.some((p) => p.symbol === 'BTCUSDT')).toBe(true);

    const ep = store.episodes(10).find((e) => e.symbol === 'BTCUSDT' && e.action === 'PROPOSE')!;
    expect(ep.thread_id).toBe(thread.id);

    const versionAfterOpen = thread.version;
    setMode('hold');
    expect(rt.reviewThread(thread.id, T('review 1'))).toBe(true);
    await drained(rt);
    thread = store.thread(thread.id)!;
    expect(thread.status).toBe('in_position');
    expect(thread.version).toBeGreaterThan(versionAfterOpen);

    setMode('exit');
    expect(rt.reviewThread(thread.id, T('review 2'))).toBe(true);
    await drained(rt);
    thread = store.thread(thread.id)!;
    expect(thread.status).toBe('closed');
    expect(thread.realized_pnl).not.toBeNull();
    expect(thread.close_reason).toBe('复查离场');
  });
});

// ---------------------------------------------------------------- (c) auto_approve=false

describe('scan(): PROPOSE with auto_approve=false', () => {
  it('creates a pending_approval intent + pending_entry thread; reject cancels it; approving a fresh one opens it', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: false });
    setMode('propose');

    expect(rt.scan('BTCUSDT', T('scan 1'))).toBe(true);
    await drained(rt);

    let threads = rt.openThreads();
    expect(threads).toHaveLength(1);
    let thread = threads[0]!;
    expect(thread.status).toBe('pending_entry');
    expect(thread.entry_client_order_id).toBeNull();

    const intent = store.intents(10).find((i) => i.thread_id === thread.id)!;
    expect(intent.status).toBe('pending_approval');

    rt.rejectIntent(intent.id);
    thread = store.thread(thread.id)!;
    expect(thread.status).toBe('canceled');

    // a fresh proposal for the same symbol (the canceled thread doesn't block it)
    expect(rt.scan('BTCUSDT', T('scan 2'))).toBe(true);
    await drained(rt);
    const thread2 = rt.openThreads()[0]!;
    const intent2 = store.intents(10).find((i) => i.thread_id === thread2.id && i.status === 'pending_approval')!;
    expect(intent2).toBeDefined();

    // v3.10: approval needs a one-time confirm token (§9.19); without it nothing executes.
    await expect(rt.approveIntent(intent2.id)).rejects.toThrow(/token/);
    await rt.approveIntent(intent2.id, rt.issueIntentConfirmation(intent2.id).token.nonce);
    const finalThread = store.thread(thread2.id)!;
    expect(finalThread.status).toBe('in_position');
  });
});

// ---------------------------------------------------------------- (d) manual orders

describe('manualOrder()', () => {
  it('a market order with sl/tp opens a source=manual thread in_position; a far-away limit rests pending_entry; closing it cancels it', async () => {
    const { rt } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub' });

    const ethMark = Number(rt.markets.get('ETHUSDT')!.mark);
    const opened = await rt.manualOrder({ symbol: 'ETHUSDT', side: 'long', action: 'open', type: 'market', qty: '0.01', leverage: 5, sl: (ethMark * 0.95).toFixed(2), tp: (ethMark * 1.05).toFixed(2) });
    expect(opened.thread).not.toBeNull();
    expect(opened.thread!.source).toBe('manual');
    expect(opened.thread!.status).toBe('in_position');

    const solMark = Number(rt.markets.get('SOLUSDT')!.mark);
    const farLimit = (solMark * 0.3).toFixed(2); // long limit well below mark → rests instead of filling (and stays under the max-notional gate at qty=1, SOL's min step)
    const pending = await rt.manualOrder({ symbol: 'SOLUSDT', side: 'long', action: 'open', type: 'limit', price: farLimit, qty: '1', sl: (solMark * 0.2).toFixed(2) });
    expect(pending.thread).not.toBeNull();
    expect(pending.thread!.status).toBe('pending_entry');

    const closed = await rt.closeThread(pending.thread!.id);
    expect(closed.status).toBe('canceled');
  });
});

// ---------------------------------------------------------------- (e) openingBlockers via gates

describe('opening blockers respected via the code gates', () => {
  it('max_open_threads=1: the first PROPOSE actually opens the thread (regression for the preflightOpen self-count bug — it must exclude its own thread id), then a second symbol\'s PROPOSE is rejected by the 线程/日内限制 gate', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT', 'ETHUSDT'], auto_approve: true, max_open_threads: 1 });
    setMode('propose');

    expect(rt.scan('BTCUSDT', T('t1'))).toBe(true);
    await drained(rt);
    const threads = rt.openThreads();
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.symbol).toBe('BTCUSDT');
    expect(thread.status).toBe('in_position');
    expect(thread.entry_client_order_id).not.toBeNull();

    expect(rt.scan('ETHUSDT', T('t2'))).toBe(true);
    await drained(rt);
    expect(rt.openThreads().some((t) => t.symbol === 'ETHUSDT')).toBe(false);

    const epSummary = store.episodes(10).find((e) => e.symbol === 'ETHUSDT' && e.action === 'PROPOSE')!;
    expect(epSummary.reducer?.accepted).toBe(false);
    const ep = store.episode(epSummary.id)!;
    expect(ep.gates.some((g) => g.name === '线程/日内限制' && !g.passed && /上限/.test(g.reason))).toBe(true);
  });
});


// ---------------------------------------------------------------- (f) halt / resume

describe('halt() / resume()', () => {
  it('halt() closes every open thread and cancels orders; resume() requires confirm=RESUME', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true });
    setMode('propose');
    expect(rt.scan('BTCUSDT', T('scan'))).toBe(true);
    await drained(rt);
    const thread = rt.openThreads()[0]!;
    expect(thread.status).toBe('in_position');

    await rt.halt();
    expect(rt.isHalted).toBe(true);
    const after = store.thread(thread.id)!;
    expect(after.status).toBe('closed');
    expect(after.close_reason).toBe('紧急停止');

    // halted: no new scans accepted
    expect(rt.scan('BTCUSDT', T('should be blocked'))).toBe(false);

    const noConfirm = rt.resume();
    expect(noConfirm.ok).toBe(false);
    expect(rt.isHalted).toBe(true);

    const confirmed = rt.resume('RESUME');
    expect(confirmed.ok).toBe(true);
    expect(rt.isHalted).toBe(false);
  });
});

// ---------------------------------------------------------------- (g) queue dedupe

describe('queue dedupe', () => {
  it('a second scan("BTCUSDT") issued while the first is in flight is rejected', async () => {
    const { rt, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'] });
    setMode('no_trade');

    const first = rt.scan('BTCUSDT', T('t'));
    const second = rt.scan('BTCUSDT', T('t'));
    expect(first).toBe(true);
    expect(second).toBe(false);
    await drained(rt);
  });
});
