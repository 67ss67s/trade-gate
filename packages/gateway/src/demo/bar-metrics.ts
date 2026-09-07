// Deterministic per-bar metrics and condition evaluation shared by the Radar screener.
//
// Everything here is code, not model output: given raw klines it produces one `BarMetrics` row per bar
// (ATR%, EMA trend agreement on the base/1h/4h timeframes, distance to the prior N-bar breakout level,
// retest volume ratio, funding rate, daily regime) and evaluates a bar against a threshold set. The
// screener reuses it so "does this bar meet the entry conditions" is answered the same way everywhere.
//
// Calibration notes kept from the original implementation:
//   - Feature windows match the backtest's (15m 60 bars / 1h 120 / 4h 80 / 1d 260), so EMA seeding is
//     identical between screening and replay.
//   - The ATR floor comes from the per-timeframe table in review-metrics.ts.
//   - Chase distance, retest volume and the daily-range volume ratio default to the `breakout_retest`
//     strategy's parameter defaults.
//
// One deliberate difference from `scanChecklist`: the breakout level has two definitions.
//   `self`  = the 20-bar high INCLUDING the current bar (what scanChecklist uses). Since
//             close <= high <= max(high), `last_close > swing_high_20` can never be true, so a
//             "retest confirmed" can never fire under that definition.
//   `prior` = the 20-bar high EXCLUDING the current bar — what triggers.ts compares against, and the
//             normal meaning of "closed above the breakout level". Screening uses `prior`.

import { lastClosedIndex } from './klines.js';
import { atrPctFloor } from './review-metrics.js';
import { dailyRegime, ema, fetchFundingRateHistory, tfToMs } from './market.js';
import { loadKlines } from './klines.js';
import { openTrade, stepTrade, tradeR } from './outcome.js';
import type { DailyRegime, Direction, Kline } from './types.js';
// ---------------------------------------------------------------- 条件与阈值

/** Direction-agnostic raw measurements for one bar; every threshold variant is arithmetic on these. */
export interface BarMetrics {
  /** 该根收盘时刻(= 判断可见的边界)。 */
  t: number;
  close: number;
  atr: number;
  atr_pct: number;
  atr_floor: number;
  /** 含当前根的 20 根高/低(tfFeatures.swing_high_20 / swing_low_20)。 */
  hi20: number;
  lo20: number;
  /** 不含当前根的前 20 根高/低(triggers.ts 的比较基准)。 */
  hi20_prev: number;
  lo20_prev: number;
  vol_ratio: number;
  ema20: number;
  dir_h1: Direction | null;
  dir_h4: Direction | null;
  /** 4h 收盘距 4h EMA20 多少个 4h ATR —— "4h 强烈反向"否决用的强度。 */
  h4_dist_atr: number | null;
  regime: DailyRegime['regime'] | null;
  /** |资金费率|,单位 %。历史缺失时为 null(缺失不算违规)。 */
  funding_abs_pct: number | null;
  /** 本根按 prior 口径收破了上/下沿。 */
  broke_up: boolean;
  broke_down: boolean;
  /** 距最近一次 prior 口径向上/向下突破多少根(0 = 就是本根,-1 = 窗口内没有)。 */
  bars_since_up: number;
  bars_since_down: number;
  /** 那次突破那根的量比(没有则 null)。 */
  break_vol_up: number | null;
  break_vol_down: number | null;
}

export interface BarThresholds {
  /** ATR% 门槛的倍数(1 = review-metrics 的分周期表原值)。 */
  atr_floor_mult: number;
  /** 距突破位多少 ATR 以内才算"在射程内"。 */
  chase_atr_max: number;
  /** 回踩确认要的量比。 */
  retest_vol_min: number;
  /** `current` = 只看当前这根的量比(现行);`either` = 当前根或那次突破那根任一达标即可。 */
  vol_mode: 'current' | 'either';
  /** `both` = 1h 与 4h 必须同向(现行);`h1_veto` = 只看 1h,4h 仅在"强烈反向"时否决。 */
  trend_mode: 'both' | 'h1_veto';
  /** h1_veto 下,4h 反向且距 4h EMA20 超过这么多 ATR 才算否决。 */
  h4_veto_atr: number;
  /** 突破位口径:`self` = 含当前根(scanChecklist 现行,恒不可达);`prior` = 前 20 根。 */
  breakout_level: 'self' | 'prior';
  /** 突破视为"仍然有效"的回看根数(1 = 只认最近这一根收破)。 */
  breakout_window: number;
  /** 日线 range 时突破要的量比。 */
  range_vol_min: number;
  /** |资金费率| 上限,单位 %。 */
  funding_abs_max: number;
  /** true = 只在日线 bull/bear 里做(range/volatile 一律不做);质量变体用。 */
  require_trend_regime: boolean;
}

