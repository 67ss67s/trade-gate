// Outcome simulation on bars the judgment could not see (design notes outcome_R / missed_move).
// Moved here from packages/eval-a/src/outcome.ts (2026-09-05) so the blind backtester (backtest.ts) and the
// eval harness share ONE definition of "what happened after"; eval-a's outcome.ts now re-exports this file.
//
// Conventions: market entry fills at the next bar's open; a limit fills at the limit (or at the open
// if the bar gaps through it) the first bar that touches it; on any bar where both the stop and the
// take-profit are touched the stop wins (fail-pessimistic); a gap through the stop exits at the open;
// unresolved at the horizon → closed at the last close. R is signed P&L over the initial stop distance.
//
// Two entry points on the same rules:
//   simulateOutcome() — one shot over a fixed window (eval: the hidden bars).
//   openTrade()/stepTrade() — the same rules bar by bar, for a walk that can be interrupted (backtest:
//   a blind review may EXIT before the stop/tp is reached). simulateOutcome is implemented on top of
//   them, so there is exactly one copy of the fill/stop/tp semantics.

import type { Direction, Kline } from './types.js';

export interface OutcomeInput {
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: number | null;
  stop: number;
  tp: number | null;
  bars: Kline[];
}

export type OutcomeStatus = 'stop' | 'tp' | 'expired' | 'unfilled' | 'invalid';

export interface Outcome {
  status: OutcomeStatus;
  fill_price: number | null;
  fill_bar: number | null;
  exit_price: number | null;
  exit_bar: number | null;
  stop_distance: number | null;
  r: number | null;
  mae_r: number | null;
  mfe_r: number | null;
  bars_held: number | null;
  note: string;
}

const none = (status: OutcomeStatus, note: string): Outcome => ({ status, fill_price: null, fill_bar: null, exit_price: null, exit_bar: null, stop_distance: null, r: null, mae_r: null, mfe_r: null, bars_held: null, note });

/** A filled position being walked forward one bar at a time. Mutated by stepTrade(). */
export interface OpenTrade {
  direction: Direction;
  fill_price: number;
  stop: number;
  tp: number | null;
  /** |fill − stop| at entry; the denominator of every R on this trade (never re-based). */
  stop_distance: number;
  mae_r: number;
  mfe_r: number;
  /** Bars processed since (and including) the fill bar. */
  bars_held: number;
}

/** null when the stop sits on the wrong side of the fill (the one case the walk cannot start). */
export function openTrade(direction: Direction, fill: number, stop: number, tp: number | null): OpenTrade | null {
  const sgn = direction === 'long' ? 1 : -1;
  const stopDistance = sgn * (fill - stop);
  if (!(stopDistance > 0)) return null;
  return { direction, fill_price: fill, stop, tp, stop_distance: stopDistance, mae_r: 0, mfe_r: 0, bars_held: 0 };
}

/** Signed R of `px` for this trade (positive = in the trade's favour). */
export function tradeR(t: OpenTrade, px: number): number {
  const sgn = t.direction === 'long' ? 1 : -1;
  return (sgn * (px - t.fill_price)) / t.stop_distance;
}

export interface TradeStep {
  /** Set when this bar closed the trade; the caller stops walking. */
  exit: { price: number; status: 'stop' | 'tp'; note: string } | null;
}

/**
 * One bar against an open trade: updates MAE/MFE and the held-bar count, then checks stop before
 * take-profit (fail-pessimistic) with gap-through handled at the bar's open.
 */
export function stepTrade(t: OpenTrade, bar: Kline): TradeStep {
  const o = Number(bar.open);
  const h = Number(bar.high);
  const l = Number(bar.low);
  t.bars_held += 1;
  const adverse = t.direction === 'long' ? l : h;
  const favorable = t.direction === 'long' ? h : l;
  t.mae_r = Math.min(t.mae_r, tradeR(t, adverse));
  t.mfe_r = Math.max(t.mfe_r, tradeR(t, favorable));
  const hitStop = t.direction === 'long' ? l <= t.stop : h >= t.stop;
  const hitTp = t.tp !== null && (t.direction === 'long' ? h >= t.tp : l <= t.tp);
  if (hitStop) {
    const gapped = t.direction === 'long' ? o < t.stop : o > t.stop;
    return { exit: { price: gapped ? o : t.stop, status: 'stop', note: hitTp ? '同根同时触及止损与止盈,按止损计' : gapped ? '跳空穿越止损,按开盘价出' : '触及止损' } };
  }
  if (hitTp && t.tp !== null) {
    const gapped = t.direction === 'long' ? o > t.tp : o < t.tp;
    return { exit: { price: gapped ? o : t.tp, status: 'tp', note: gapped ? '跳空穿越止盈,按开盘价出' : '触及止盈' } };
  }
  return { exit: null };
}

/** The fill bar and price for an entry against `bars` (bars[0] = the first bar after the judgment). */
export function findFill(inp: Pick<OutcomeInput, 'direction' | 'entry' | 'limit_price'>, bars: Kline[]): { bar: number; price: number } | null {
  if (!bars.length) return null;
  if (inp.entry === 'market') return { bar: 0, price: Number(bars[0]!.open) };
  if (inp.limit_price === null) return null;
  const lim = inp.limit_price;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const o = Number(b.open);
    const touched = inp.direction === 'long' ? Number(b.low) <= lim : Number(b.high) >= lim;
    if (!touched) continue;
    return { bar: i, price: inp.direction === 'long' ? Math.min(o, lim) : Math.max(o, lim) };
  }
  return null;
}

export function simulateOutcome(inp: OutcomeInput): Outcome {
  const bars = inp.bars;
  if (!bars.length) return none('invalid', '没有未来 K 线');
  if (inp.entry === 'limit' && inp.limit_price === null) return none('invalid', '限价单没有 limit_price');
  const fill = findFill(inp, bars);
  if (!fill) return none('unfilled', '限价在 horizon 内未触及');
  const t = openTrade(inp.direction, fill.price, inp.stop, inp.tp);
  if (!t) return none('invalid', `止损 ${inp.stop} 在成交价 ${fill.price} 的错误一侧`);
  for (let i = fill.bar; i < bars.length; i++) {
    const step = stepTrade(t, bars[i]!);
    if (!step.exit) continue;
    return { status: step.exit.status, fill_price: fill.price, fill_bar: fill.bar, exit_price: step.exit.price, exit_bar: i, stop_distance: t.stop_distance, r: tradeR(t, step.exit.price), mae_r: t.mae_r, mfe_r: t.mfe_r, bars_held: t.bars_held, note: step.exit.note };
  }
  const last = bars[bars.length - 1]!;
  const exit = Number(last.close);
  return { status: 'expired', fill_price: fill.price, fill_bar: fill.bar, exit_price: exit, exit_bar: bars.length - 1, stop_distance: t.stop_distance, r: tradeR(t, exit), mae_r: t.mae_r, mfe_r: t.mfe_r, bars_held: t.bars_held, note: '到期按收盘价出' };
}

/** Largest absolute excursion from p0 over the hidden bars, in ATR units. */
export function missedMove(p0: number, atr: number, bars: Kline[]): { up_atr: number; down_atr: number; max_atr: number } | null {
  if (!bars.length || !(atr > 0)) return null;
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (const b of bars) {
    hi = Math.max(hi, Number(b.high));
    lo = Math.min(lo, Number(b.low));
  }
  const up = (hi - p0) / atr;
  const down = (p0 - lo) / atr;
  return { up_atr: up, down_atr: down, max_atr: Math.max(up, down) };
}
