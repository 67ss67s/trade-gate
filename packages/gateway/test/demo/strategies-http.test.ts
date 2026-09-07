// 策略库 + 归因的 HTTP 路由(routes-strategies.ts,经 http-extra.ts 注册)。
// 走真实的 createServer;大脑是 stub,不调任何付费模型。

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import type { Brain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let cacheDir = '';
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-strat-http-'));
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
  ({ createServer } = await import('../../src/demo/http.js'));
});

afterAll(async () => {
  await fakeMarket.close();
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env['TG_DEMO_MARKET_BASE'];
  delete process.env['TG_DEMO_KLINE_CACHE_DIR'];
});

let activeHttp: http.Server | null = null;
let activeRt: InstanceType<typeof DemoRuntime> | null = null;
let activeState: StateDb | null = null;
let baseUrl = '';
let store: DemoStore;

/** A brain that always answers with the attribution JSON (the归因 route calls the CHEAP brain). */
function scriptedBrain(text: string): Brain {
  return { name: 'stub', async complete() { return { text, latency_ms: 1, model: 'stub', input_tokens: 10, output_tokens: 5 }; } };
}

const ATTR_JSON = JSON.stringify([
  {
    title: '追单太远',
    strategy_id: 'breakout_retest',
    symbol: 'BTCUSDT',
    evidence_said: '清单写着距突破位 1.4 ATR',
    rule_said: '1.5 ATR 以内可以追',
    actual: '入场后立刻回抽打止损',
    proposal: { kind: 'param', strategy_id: 'breakout_retest', param: 'chase_atr_max', value: 1, text: '' },
  },
]);

async function setup(brainText = ATTR_JSON): Promise<void> {
  const state = openStateDb(':memory:');
  store = new DemoStore(state);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: scriptedBrain(brainText) }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], timeframe: '15m' });
  const server = createServer(rt, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  activeHttp = server;
  activeRt = rt;
  activeState = state;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

it('GET /api/strategies lists the seeded built-ins with their gate state', async () => {
  await setup();
  const r = await api('GET', '/api/strategies');
  expect(r.status).toBe(200);
  expect(r.json.strategies).toHaveLength(5);
  expect(r.json.active).toEqual(['breakout_retest']);
  expect(r.json.statuses).toEqual(['draft', 'backtest', 'shadow', 'paper', 'live_capped']);
  // head 是漏斗给的 v2 草稿(backtest),v1 仍然是 paper —— 实盘照旧跑 v1。
  const bo = r.json.strategies.find((s: { id: string }) => s.id === 'breakout_retest');
  expect(bo).toMatchObject({ version: 2, status: 'backtest', active: true, next_status: 'shadow', family_label: '趋势延续' });
  expect(bo.promote_blocked).toMatch(/至少要跑过 1 次回测/);
  const mtf = r.json.strategies.find((s: { id: string }) => s.id === 'mtf_alignment');
  expect(mtf).toMatchObject({ status: 'backtest', active: false, next_status: 'shadow' });
  expect(mtf.promote_blocked).toMatch(/至少要跑过 1 次回测/);
});

it('GET /api/strategies/:id returns versions; 404 for an unknown id', async () => {
  await setup();
  const r = await api('GET', '/api/strategies/breakout_retest');
  expect(r.status).toBe(200);
  expect(r.json.strategy.id).toBe('breakout_retest');
  expect(r.json.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  expect((await api('GET', '/api/strategies/nope')).status).toBe(404);
});

it('POST /api/strategies/active refuses anything below paper and writes the workflow otherwise', async () => {
  await setup();
  const bad = await api('POST', '/api/strategies/active', { ids: ['mtf_alignment'] });
  expect(bad.status).toBe(400);
  expect(bad.json.error.message).toMatch(/未到 paper/);
  expect((await api('POST', '/api/strategies/active', { ids: ['ghost'] })).status).toBe(400);

  const ok = await api('POST', '/api/strategies/active', { ids: ['breakout_retest'] });
  expect(ok.status).toBe(200);
  expect(ok.json.active).toEqual(['breakout_retest']);
  expect(ok.json.workflow.active_strategies).toEqual(['breakout_retest']);
});

it('propose-version makes a draft; promote respects the ladder and the live confirm', async () => {
  await setup();
  const v2 = await api('POST', '/api/strategies/breakout_retest/propose-version', { params: { chase_atr_max: 1.2 } });
  expect(v2.status).toBe(201);
  expect(v2.json.strategy).toMatchObject({ version: 3, status: 'draft', parent_version: 2 });
  expect(v2.json.strategy.params.chase_atr_max.value).toBe(1.2);

  const bad = await api('POST', '/api/strategies/breakout_retest/propose-version', { params: { chase_atr_max: 42 } });
  expect(bad.status).toBe(400);
  expect(bad.json.error.message).toMatch(/超出范围/);

  // head 现在是 draft:只能往 backtest 走一格。
  expect((await api('POST', '/api/strategies/breakout_retest/promote', { to: 'paper' })).status).toBe(409);
  expect((await api('POST', '/api/strategies/breakout_retest/promote', { to: 'backtest' })).json.strategy.status).toBe('backtest');
  expect((await api('POST', '/api/strategies/breakout_retest/promote', { to: 'retired' })).status).toBe(400);
});

it('retire drops the strategy out of the live active list', async () => {
  await setup();
  const r = await api('POST', '/api/strategies/breakout_retest/retire');
  expect(r.status).toBe(200);
  expect(r.json.strategy.status).toBe('retired');
  expect(r.json.active).toEqual([]);
  expect((await api('GET', '/api/strategies')).json.active).toEqual([]);
});