/** 现行规则:`scanChecklist` + `breakout_retest` v1 参数默认值。 */
export const CURRENT_THRESHOLDS: BarThresholds = {
  atr_floor_mult: 1,
  chase_atr_max: 1.5,
  retest_vol_min: 1,
  vol_mode: 'current',
  trend_mode: 'both',
  h4_veto_atr: 1,
  breakout_level: 'self',
  breakout_window: 1,
  range_vol_min: 1.5,
  funding_abs_max: 0.05,
  require_trend_regime: false,
};

export const CONDITION_KEYS = ['atr_ok', 'trend_agree', 'within_chase', 'breakout', 'retest_vol', 'funding_ok', 'regime_ok'] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];

export const CONDITION_LABEL: Record<ConditionKey, string> = {
  atr_ok: 'ATR% ≥ 分周期门槛',
  trend_agree: '1h/4h EMA20-vs-EMA50 同向',
  within_chase: '距突破位 ≤ chase_atr_max ATR',
  breakout: '已收破突破位(窗口内)',
  retest_vol: '量比 ≥ retest_vol_min',
  funding_ok: '资金费率绝对值 ≤ 上限', // 标签里不放 `|`:它要进 markdown 表格
  regime_ok: '日线状态不反对该方向',
};

export interface ConditionEval {
  /** 该根的评估方向:联合判定用 1h/4h 同向的结果,同向不成立时退化成"离哪边近算哪边"。 */
  dir: Direction;
  /** 趋势条件本身是否成立(成立时 dir 就是它)。 */
  dir_trend: Direction | null;
  pass: Record<ConditionKey, boolean>;
  /** 七条全过 = 本该 PROPOSE。 */
  joint: boolean;
  /** 距突破位多少 ATR(按 dir)。 */
  dist_atr: number;
  /** 该根参照的突破位价格(按 dir + breakout_level 口径)。 */
  level: number;
  /** WATCH 口径:1h/4h 同向 且 在射程内 且 回踩尚未确认。 */
  watch_eligible: boolean;
  /** 现行"回踩确认" = 收破 且 量比达标。 */
  retest_confirmed: boolean;
}

/** Verdict for one bar under one threshold set. Pure arithmetic, called hundreds of thousands of times. */
export function evaluateBar(m: BarMetrics, th: BarThresholds): ConditionEval {
  const dirTrend: Direction | null =
    th.trend_mode === 'both'
      ? m.dir_h1 !== null && m.dir_h1 === m.dir_h4
        ? m.dir_h1
        : null
      : m.dir_h1 !== null && !(m.dir_h4 !== null && m.dir_h4 !== m.dir_h1 && (m.h4_dist_atr ?? 0) > th.h4_veto_atr)
        ? m.dir_h1
        : null;
  // 方向无关的兜底:哪边的 20 根边沿更近就按哪边评估其余条件。只影响单条通过率与边际杀伤,
  // 联合判定仍然要求 trend_agree 成立(所以联合数对趋势口径是单调的)。
  const nearUp = Math.abs(m.close - m.hi20) <= Math.abs(m.close - m.lo20);
  const dir: Direction = dirTrend ?? (nearUp ? 'long' : 'short');
  const long = dir === 'long';
  const level = th.breakout_level === 'self' ? (long ? m.hi20 : m.lo20) : long ? m.hi20_prev : m.lo20_prev;
  const distAtr = m.atr > 0 ? Math.abs(m.close - level) / m.atr : Number.POSITIVE_INFINITY;

  const since = long ? m.bars_since_up : m.bars_since_down;
  const breakout =
    th.breakout_level === 'self'
      ? long
        ? m.close > m.hi20
        : m.close < m.lo20 // 恒为假:close ≤ high ≤ hi20(见文件头注释)
      : since >= 0 && since < th.breakout_window;
  const breakVol = long ? m.break_vol_up : m.break_vol_down;
  const volOk = m.vol_ratio >= th.retest_vol_min || (th.vol_mode === 'either' && breakVol !== null && since >= 0 && since < th.breakout_window && breakVol >= th.retest_vol_min);

  const regimeOk =
    m.regime === null
      ? !th.require_trend_regime
      : th.require_trend_regime && m.regime !== 'bull' && m.regime !== 'bear'
        ? false
        : m.regime === 'bear' && long
          ? false
          : m.regime === 'bull' && !long
            ? false
            : m.regime === 'range'
              ? m.vol_ratio >= th.range_vol_min
              : true;

  const pass: Record<ConditionKey, boolean> = {
    atr_ok: m.atr_pct >= m.atr_floor * th.atr_floor_mult,
    trend_agree: dirTrend !== null,
    within_chase: distAtr <= th.chase_atr_max,
    breakout,
    retest_vol: volOk,
    funding_ok: m.funding_abs_pct === null || m.funding_abs_pct <= th.funding_abs_max,
    regime_ok: regimeOk,
  };
  const joint = CONDITION_KEYS.every((k) => pass[k]);
  const retestConfirmed = breakout && volOk;
  return { dir, dir_trend: dirTrend, pass, joint, dist_atr: distAtr, level, watch_eligible: dirTrend !== null && pass.within_chase && !retestConfirmed, retest_confirmed: retestConfirmed };
}

