// Code-side gates + sizing (design notes–5.7). The model never sees or sets these.

import type { AccountView, GateResult, Judgment, MarketView, Sizing } from './types.js';

export interface GateConfig {
  risk_pct: number; // % of equity at risk per trade
  max_notional_multiple: number; // notional ≤ equity × this
  max_opens_per_day: number;
  min_stop_pct: number;
  max_stop_pct: number;
}

export const DEFAULT_GATES: GateConfig = {
  risk_pct: 0.5,
  max_notional_multiple: 3,
  max_opens_per_day: 2,
  min_stop_pct: 0.3,
  max_stop_pct: 5,
};

export interface GateContext {
  halted: boolean;
  paused: boolean;
  account: AccountView;
  market: MarketView;
  opens_today: number;
  stale_refs: Set<string>;
  /** Judgment time; when given, an opening action is refused if the market snapshot itself is older than MARKET_STALE_MS. */
  now?: number;
}

/** A mark/price snapshot older than this cannot back a new position (same window as context.ts STALE_MS). */
export const MARKET_STALE_MS = 3 * 60_000;

export function evaluateGates(j: Judgment, ctx: GateContext, cfg: GateConfig = DEFAULT_GATES): GateResult[] {
  const out: GateResult[] = [];
  const opening = j.action === 'PROPOSE' || j.action === 'ADD';
  out.push({ name: '紧急停止', passed: !(ctx.halted && opening), reason: ctx.halted ? '系统紧急停止中,不允许开仓' : '未触发' });
  out.push({ name: '暂停', passed: !(ctx.paused && opening), reason: ctx.paused ? '已暂停,不开新仓' : '运行中' });
  // Two ways to be stale: the judgment cites an evidence line marked STALE, or the market snapshot the
  // sizing/entry would use is itself old (eval's stale variants showed a PROPOSE can cite only kline
  // evidence and slip past a citation-only check — 2026-09-05 holdout run).
  const snapshotAge = ctx.now !== undefined ? ctx.now - ctx.market.as_of : 0;
  const snapshotStale = snapshotAge > MARKET_STALE_MS;
  const citesStale = j.evidence_refs.some((r) => ctx.stale_refs.has(r));
  out.push({
    name: '证据新鲜度',
    passed: !(opening && (citesStale || snapshotStale)),
    reason: !opening ? '不适用' : snapshotStale ? `行情快照已过期 ${Math.round(snapshotAge / 1000)} 秒,开仓不能用旧价` : citesStale ? '开仓判断不能引用过期证据' : '证据与行情都新鲜',
  });
  if (j.action === 'PROPOSE') {
    out.push({ name: '无持仓才能开仓', passed: ctx.account.positions.length === 0, reason: ctx.account.positions.length ? '已有持仓' : '当前无持仓' });
    out.push({ name: '每日开仓上限', passed: ctx.opens_today < cfg.max_opens_per_day, reason: `今日已开 ${ctx.opens_today}/${cfg.max_opens_per_day}` });
    const p = j.proposal;
    if (p) {
      const mark = Number(ctx.market.mark);
      const stop = Number(p.stop_price);
      // A marketable limit fills near mark, so judge the stop against the worse of the two prices.
      const lim = p.entry === 'limit' && p.limit_price ? Number(p.limit_price) : null;
      const ref = lim === null ? mark : p.direction === 'long' ? Math.min(lim, mark) : Math.max(lim, mark);
      const dist = (Math.abs(ref - stop) / ref) * 100;
      const sideOk = p.direction === 'long' ? stop < ref : stop > ref;
      out.push({ name: '止损在正确一侧', passed: sideOk, reason: sideOk ? `${p.direction === 'long' ? '做多止损低于' : '做空止损高于'}入场价` : `止损 ${p.stop_price} 在入场价 ${ref.toFixed(1)} 的错误一侧` });
      out.push({ name: '止损距离', passed: dist >= cfg.min_stop_pct && dist <= cfg.max_stop_pct, reason: `${dist.toFixed(2)}%(允许 ${cfg.min_stop_pct}%–${cfg.max_stop_pct}%)` });
      if (p.take_profit_price) {
        const tp = Number(p.take_profit_price);
        const tpOk = p.direction === 'long' ? tp > ref : tp < ref;
        out.push({ name: '止盈在正确一侧', passed: tpOk, reason: tpOk ? '通过' : `止盈 ${p.take_profit_price} 方向不对` });
      }
    }
    out.push({ name: '信心下限', passed: j.confidence >= 0.4, reason: `信心 ${j.confidence.toFixed(2)}(需 ≥ 0.40)` });
  }
  if (j.action === 'ADD') out.push({ name: '演示版不加仓', passed: false, reason: '演示版只记录 ADD 建议,不执行' });
  return out;
}

export interface SymbolRules {
  step_size: string;
  tick_size: string;
  min_qty: string;
  min_notional: string;
}

