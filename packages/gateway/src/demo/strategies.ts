// 策略库(design notes;决定稿 §2 E/F;Codex 调研 Part 2)。
//
// 一条策略是一个**不可变的版本化对象**:触发(纯函数,哪些事件才唤醒它)+ 清单(代码必须能算出来的
// 证据)+ 规则(模型只能在这些边里选)+ 参数(带范围,改一个就是新版本 + 新 hash)+ 评测统计。
// 落库的只有数据;触发判定与「清单证据怎么算」是代码,按 strategy id 注册在下面的 registry 里,
// 所以一个策略的新版本换的是数字和措辞,不是行为的实现。
//
// 与长期记忆的分工(design v1 §11「记忆不改数字」):记忆只能 propose,策略参数只能由人点
// 「生成新版本」落成 draft,再一格一格晋升。没有「模型直接 set 参数」的路径。

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { indicatorSnapshot, squeeze } from './indicators.js';
import type { TfFeatures } from './market.js';
import type { ScanThresholds } from './review-metrics.js';
import { reversionStats, type ReversionStats } from './reversion-stats.js';
import type { DailyRegime, Kline, MarketView, TriggerHit, TriggerKind } from './types.js';

// ---------------------------------------------------------------- 数据模型

export type StrategyStatus = 'draft' | 'backtest' | 'shadow' | 'paper' | 'live_capped' | 'retired';
export type StrategyFamily = 'trend_continuation' | 'mtf' | 'volatility' | 'derivatives' | 'mean_reversion';

/** 晋升只能沿这条线一格一格走;retired 不在其中(随时可退役,不可回)。 */
export const STATUS_ORDER: StrategyStatus[] = ['draft', 'backtest', 'shadow', 'paper', 'live_capped'];

export const FAMILY_LABEL: Record<StrategyFamily, string> = {
  trend_continuation: '趋势延续',
  mtf: '多周期',
  volatility: '波动结构',
  derivatives: '衍生品结构',
  mean_reversion: '均值回归',
};

export const STATUS_LABEL: Record<StrategyStatus, string> = {
  draft: '草稿',
  backtest: '回测中',
  shadow: '影子',
  paper: '纸面',
  live_capped: '限额实盘',
  retired: '已退役',
};

export interface StrategyParam {
  value: number;
  min: number;
  max: number;
  unit?: string;
  note?: string;
}

export interface StrategyEvalStats {
  /** 跑过多少次回测。 */
  backtests: number;
  trades: number;
  win_rate: number | null;
  /** 每笔期望 R(平均 R)。 */
  expectancy_r: number | null;
  /** 最大不利偏移的中位数,单位 R(负数)。 */
  mae_r_p50: number | null;
  last_run_id: string | null;
  noise_note: string | null;
}

export const EMPTY_EVAL_STATS: StrategyEvalStats = { backtests: 0, trades: 0, win_rate: null, expectancy_r: null, mae_r_p50: null, last_run_id: null, noise_note: null };

export interface StrategySpec {
  id: string;
  version: number;
  /** sha256(name|family|trigger|checklist|rules|params);status 与 eval_stats 不进 hash。 */
  content_hash: string;
  name: string;
  family: StrategyFamily;
  status: StrategyStatus;
  trigger: {
    /** 只有这些触发种类才唤醒这条策略。 */
    kinds: TriggerKind[];
    /** 低于这个周期不跑(避免 1m 噪声)。 */
    min_timeframe: string;
    /** 同一策略两次开仓之间至少隔多少根。 */
    cooldown_bars: number;
  };
  checklist: {
    /** 代码必须能算出来的证据 id(算不出来就不该让模型按这条策略开仓)。 */
    required: string[];
    timeframes: string[];
  };
  rules: {
    entry: string[];
    invalidation: string[];
    exit: string[];
    sizing_note?: string;
  };
  params: Record<string, StrategyParam>;
  eval_stats: StrategyEvalStats;
  /**
   * 09-07:Strategy Lab 的机械前瞻期望(漏斗法,零模型),按**这个版本**记,不混进 eval_stats(那是含模型的回放成绩)。
   * 只用于 draft→backtest→shadow 这两步「数据态」晋升;paper 及以上仍要 eval_stats + 人批。
   */
  lab_stats?: LabStats | null;
  created_at: number;
  parent_version?: number | null;
}

export interface LabStats {
  run_id: string;
  at: number;
  symbols: number;
  setups: number;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
  total_r: number;
  note: string;
}