// ---------------------------------------------------------------- 逐根度量(从 K 线到 BarMetrics)

/** market.ts `atr()` 的滚动版:atr[i] = 最近 period 根真实波幅的算术平均(i < period 时为 0)。 */
export function rollingAtr(bars: Kline[], period: number): number[] {
  const out = new Array<number>(bars.length).fill(0);
  const tr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const h = Number(bars[i]!.high);
    const l = Number(bars[i]!.low);
    const pc = Number(bars[i - 1]!.close);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    sum += tr[i]!;
    if (i > period) sum -= tr[i - period]!;
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

/** 每根之前(可含自身)最近 `n` 根的极值。`inclusive=false` 时不含自身(prior 口径)。 */
function rollingExtreme(bars: Kline[], n: number, pick: 'high' | 'low', inclusive: boolean): number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  for (let i = 0; i < bars.length; i++) {
    const end = inclusive ? i : i - 1;
    const start = Math.max(0, end - n + 1);
    if (end < start) continue;
    let best = pick === 'high' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (let j = start; j <= end; j++) {
      const v = Number(bars[j]![pick]);
      best = pick === 'high' ? Math.max(best, v) : Math.min(best, v);
    }
    out[i] = best;
  }
  return out;
}

/** tfFeatures 的量比口径:本根量 / 前 20 根均量。 */
function rollingVolRatio(bars: Kline[], n = 20): number[] {
  const out = new Array<number>(bars.length).fill(1);
  for (let i = 1; i < bars.length; i++) {
    const start = Math.max(0, i - n);
    const win = bars.slice(start, i);
    const avg = win.reduce((a, k) => a + Number(k.volume), 0) / Math.max(1, win.length);
    out[i] = avg > 0 ? Number(bars[i]!.volume) / avg : 1;
  }
  return out;
}

/** 窗口内(最后 `window` 根)重算的 EMA —— 与 tfFeatures 的种子效应一致。 */
function windowedEmaDir(bars: Kline[], window: number): { dir: (Direction | null)[]; ema20: number[] } {
  const dir: (Direction | null)[] = [];
  const e20out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const win = bars.slice(Math.max(0, i - window + 1), i + 1).map((k) => Number(k.close));
    const a = ema(win, 20).at(-1)!;
    const b = ema(win, 50).at(-1)!;
    e20out.push(a);
    dir.push(a > b ? 'long' : a < b ? 'short' : null);
  }
  return { dir, ema20: e20out };
}

export interface SeriesBundle {
  base: Kline[];
  h1: Kline[];
  h4: Kline[];
  d1: Kline[];
  funding: { at: number; rate: string }[];
}

/**
 * 把一组 K 线压成逐根度量。`from`/`to` 之外的根只作暖机,不进结果。
 * 返回的 `bars` 与 `metrics` 一一对应(bars[i] 就是 metrics[i] 那根),前瞻结算要用它取隐藏 K 线。
 */