function floorToStep(qty: number, step: string): string {
  const s = Number(step);
  if (!(s > 0)) return qty.toString();
  const decimals = Math.max(0, (step.split('.')[1] ?? '').replace(/0+$/, '').length);
  const floored = Math.floor(qty / s + 1e-9) * s;
  return floored.toFixed(decimals);
}

export function computeSizing(j: Judgment, account: AccountView, market: MarketView, rules: SymbolRules, cfg: GateConfig = DEFAULT_GATES, options: { liquidity_notional_cap?: number; fixed_qty?: string } = {}): { qty: string; sizing: Sizing; ok: boolean } {
  const p = j.proposal!;
  const equity = Number(account.equity);
  const lim = p.entry === 'limit' && p.limit_price ? Number(p.limit_price) : null;
  const mark = Number(market.mark);
  const ref = lim === null ? mark : p.direction === 'long' ? Math.max(lim, mark) : Math.min(lim, mark);
  const notionalRef = lim === null ? mark : Math.max(lim, mark);
  const minimumRef = lim === null ? mark : Math.min(lim, mark);
  const stopDist = Math.abs(ref - Number(p.stop_price));
  const riskUsdt = (equity * cfg.risk_pct) / 100;
  let rawQty = stopDist > 0 ? riskUsdt / stopDist : 0;
  const notes: string[] = [];
  const maxNotional = equity * cfg.max_notional_multiple;
  if (rawQty * notionalRef > maxNotional) {
    rawQty = maxNotional / notionalRef;
    notes.push(`名义超过权益×${cfg.max_notional_multiple},按上限钳制`);
  }
  const minNotional = Number(rules.min_notional || '0');
  if (minNotional > 0 && rawQty * minimumRef < minNotional) {
    rawQty = (minNotional * 1.02) / minimumRef;
    notes.push(`低于交易所最小名义 ${minNotional} USDT,抬到最小名义(实际风险 ${(rawQty * stopDist).toFixed(2)} USDT)`);
  }
  const liquidityCap = options.liquidity_notional_cap ?? Infinity;
  if (rawQty * notionalRef > liquidityCap) {
    rawQty = Math.max(0, liquidityCap) / notionalRef;
    notes.push('按24h成交量流动性上限钳制');
  }
  let qty = floorToStep(rawQty, rules.step_size);
  // Flooring can drop the notional back under the exchange minimum; step up once if so.
  if (minNotional > 0 && Number(qty) * minimumRef < minNotional) {
    const step = Number(rules.step_size) || 0;
    const decimals = Math.max(0, (rules.step_size.split('.')[1] ?? '').replace(/0+$/, '').length);
    qty = (Number(qty) + step).toFixed(decimals);
  }
  if (options.fixed_qty !== undefined) qty = options.fixed_qty;
  const riskTolerance = 1.05;
  let ok = Number(qty) >= Number(rules.min_qty || '0') && Number(qty) > 0;
  if (!ok) notes.push('数量低于交易所最小下单量');
  if (ok && Number(qty) * minimumRef < minNotional) { ok = false; notes.push('低于交易所最小名义，拒单'); }
  if (ok && Number(qty) * notionalRef > maxNotional * 1.0001) {
    ok = false;
    notes.push(`交易所最小名义 ${minNotional} 高于本地名义上限 ${maxNotional.toFixed(2)},拒单`);
  }
  if (ok && (!Number.isFinite(Number(qty)) || !Number.isFinite(riskUsdt) || !(equity > 0) || !(stopDist > 0) || !(ref > 0) || !(liquidityCap > 0) || Number(qty) * notionalRef > liquidityCap)) {
    ok = false;
    notes.push('流动性上限或 sizing 数据不可用，拒单');
  }
  if (ok && Number(qty) * stopDist > riskUsdt * riskTolerance + 1e-9) {
    ok = false;
    const actualRisk = Number(qty) * stopDist;
    const neededEquity = Math.ceil((actualRisk * 100 / cfg.risk_pct) * 100 - 1e-9) / 100;
    notes.push(`最小下单量风险 ${actualRisk.toFixed(2)} U > 预算 ${riskUsdt.toFixed(2)} U;要 ${neededEquity} U 权益才能按 ${cfg.risk_pct}% 做 ${market.symbol}(容差 5%,拒单)`);
  }
  return {
    qty,
    ok,
    sizing: {
      equity: equity.toFixed(2),
      risk_pct: cfg.risk_pct.toString(),
      risk_usdt: riskUsdt.toFixed(2),
      stop_distance: stopDist.toFixed(2),
      raw_qty: rawQty.toFixed(6),
      step_size: rules.step_size,
      note: notes.join(';') || `风险 ${riskUsdt.toFixed(2)} USDT ÷ 止损距离 ${stopDist.toFixed(2)} = ${rawQty.toFixed(4)}`,
    },
  };
}