/** hash 只覆盖「内容」;status / eval_stats / created_at 是版本行上的可变元数据。 */
export function strategyContentHash(s: Pick<StrategySpec, 'name' | 'family' | 'trigger' | 'checklist' | 'rules' | 'params'>): string {
  const params: Record<string, [number, number, number, string]> = {};
  for (const key of Object.keys(s.params).sort()) {
    const p = s.params[key]!;
    params[key] = [p.value, p.min, p.max, p.unit ?? ''];
  }
  const canonical = JSON.stringify({
    name: s.name,
    family: s.family,
    trigger: { kinds: [...s.trigger.kinds].sort(), min_timeframe: s.trigger.min_timeframe, cooldown_bars: s.trigger.cooldown_bars },
    checklist: { required: [...s.checklist.required].sort(), timeframes: [...s.checklist.timeframes] },
    rules: { entry: s.rules.entry, invalidation: s.rules.invalidation, exit: s.rules.exit, sizing_note: s.rules.sizing_note ?? '' },
    params,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const TF_MINUTES: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '1d': 1440 };
export function tfMinutes(tf: string): number {
  return TF_MINUTES[tf] ?? 15;
}

/** 这条策略会不会被这次触发唤醒(纯函数,不调模型)。 */
export function strategyWakes(s: StrategySpec, timeframe: string, hits: { kind: TriggerKind }[]): boolean {
  if (tfMinutes(timeframe) < tfMinutes(s.trigger.min_timeframe)) return false;
  if (!hits.length) return false;
  return hits.some((h) => s.trigger.kinds.includes(h.kind));
}

// ---------------------------------------------------------------- 内置策略

const p = (value: number, min: number, max: number, unit?: string, note?: string): StrategyParam => ({ value, min, max, ...(unit ? { unit } : {}), ...(note ? { note } : {}) });

type BuiltIn = Omit<StrategySpec, 'content_hash' | 'created_at' | 'version' | 'eval_stats'>;

const BUILTIN_DEFS: BuiltIn[] = [
  {
    id: 'breakout_retest',
    name: '突破-回踩',
    family: 'trend_continuation',
    status: 'paper', // 今天在跑的 playbook 就是它
    trigger: { kinds: ['breakout', 'retest', 'ema_cross'], min_timeframe: '15m', cooldown_bars: 4 },
    checklist: { required: ['scan_checklist', 'daily_regime'], timeframes: ['15m', '1h', '4h'] },
    rules: {
      entry: [
        '方向随 1h EMA20/EMA50;4h 反向只许限价回踩、信心 ≤ 0.5。',
        '回踩确认(收在突破位外侧、量比 ≥ retest_vol_min)→ 市价;刚突破未回踩 → 限价挂突破位与 EMA20 之间。',
        '距突破位 > chase_atr_max ATR 或 ATR% < atr_pct_floor 不做;日线 bear 不做多、bull 不做空,range 要量比 ≥ range_vol_min。',
      ],
      invalidation: ['收盘回到突破位另一侧,或 1h 与 4h 双双转反向。'],
      exit: ['论点未变 HOLD;失效 EXIT;浮盈 ≥ 1R 且结构转弱 REDUCE;挂单远离入场区 INVALIDATE。'],
      sizing_note: '止损在最近 swing 外 ≥ 0.8 ATR,第一止盈 ≥ 1.5 倍止损。',
    },
    params: {
      atr_pct_floor: p(0.4, 0.05, 2, '%', '判断周期的 ATR% 下限'),
      chase_atr_max: p(1.5, 0.5, 3, 'ATR', '距突破位多远就不追'),
      retest_vol_min: p(1, 0.5, 3, '倍', '回踩确认要的量比'),
      range_vol_min: p(1.5, 1, 3, '倍', '日线 range 时突破要的量比'),
      breakout_window: p(1, 1, 24, '根', '突破发生后多少根内,回踩仍然算数'),
    },
  },
  {
    id: 'mtf_alignment',
    name: '多周期对齐',
    family: 'mtf',
    status: 'backtest',
    trigger: { kinds: ['breakout', 'retest', 'ema_cross'], min_timeframe: '5m', cooldown_bars: 4 },
    checklist: { required: ['scan_checklist'], timeframes: ['15m', '1h', '4h'] },
    rules: {
      entry: [
        '5m/15m 出现突破/回踩/EMA 交叉,且 15m 与 1h EMA20/50 同向,方向随之。',
        '4h 只作否决:4h 反向且距 EMA 超 veto_atr ATR 一律不开;4h 同向不算入场理由。',
        '距突破位 ≤ chase_atr_max ATR 才入场,超出只 WATCH。',
      ],
      invalidation: ['确认周期(15m 或 1h)收盘转反向,或价回到触发位另一侧。'],
      exit: ['确认周期仍同向 HOLD;转向 EXIT;浮盈 ≥ 1R 且 15m 收在 EMA20 另一侧 REDUCE。'],
      sizing_note: '止损在触发周期 swing 之外(≥ 0.8 ATR),第一止盈 ≥ 1.5R。',
    },
    params: {
      confirm_tf_count: p(2, 1, 3, '个', '要几个确认周期同向'),
      veto_atr: p(1, 0.3, 3, 'ATR', '4h 反向多远算否决'),
      chase_atr_max: p(1.5, 0.5, 3, 'ATR'),
    },
  },
  {
    id: 'vol_compression_expansion',
    name: '波动压缩→扩张',
    family: 'volatility',
    status: 'backtest',
    trigger: { kinds: ['vol_spike', 'breakout'], min_timeframe: '15m', cooldown_bars: 6 },
    checklist: { required: ['indicator_snapshot', 'scan_checklist'], timeframes: ['15m', '1h'] },
    rules: {
      entry: [
        '先压缩:带宽 90 根分位 ≤ bb_width_rank_max,或 squeeze 连续 ≥ squeeze_bars_min 根。',
        '再扩张:同一根同时突破 + 量比 ≥ vol_spike_min,方向由突破决定。',
        '只做压缩后第一次扩张;已走出 chase_atr_max ATR 不追。',
      ],
      invalidation: ['revert_bars 根内收回压缩区间且量比 < 1,或收盘回到布林中轨另一侧。'],
      exit: ['量比不衰减且价在带外 HOLD;回中轨 EXIT;浮盈 ≥ 1.5R 且量比 < 1 REDUCE。'],
      sizing_note: '止损在压缩区间另一端外(≥ 1 ATR);第一止盈 ≥ 2R,靠少数大赢家。',
    },
    params: {
      bb_width_rank_max: p(20, 5, 40, '%', '带宽 90 根分位上限'),
      squeeze_bars_min: p(6, 3, 20, '根', 'squeeze 连续根数'),
      vol_spike_min: p(1.8, 1.2, 4, '倍', '扩张那根的量比'),
      revert_bars: p(2, 1, 5, '根', '几根内收回算失效'),
      chase_atr_max: p(1.5, 0.5, 3, 'ATR'),
    },
  },
  {
    id: 'funding_oi_extreme',
    name: '资金费率/OI 极值',
    family: 'derivatives',
    status: 'backtest',
    trigger: { kinds: ['funding', 'fast_move'], min_timeframe: '15m', cooldown_bars: 8 },
    checklist: { required: ['funding_stats', 'scan_checklist'], timeframes: ['15m', '1h', '4h'] },
    rules: {
      entry: [
        '|费率| ≥ funding_abs_min 且 30 天 z ≥ funding_z_min 才算极值,只看绝对值不算。',
        'fade:正极值 + OI 降 ≥ oi_change_min 做空;负极值 + OI 降做多。',
        'follow:极值但 OI 仍升且 1h/4h 同向 → 只许顺势限价挂回踩。',
        '距结算 minutes_before_funding 分钟内不新开。',
      ],
      invalidation: ['费率回到 ±0.02% 内而价未跟随,或 OI 回升且价反向走出 1 ATR。'],
      exit: ['费率仍极端且论点未破 HOLD;归一且浮盈 > 0 REDUCE;归一且论点已破 EXIT。'],
      sizing_note: '条件性策略:止损 ≥ 1.2 ATR,仓位不超常规,第一止盈 1.5R。',
    },
    params: {
      funding_abs_min: p(0.05, 0.01, 0.5, '%', '费率绝对值门槛'),
      funding_z_min: p(2, 1, 4, 'σ', '30 天 z-score 门槛'),
      oi_change_min: p(1, 0.2, 10, '%', 'OI 1h 变化确认门槛'),
      minutes_before_funding: p(30, 0, 240, '分钟', '结算前多久不开新仓'),
    },
  },
  {
    id: 'range_mean_reversion',
    name: '区间均值回归',
    family: 'mean_reversion',
    status: 'backtest',
    trigger: { kinds: ['fast_move', 'vol_spike', 'kline_close'], min_timeframe: '15m', cooldown_bars: 6 },
    checklist: { required: ['reversion_stats', 'indicator_snapshot', 'daily_regime'], timeframes: ['15m', '1h', '4h'] },
    rules: {
      entry: [
        '只在震荡:日线 range 或 ADX14 < adx_max。',
        '价距 EMA20 ≥ dev_atr_min ATR,反着偏离方向做。',
        '「回归统计」里 horizon_bars 根内回归比例 < min_reversion_prob 不做。',
        '目标 EMA20/VWAP,不加仓摊平。',
      ],
      invalidation: ['收盘再偏离 0.5 ATR,或 ADX14 升破 25 / 日线转 trend。'],
      exit: ['触及 EMA20 EXIT;超回归中位根数 2 倍未回归 EXIT;浮盈 ≥ 1R 且走完一半 REDUCE。'],
      sizing_note: '止损在偏离方向再 stop_atr ATR;高胜率低盈亏比,止盈即 EMA20。',
    },
    params: {
      dev_atr_min: p(2, 1, 4, 'ATR', '偏离 EMA20 多少个 ATR 才算'),
      adx_max: p(20, 10, 30, '', '4h/判断周期 ADX 上限'),
      horizon_bars: p(12, 4, 48, '根', '回归观察窗口'),
      min_reversion_prob: p(55, 30, 90, '%', '历史回归比例下限'),
      stop_atr: p(1, 0.5, 2, 'ATR'),
    },
  },
];

/** 内置策略的初版(version 1);seed 与 estimate 的兜底都用它。 */
export const BUILTIN_STRATEGIES: StrategySpec[] = BUILTIN_DEFS.map((d) => ({
  ...d,
  version: 1,
  content_hash: strategyContentHash(d),
  eval_stats: { ...EMPTY_EVAL_STATS },
  created_at: 0,
  parent_version: null,
}));

export const BUILTIN_IDS: string[] = BUILTIN_STRATEGIES.map((s) => s.id);
/** workflow.active_strategies 的默认值:今天在跑的那一条。 */
export const DEFAULT_ACTIVE_STRATEGIES = ['breakout_retest'];

// ---------------------------------------------------------------- 清单证据(代码计算)

export interface StrategyEvidenceInput {
  now: number;
  symbol: string;
  timeframe: string;
  features: TfFeatures[];
  /** 该时刻可见的 K 线,按周期;回测里是 visibleWindow 切出来的,实盘是刚拉的。 */
  klines?: Record<string, Kline[]>;
  market: MarketView;
  oi_change_1h_pct: number | null;
  /** 近 30 天资金费率历史(fapi/v1/fundingRate);缺就退化成「不可得」。 */
  funding_history?: { at: number; rate: string }[];
  daily_regime?: DailyRegime | null;
  trigger_hits?: TriggerHit[];
}

export interface StrategyEvidenceLine {
  label: string;
  value: string;
  observed_at: number;
  source: string;
}

export type StrategyEvidenceFn = (spec: StrategySpec, inp: StrategyEvidenceInput) => StrategyEvidenceLine[];

const val = (s: StrategySpec, key: string, fallback: number): number => s.params[key]?.value ?? fallback;

function baseBars(inp: StrategyEvidenceInput): Kline[] {
  return inp.klines?.[inp.timeframe] ?? [];
}

/** 均值:样本量 < 2 返回 null。 */
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function stdev(xs: number[], m: number): number | null {
  if (xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** 资金费率 30 天 z-score(用历史序列;历史缺失时返回 null 而不是编一个 0)。 */
export function fundingZScore(history: { at: number; rate: string }[] | undefined, current: number, now: number, days = 30): { z: number | null; samples: number; mean: number | null; sd: number | null } {
  const cutoff = now - days * 86_400_000;
  const xs = (history ?? []).filter((f) => f.at >= cutoff && f.at <= now).map((f) => Number(f.rate)).filter((n) => Number.isFinite(n));
  const m = mean(xs);
  const sd = m === null ? null : stdev(xs, m);
  const z = m === null || sd === null || sd === 0 ? null : (current - m) / sd;
  return { z, samples: xs.length, mean: m, sd };
}

/** id → 该策略要往上下文里加的「清单证据」行。没有条目 = 复用现有的扫描清单,不加行。 */
export const STRATEGY_EVIDENCE: Record<string, StrategyEvidenceFn> = {
  // 突破-回踩 / 多周期对齐:完全复用「扫描清单(代码计算)」的字段,不新增证据行(决定稿 §2 E:零新字段)。
  breakout_retest: () => [],
  mtf_alignment: () => [],

  vol_compression_expansion: (spec, inp) => {
    const bars = baseBars(inp);
    if (bars.length < 30) return [{ label: '压缩状态(代码计算)', value: `可见 K 线不足(${bars.length} 根),带宽分位/squeeze 不可得——本次不得按本策略 PROPOSE`, observed_at: inp.now, source: 'indicators.ts(数据不足)' }];
    const snap = indicatorSnapshot(bars, inp.timeframe);
    const sq = squeeze(bars);
    const last = sq[sq.length - 1] ?? snap?.squeeze ?? null;
    const rank = snap?.bb_width_rank_90 ?? null;
    const atrRank = snap?.atr_pct_rank_90 ?? null;
    const barsOn = last?.bars_on ?? 0;
    const rankMax = val(spec, 'bb_width_rank_max', 20);
    const barsMin = val(spec, 'squeeze_bars_min', 6);
    const compressed = (rank !== null && rank <= rankMax) || barsOn >= barsMin;
    const volRatio = inp.features[0]?.vol_ratio_20 ?? null;
    const spikeMin = val(spec, 'vol_spike_min', 1.8);
    const value = [
      `带宽 90 根分位 ${rank === null ? 'n/a' : `${rank.toFixed(0)}%`}(门槛 ≤ ${rankMax}%)`,
      `ATR% 90 根分位 ${atrRank === null ? 'n/a' : `${atrRank.toFixed(0)}%`}`,
      `squeeze ${last?.on ? '开' : '关'},已连续 ${barsOn} 根(门槛 ≥ ${barsMin} 根)`,
      `压缩成立=${compressed ? '是' : '否'}`,
      `当根量比 ${volRatio === null ? 'n/a' : volRatio.toFixed(2)}(扩张门槛 ≥ ${spikeMin})`,
      `扩张成立=${compressed && volRatio !== null && volRatio >= spikeMin ? '是' : '否'}(还需同根出现突破)`,
    ].join(';');
    return [{ label: '压缩→扩张清单(代码计算)', value, observed_at: bars[bars.length - 1]?.close_time ?? inp.now, source: 'indicatorSnapshot()+squeeze()' }];
  },

  funding_oi_extreme: (spec, inp) => {
    const cur = inp.market.funding_rate === '' ? null : Number(inp.market.funding_rate);
    if (cur === null || !Number.isFinite(cur)) {
      return [{ label: '资金费率极值(代码计算)', value: '这个时刻取不到资金费率——本次不得按本策略 PROPOSE', observed_at: inp.now, source: 'fapi premiumIndex(缺失)' }];
    }
    const { z, samples, mean: m, sd } = fundingZScore(inp.funding_history, cur, inp.now);
    const absMin = val(spec, 'funding_abs_min', 0.05);
    const zMin = val(spec, 'funding_z_min', 2);
    const oiMin = val(spec, 'oi_change_min', 1);
    const curPct = cur * 100;
    const minsToFunding = Math.max(0, Math.round((inp.market.next_funding_at - inp.now) / 60_000));
    const oi = inp.oi_change_1h_pct;
    const extreme = Math.abs(curPct) >= absMin && z !== null && Math.abs(z) >= zMin;
    const value = [
      `当前费率 ${curPct.toFixed(4)}%(绝对值门槛 ${absMin}%)`,
      samples ? `30 天样本 ${samples} 次,均值 ${((m ?? 0) * 100).toFixed(4)}%,标准差 ${((sd ?? 0) * 100).toFixed(4)}%,z=${z === null ? 'n/a' : z.toFixed(2)}(门槛 ${zMin})` : '30 天历史不可得,z 无法计算',
      `极值成立=${extreme ? '是' : '否'}`,
      `OI 较 1h 前 ${oi === null ? 'n/a' : `${oi >= 0 ? '+' : ''}${oi.toFixed(2)}%`}(确认门槛 ±${oiMin}%,下降→fade,上升→只顺势限价)`,
      `距下次结算 ${minsToFunding} 分钟(${val(spec, 'minutes_before_funding', 30)} 分钟内不新开)`,
    ].join(';');
    return [{ label: '资金费率极值(代码计算)', value, observed_at: inp.market.as_of, source: 'fapi fundingRate 历史 + openInterestHist' }];
  },

  range_mean_reversion: (spec, inp) => {
    const out: StrategyEvidenceLine[] = [];
    const bars = baseBars(inp);
    const horizon = Math.round(val(spec, 'horizon_bars', 12));
    const devMin = val(spec, 'dev_atr_min', 2);
    const stats: ReversionStats | null = bars.length ? reversionStats(bars, { tf: inp.timeframe, horizons: [...new Set([6, 12, 24, horizon])].sort((a, b) => a - b) }) : null;
    out.push(
      stats
        ? { label: '回归统计(代码计算)', value: stats.text, observed_at: bars[bars.length - 1]?.close_time ?? inp.now, source: 'reversionStats()' }
        : { label: '回归统计(代码计算)', value: `可见 K 线 ${bars.length} 根,不足 400 根,历史回归概率不可得——本次不得按本策略 PROPOSE`, observed_at: inp.now, source: 'reversionStats()(样本不足)' },
    );
    const base = inp.features[0];
    if (base) {
      const dev = base.atr14 > 0 ? (base.last_close - base.ema20) / base.atr14 : null;
      const snap = bars.length >= 30 ? indicatorSnapshot(bars, inp.timeframe) : null;
      const adx = snap?.adx14?.adx ?? null;
      const adxMax = val(spec, 'adx_max', 20);
      const ranging = (inp.daily_regime?.regime === 'range') || (adx !== null && adx < adxMax);
      out.push({
        label: '偏离/震荡清单(代码计算)',
        value: [
          `价距 EMA20 ${dev === null ? 'n/a' : `${dev >= 0 ? '+' : ''}${dev.toFixed(2)} ATR`}(门槛 ${devMin} ATR,${dev !== null && dev > 0 ? '在上方→只考虑做空' : '在下方→只考虑做多'})`,
          `ADX14 ${adx === null ? 'n/a' : adx.toFixed(1)}(上限 ${adxMax})`,
          `日线状态 ${inp.daily_regime?.regime ?? 'n/a'}`,
          `震荡成立=${ranging ? '是' : '否'};偏离成立=${dev !== null && Math.abs(dev) >= devMin ? '是' : '否'}`,
        ].join(';'),
        observed_at: base.last_open_time,
        source: 'indicatorSnapshot()+dailyRegime()',
      });
    }
    return out;
  },
};

/**
 * 一条策略的参数 → 扫描清单要用的门槛(`scanChecklist(features, klines, thresholds)`)。
 *
 * 刻意**不**映射 `atr_pct_floor`:决定稿 §2 采纳 B 已经把 ATR% 门槛从"一个 0.4%"改成
 * review-metrics.ts 里的分周期表(15m 0.15%),策略参数里那个 0.4 是改之前的遗留值,拿它去覆盖
 * 分周期表等于把 15m 重新封死。其余三个是真正由策略版本决定的数。
 */
export function scanThresholdsOf(spec: StrategySpec): ScanThresholds {
  return {
    // 兜底值刻意写死而不是 import review-metrics 的常量:那会给 strategies.ts 加一条到 market.ts 的
    // 模块边,而 market.ts 的 base URL 曾经是 import 时求值的(见 market.ts `fapi()`)。数值同源于
    // CHASE_ATR_MAX / RETEST_VOL_MIN / BREAKOUT_WINDOW,由 funnel.test.ts 钉住。
    chase_atr_max: spec.params['chase_atr_max']?.value ?? 1.5,
    retest_vol_min: spec.params['retest_vol_min']?.value ?? 1,
    breakout_window: spec.params['breakout_window']?.value ?? 1,
  };
}

/**
 * `breakout_retest` v2 的草稿(design notes)。开机时若不存在
 * 就生成一次,状态停在 `backtest`(不是 active,也进不了实盘 —— 实盘只认 ≥ paper,`resolve()` 会退回
 * 到仍是 paper 的 v1)。参数依据是漏斗跑出来的真数:窗口 1 根让"突破-回踩"这个形态整个不可达,
 * 量比放在回踩那根天然不成立;把两处改掉是 27 币 60 天里唯一能把机械期望拉回 0 附近的组合。
 */
export const BREAKOUT_RETEST_V2: { params: Record<string, number>; rules: Partial<StrategySpec['rules']> } = {
  params: { breakout_window: 12, retest_vol_min: 2 },
  rules: {
    entry: [
      '方向随 1h EMA20/EMA50;4h 反向只许限价回踩、信心 ≤ 0.5。',
      '突破发生在最近 breakout_window 根内(与突破位比的是**该根之前**的 20 根高/低),且那根量比 ≥ retest_vol_min → 现在的回踩可以做;回踩那根本身缩量不算否决。',
      '距突破位 > chase_atr_max ATR 或 ATR% < 分周期门槛不做;日线 bear 不做多、bull 不做空,range 要量比 ≥ range_vol_min。',
    ],
  },
};

export function ensureBreakoutRetestV2(lib: StrategyLibrary, now = Date.now()): StrategySpec | null {
  const head = lib.head('breakout_retest');
  if (!head) return null;
  // Idempotent by content, not by version number: a user-made draft must not block (or be mistaken for) the
  // relaxed variant. It exists iff some version already carries the v2 breakout_window value.
  const want = BREAKOUT_RETEST_V2.params['breakout_window'];
  if (lib.versions('breakout_retest').some((v) => v.params['breakout_window']?.value === want && v.params['retest_vol_min']?.value === BREAKOUT_RETEST_V2.params['retest_vol_min'])) return null;
  if (!head.params['breakout_window']) return null; // 老库还没回填这个旋钮,下次开机再说
  const { spec } = lib.createVersion('breakout_retest', { params: { ...BREAKOUT_RETEST_V2.params }, rules: { ...BREAKOUT_RETEST_V2.rules } }, { now });
  if (!spec) return null;
  return lib.promote('breakout_retest', 'backtest').spec ?? spec;
}

export function strategyEvidence(spec: StrategySpec, inp: StrategyEvidenceInput): StrategyEvidenceLine[] {
  const fn = STRATEGY_EVIDENCE[spec.id];
  if (!fn) return [];
  try {
    return fn(spec, inp);
  } catch (e) {
    return [{ label: `${spec.name} 清单(代码计算)`, value: `清单计算失败:${(e as Error).message.slice(0, 120)}——本次不得按本策略 PROPOSE`, observed_at: inp.now, source: 'strategyEvidence()' }];
  }
}

// ---------------------------------------------------------------- 渲染进 prompt

/** 一条策略在 system prompt 里的样子;刻意短(两条 active 加起来 ≤ ~900 字)。 */
export function renderStrategy(s: StrategySpec): string {
  const params = Object.entries(s.params).map(([k, v]) => `${k}=${v.value}${v.unit ?? ''}`).join(' ');
  const lines = [`【${s.id}·${s.name} v${s.version}】`, `入场:${s.rules.entry.join('')}`, `失效:${s.rules.invalidation.join('')}`, `离场:${s.rules.exit.join('')}`];
  if (s.rules.sizing_note) lines.push(`仓位:${s.rules.sizing_note}`);
  if (params) lines.push(`参数:${params}`);
  return lines.join('\n');
}

export function renderStrategies(specs: StrategySpec[]): string {
  return specs.map(renderStrategy).join('\n');
}

// ---------------------------------------------------------------- 持久化

interface Row {
  json: string;
}

export interface PromoteResult {
  spec: StrategySpec | null;
  error: string | null;
}

export class StrategyLibrary {
  constructor(private readonly db: DatabaseSync) {}

  /** 首次启动写入内置策略;已存在的 (id, version 1) 一律不动 → 幂等。返回新写入的条数。 */
  seed(now = Date.now()): number {
    let n = 0;
    for (const s of BUILTIN_STRATEGIES) {
      const stored = this.version(s.id, 1);
      if (stored) {
        this.backfillParams(stored, s);
        continue;
      }
      this.write({ ...s, created_at: now });
      n++;
    }
    return n;
  }

  /**
   * 内置策略 v1 的**结构**补齐:代码里新加了一个旋钮(比如 `breakout_window`),而库里那行 v1 是加之前
   * 写的 —— 不补的话 `createVersion` 会说"策略没有参数 breakout_window",这个旋钮就永远调不了。
   *
   * 只加不改:已经存在的参数(value/min/max)一个字都不动,所以 v1 的**行为**完全不变;补进去的默认值
   * 就是"现行行为"(breakout_window=1)。这不是改参数,是把旧行迁到新结构上,和 §「不可变版本对象」
   * 的红线不冲突 —— 那条红线管的是"谁能改一条在跑的策略的数字",答案仍然是:只能生成新版本。
   */
  private backfillParams(stored: StrategySpec, builtin: StrategySpec): void {
    const missing = Object.keys(builtin.params).filter((k) => !stored.params[k]);
    if (!missing.length) return;
    const params = { ...stored.params };
    for (const k of missing) params[k] = { ...builtin.params[k]! };
    const next: StrategySpec = { ...stored, params };
    this.write({ ...next, content_hash: strategyContentHash(next) });
  }

  private write(s: StrategySpec): void {
    this.db
      .prepare(
        `INSERT INTO demo_strategy_version(id, version, content_hash, status, name, family, parent_version, created_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, version) DO UPDATE SET status = excluded.status, json = excluded.json`,
      )
      .run(s.id, s.version, s.content_hash, s.status, s.name, s.family, s.parent_version ?? null, s.created_at, JSON.stringify(s));
  }

  version(id: string, version: number): StrategySpec | null {
    const r = this.db.prepare('SELECT json FROM demo_strategy_version WHERE id = ? AND version = ?').get(id, version) as Row | undefined;
    return r ? (JSON.parse(r.json) as StrategySpec) : null;
  }

  /** 一条策略的所有版本,新的在前。 */
  versions(id: string): StrategySpec[] {
    const rows = this.db.prepare('SELECT json FROM demo_strategy_version WHERE id = ? ORDER BY version DESC').all(id) as unknown as Row[];
    return rows.map((r) => JSON.parse(r.json) as StrategySpec);
  }

  /** 最新版本(head)。 */
  head(id: string): StrategySpec | null {
    const rows = this.db.prepare('SELECT json FROM demo_strategy_version WHERE id = ? ORDER BY version DESC LIMIT 1').all(id) as unknown as Row[];
    return rows[0] ? (JSON.parse(rows[0].json) as StrategySpec) : null;
  }

  /** 每条策略的 head,按 id 排序。 */
  list(opts: { include_retired?: boolean } = {}): StrategySpec[] {
    const ids = (this.db.prepare('SELECT DISTINCT id FROM demo_strategy_version ORDER BY id ASC').all() as { id: string }[]).map((r) => r.id);
    const out: StrategySpec[] = [];
    for (const id of ids) {
      const h = this.head(id);
      if (!h) continue;
      if (!opts.include_retired && h.status === 'retired') continue;
      out.push(h);
    }
    return out;
  }

  /**
   * 把 workflow.active_strategies / 回测参数里的 id 解析成 head 版本。
   * `allow_below_paper` = 回测/影子允许;实盘只认 status ≥ paper(决定稿 §2 F)。
   */
  resolve(ids: string[], opts: { allow_below_paper?: boolean } = {}): { specs: StrategySpec[]; errors: string[] } {
    const specs: StrategySpec[] = [];
    const errors: string[] = [];
    for (const id of [...new Set(ids)]) {
      const s = this.head(id);
      if (!s) {
        errors.push(`策略 ${id} 不在策略库里`);
        continue;
      }
      if (s.status === 'retired') {
        errors.push(`策略 ${id} 已退役`);
        continue;
      }
      if (!opts.allow_below_paper && STATUS_ORDER.indexOf(s.status) < STATUS_ORDER.indexOf('paper')) {
        // head 是个还没晋升的新版本(草稿/回测中)时,实盘继续跑**仍然是 paper 的那一版**,而不是
        // 整条策略静默失效。没有这一步,"生成一个 v2 草稿去回测"会顺手把线上判断的策略清空。
        const fallback = this.versions(id).find((v) => v.status !== 'retired' && STATUS_ORDER.indexOf(v.status) >= STATUS_ORDER.indexOf('paper'));
        if (!fallback) {
          errors.push(`策略 ${id} 状态是 ${s.status},未到 paper,不能在实盘判断里启用`);
          continue;
        }
        specs.push(fallback);
        continue;
      }
      specs.push(s);
    }
    return { specs, errors };
  }

  /** 从提案生成一个新 draft 版本(参数只能落在各自 [min,max] 内)。 */
  createVersion(id: string, patch: { params?: Record<string, number>; rules?: Partial<StrategySpec['rules']>; name?: string }, opts: { now?: number } = {}): { spec: StrategySpec | null; error: string | null } {
    const head = this.head(id);
    if (!head) return { spec: null, error: `策略 ${id} 不存在` };
    const params: StrategySpec['params'] = {};
    for (const [k, v] of Object.entries(head.params)) params[k] = { ...v };
    for (const [k, v] of Object.entries(patch.params ?? {})) {
      const cur = params[k];
      if (!cur) return { spec: null, error: `策略 ${id} 没有参数 ${k}` };
      const n = Number(v);
      if (!Number.isFinite(n)) return { spec: null, error: `参数 ${k} 必须是数字` };
      if (n < cur.min || n > cur.max) return { spec: null, error: `参数 ${k} = ${n} 超出范围 [${cur.min}, ${cur.max}]` };
      params[k] = { ...cur, value: n };
    }
    const rules: StrategySpec['rules'] = {
      entry: patch.rules?.entry ?? head.rules.entry,
      invalidation: patch.rules?.invalidation ?? head.rules.invalidation,
      exit: patch.rules?.exit ?? head.rules.exit,
      ...(patch.rules?.sizing_note ?? head.rules.sizing_note ? { sizing_note: patch.rules?.sizing_note ?? head.rules.sizing_note } : {}),
    };
    const name = (patch.name ?? head.name).slice(0, 40);
    const content = { name, family: head.family, trigger: head.trigger, checklist: head.checklist, rules, params };
    const hash = strategyContentHash(content);
    if (hash === head.content_hash) return { spec: null, error: '内容没有变化,不生成新版本' };
    const spec: StrategySpec = {
      ...head,
      ...content,
      version: head.version + 1,
      content_hash: hash,
      status: 'draft',
      eval_stats: { ...EMPTY_EVAL_STATS },
      lab_stats: null, // 新版本没有任何证据,不继承上一版的 Lab 数据
      created_at: opts.now ?? Date.now(),
      parent_version: head.version,
    };
    this.write(spec);
    return { spec, error: null };
  }

  /** 晋升门(design 稿 §5):只往前走一格,且要过对应的统计门。 */
  promoteGate(s: StrategySpec, to: StrategyStatus, opts: { confirm?: boolean } = {}): string | null {
    if (s.status === 'retired') return '已退役的策略不能晋升,先生成新版本';
    const from = STATUS_ORDER.indexOf(s.status);
    const next = STATUS_ORDER.indexOf(to);
    if (next < 0) return `不能晋升到 ${to}`;
    if (next !== from + 1) return `只能一格一格晋升:${s.status} 的下一格是 ${STATUS_ORDER[from + 1] ?? '(没有了)'}`;
    if (to === 'shadow') {
      // 09-07:Lab 的机械期望(lab_stats)也能把它送到 shadow——shadow 只是「值得盯」,不是成绩;paper 及以上仍只认 eval_stats。
      const lab = s.lab_stats ?? null;
      // 首跑真数据:1505 笔 0.003R 也算「>0」就晋了 shadow——那是噪声。Lab 口径要 ≥0.1R 才算值得盯。
      const labOk = lab !== null && lab.n >= 20 && lab.expectancy_r !== null && lab.expectancy_r >= 0.1;
      if (!labOk) {
        if (s.eval_stats.backtests < 1) return lab ? `Lab 期望 ${lab.expectancy_r === null ? 'n/a' : lab.expectancy_r.toFixed(2)}R/${lab.n} 笔不够(要 ≥20 笔且期望为正),或至少跑过 1 次回测` : '至少要跑过 1 次回测(或等 Lab 实验给出 ≥20 笔正期望)';
        if (s.eval_stats.trades < 20) return `回测成交数 ${s.eval_stats.trades},不足 20 笔`;
      }
    }
    if (to === 'paper') {
      if (s.eval_stats.expectancy_r === null) return '还没有期望 R,先跑回测';
      if (s.eval_stats.expectancy_r <= 0) return `期望 R = ${s.eval_stats.expectancy_r.toFixed(2)},不为正`;
    }
    if (to === 'live_capped' && !opts.confirm) return '进限额实盘必须人工确认(confirm=true)';
    return null;
  }

  promote(id: string, to: StrategyStatus, opts: { confirm?: boolean } = {}): PromoteResult {
    const head = this.head(id);
    if (!head) return { spec: null, error: `策略 ${id} 不存在` };
    const gate = this.promoteGate(head, to, opts);
    if (gate) return { spec: null, error: gate };
    const next: StrategySpec = { ...head, status: to };
    this.write(next);
    return { spec: next, error: null };
  }

  retire(id: string): PromoteResult {
    const head = this.head(id);
    if (!head) return { spec: null, error: `策略 ${id} 不存在` };
    if (head.status === 'retired') return { spec: head, error: null };
    const next: StrategySpec = { ...head, status: 'retired' };
    this.write(next);
    return { spec: next, error: null };
  }

  /** 09-07:Lab 实验结果按精确版本写回(不动 eval_stats)。版本不存在 → null。 */
  updateLabStats(id: string, version: number, stats: LabStats): StrategySpec | null {
    const s = this.version(id, version);
    if (!s) return null;
    const next: StrategySpec = { ...s, lab_stats: stats };
    this.write(next);
    return next;
  }

  /** 回测跑完后更新这条策略 head 的评测统计(累加 backtests,其余覆盖成最近一次)。 */
  updateEvalStats(id: string, stats: Omit<StrategyEvalStats, 'backtests'>): StrategySpec | null {
    const head = this.head(id);
    if (!head) return null;
    const next: StrategySpec = { ...head, eval_stats: { ...stats, backtests: head.eval_stats.backtests + 1 } };
    this.write(next);
    return next;
  }
}