export function computeMetrics(s: SeriesBundle, tf: string, from: number, to: number): { metrics: BarMetrics[]; index: number[] } {
  const bars = s.base;
  const atrArr = rollingAtr(bars, 14);
  const hiIncl = rollingExtreme(bars, 20, 'high', true);
  const loIncl = rollingExtreme(bars, 20, 'low', true);
  const hiPrev = rollingExtreme(bars, 20, 'high', false);
  const loPrev = rollingExtreme(bars, 20, 'low', false);
  const vol = rollingVolRatio(bars, 20);
  const base = windowedEmaDir(bars, 60);
  const h1 = windowedEmaDir(s.h1, 120);
  const h4 = windowedEmaDir(s.h4, 80);
  const h4Atr = rollingAtr(s.h4, 14);
  const floor = atrPctFloor(tf);

  // prior 口径的突破序列(方向各一条),外加"那次突破那根的量比"。
  const brokeUp: boolean[] = [];
  const brokeDown: boolean[] = [];
  for (let i = 0; i < bars.length; i++) {
    const c = Number(bars[i]!.close);
    brokeUp.push(Number.isFinite(hiPrev[i]!) && c > hiPrev[i]!);
    brokeDown.push(Number.isFinite(loPrev[i]!) && c < loPrev[i]!);
  }

  const regimeCache = new Map<number, DailyRegime['regime'] | null>();
  const funding = s.funding;

  const metrics: BarMetrics[] = [];
  const index: number[] = [];
  let lastUp = -1;
  let lastDown = -1;
  for (let i = 0; i < bars.length; i++) {
    if (brokeUp[i]) lastUp = i;
    if (brokeDown[i]) lastDown = i;
    const t = bars[i]!.close_time;
    if (t < from || t > to) continue;
    if (i < 20 || !Number.isFinite(hiPrev[i]!)) continue;
    const close = Number(bars[i]!.close);
    const atr = atrArr[i]!;
    if (!(atr > 0) || !(close > 0)) continue;
    const i1 = lastClosedIndex(s.h1, t);
    const i4 = lastClosedIndex(s.h4, t);
    const iD = lastClosedIndex(s.d1, t);
    let regime: DailyRegime['regime'] | null = null;
    if (iD >= 0) {
      const cached = regimeCache.get(iD);
      if (cached !== undefined) regime = cached;
      else {
        const daily = s.d1.slice(Math.max(0, iD - 259), iD + 1);
        regime = daily.length >= 30 ? (dailyRegime(daily, t)?.regime ?? null) : null;
        regimeCache.set(iD, regime);
      }
    }
    const fIdx = lastFundingIndex(funding, t);
    const h4Dist = i4 >= 0 && h4Atr[i4]! > 0 ? Math.abs(Number(s.h4[i4]!.close) - h4.ema20[i4]!) / h4Atr[i4]! : null;
    metrics.push({
      t,
      close,
      atr,
      atr_pct: (atr / close) * 100,
      atr_floor: floor,
      hi20: hiIncl[i]!,
      lo20: loIncl[i]!,
      hi20_prev: hiPrev[i]!,
      lo20_prev: loPrev[i]!,
      vol_ratio: vol[i]!,
      ema20: base.ema20[i]!,
      dir_h1: i1 >= 0 ? h1.dir[i1]! : null,
      dir_h4: i4 >= 0 ? h4.dir[i4]! : null,
      h4_dist_atr: h4Dist,
      regime,
      funding_abs_pct: fIdx >= 0 ? Math.abs(Number(funding[fIdx]!.rate)) * 100 : null,
      broke_up: brokeUp[i]!,
      broke_down: brokeDown[i]!,
      bars_since_up: lastUp >= 0 ? i - lastUp : -1,
      bars_since_down: lastDown >= 0 ? i - lastDown : -1,
      break_vol_up: lastUp >= 0 ? vol[lastUp]! : null,
      break_vol_down: lastDown >= 0 ? vol[lastDown]! : null,
    });
    index.push(i);
  }
  return { metrics, index };
}

function lastFundingIndex(funding: { at: number }[], t: number): number {
  let lo = 0;
  let hi = funding.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (funding[mid]!.at <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface OutcomeParams {
  /** 止损放在突破位外多少个 ATR。 */
  stop_atr: number;
  /** 第一止盈 = 多少倍止损距离。 */
  tp_r: number;
  /** 最多向前走几根。 */
  horizon_bars: number;
}

export const OUTCOME_DEFAULTS: OutcomeParams = { stop_atr: 0.8, tp_r: 1.5, horizon_bars: 48 };

/**
 * 一个候选点的前瞻结算:下一根开盘市价成交,止损 = 突破位 ∓ stop_atr·ATR(突破位落在成交价错误
 * 一侧时退化成"成交价 ∓ stop_atr·ATR",否则开不了仓),第一止盈 = tp_r 倍止损距离。
 * 同根同触止损优先(outcome.ts 的 fail-pessimistic 口径),到期按收盘价出。
 */
export function scoreCandidate(bars: Kline[], i: number, m: BarMetrics, ev: ConditionEval, p: OutcomeParams): number | null {
  const next = bars[i + 1];
  if (!next) return null;
  const fill = Number(next.open);
  const long = ev.dir === 'long';
  const anchor = long ? Math.min(ev.level, fill) : Math.max(ev.level, fill);
  const stop = long ? anchor - p.stop_atr * m.atr : anchor + p.stop_atr * m.atr;
  const t = openTrade(ev.dir, fill, stop, null);
  if (!t) return null;
  t.tp = long ? fill + p.tp_r * t.stop_distance : fill - p.tp_r * t.stop_distance;
  const end = Math.min(bars.length - 1, i + p.horizon_bars);
  for (let j = i + 1; j <= end; j++) {
    const step = stepTrade(t, bars[j]!);
    if (step.exit) return tradeR(t, step.exit.price);
  }
  return tradeR(t, Number(bars[end]!.close));
}

// ---------------------------------------------------------------- data loading

/** `fetchExchangeInfo` 只收 PERPETUAL,币安的**股票/商品永续是 TRADIFI_PERPETUAL**,要单独判存在性。 */
export async function listTradableSymbols(candidates: string[]): Promise<{ existing: { symbol: string; contract_type: string; onboard: number }[]; missing: string[] }> {
  const base = process.env['TG_DEMO_MARKET_BASE'] ?? 'https://fapi.binance.com';
  const res = await fetch(`${base}/fapi/v1/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo -> HTTP ${res.status}`);
  const info = (await res.json()) as { symbols: { symbol: string; status: string; contractType: string; onboardDate?: number }[] };
  const map = new Map(info.symbols.map((s) => [s.symbol, s]));
  const existing: { symbol: string; contract_type: string; onboard: number }[] = [];
  const missing: string[] = [];
  for (const c of candidates) {
    const s = map.get(c);
    if (s && s.status === 'TRADING') existing.push({ symbol: c, contract_type: s.contractType, onboard: Number(s.onboardDate ?? 0) });
    else missing.push(c);
  }
  return { existing, missing };
}

/** The four kline series + funding history the screener needs, all via backtest.ts’ disk cache. */
export async function loadSeriesBundle(symbol: string, tf: string, from: number, to: number): Promise<SeriesBundle> {
  const step = tfToMs(tf);
  const base = await loadKlines(symbol, tf, from - 60 * step, to);
  const h1 = await loadKlines(symbol, '1h', from - 120 * 3_600_000, to);
  const h4 = await loadKlines(symbol, '4h', from - 80 * 14_400_000, to);
  const d1 = await loadKlines(symbol, '1d', from - 300 * 86_400_000, to);
  let funding: { at: number; rate: string }[] = [];
  try {
    funding = await fetchFundingRateHistory(symbol, 1000, from - 86_400_000);
  } catch {
    funding = [];
  }
  return { base, h1, h4, d1, funding };
}

/** Default screening whitelist: majors plus other liquid USDⓈ-M perpetuals (existence checked by listTradableSymbols). */
export const DEFAULT_SCREEN_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'HYPEUSDT',
  'PENGUUSDT',
  'TSLAUSDT',
  'NVDAUSDT',
  'AAPLUSDT',
  'GOOGLUSDT',
  'AMDUSDT',
  'QQQUSDT',
  'MUUSDT',
  'SNDKUSDT',
  'CRCLUSDT',
  'SPCXUSDT',
  'CLUSDT',
  'XAUUSDT',
  'XAUTUSDT',
  'XAGUSDT',
  'SOXSUSDT',
  'KORUUSDT',
  'TENCENTUSDT',
  'CXMTUSDT',
  'SKHYNIXUSDT',
];
