/**
 * 回放页(v3.4,design notes;design notes):
 * 把历史 K 线逐根重放,判断随游标推进逐条浮现——回放到哪里才看得到那里的判断,和 agent 当时
 * 看到的一模一样(盲测的可视化)。
 *
 * 自己起一个 lightweight-charts 实例(不复用 TradeChart:那个是「一次喂全量」,这里要按游标切前缀),
 * 图表选项/配色/标记/价格线的写法照抄 components/trade-chart.tsx。
 *
 * react-query key 约定见 src/App.tsx 顶部注释:
 *   ['klines-history', symbol, interval, from, to]  历史 K 线(网关往回翻页,单次 ≤ 20000 根)
 *   ['backtest']                                    回测列表(SSE backtest.changed 失效)
 *   ['backtest', id]                                回测详情(running 时 2s 轮询兜底)
 *   ['symbols'] / ['overview']                      币种表 + 观察列表
 * 本页不自己开 /api/events,SSE 由 App.tsx 独占。
 *
 * 花钱红线:startBacktest 之前**必须**先 estimate,并把 ¥ 原样念进确认框。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CandlestickSeries,
  ColorType,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Ban, Calculator, Pause, Play, SkipBack, SkipForward, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type {
  AttributionKind,
  AttributionPoint,
  BacktestEstimate,
  BacktestMode,
  BacktestRun,
  BacktestStatus,
  BacktestStep,
  BacktestTrade,
  Direction,
  Kline,
} from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pane, Workspace } from '@/components/pane';
import { SymbolPicker } from '@/components/symbol-picker';
import { intervalMs } from '@/components/trade-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { CHART_COLORS } from '@/lib/chart-colors';
import { fmtPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import { getLang, t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 常量与小工具

const INTERVALS = ['5m', '15m', '1h', '4h'] as const;
type ReplayInterval = (typeof INTERVALS)[number];

const SPEEDS = [1, 5, 20] as const;
type Speed = (typeof SPEEDS)[number];

/** 1× 时每根 K 线停留 500ms。 */
const BASE_STEP_MS = 500;

/** 默认区间:15m 下 2880 根 = 最近 30 天;换周期按同样根数换算。 */
const DEFAULT_BARS = 2880;
/** 「再往前加载」每次往前推的根数。 */
const EXTEND_BARS = 2880;
/** 网关单次历史请求的硬上限(GET /api/market/klines/history 的 max_bars),取不到时的兜底值。 */
const FALLBACK_MAX_BARS = 20_000;
/** 图表默认铺满多少根;用户缩放后跟着用户走。 */
const DEFAULT_VIEW_BARS = 180;

const MODE_LABEL: Record<BacktestMode, string> = tmap({ triggers: '触发点', every_close: '每根收盘' });
const STATUS_LABEL: Record<BacktestStatus, string> = tmap({
  queued: '排队中',
  running: '跑着',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
});

/** v3.5 归因提议的三种类型(design notes);归因只提议,永不自动落地。 */
const ATTRIBUTION_KIND_LABEL: Record<AttributionKind, string> = tmap({
  rule_wording: '改措辞',
  param: '改参数',
  checklist_item: '加清单项',
});

function attributionKindClass(kind: AttributionKind): string {
  if (kind === 'param') return 'bg-primary/15 text-primary border-primary/30';
  if (kind === 'checklist_item') return 'bg-warn/15 text-warn border-warn/30';
  return 'bg-muted text-muted-foreground border-transparent';
}

/** 回测最多带 4 条策略(网关侧硬截),超过就不给再勾。 */
const MAX_STRATEGIES = 4;

/** datetime-local 的 value 是本地时间,补零到 YYYY-MM-DDTHH:mm。 */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 最后一根 open_time ≤ at 的 K 线下标;找不到返回 -1。 */
function barIndexAt(bars: Kline[], at: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = bars[mid];
    if (!b) break;
    if (at < b.open_time) hi = mid - 1;
    else {
      ans = mid;
      lo = mid + 1;
    }
  }
  return ans;
}

/** 把一个毫秒时刻对齐到所在 K 线的开盘时间(缺口就按周期取整)。 */
function alignToBar(bars: Kline[], at: number, step: number): number {
  const i = barIndexAt(bars, at);
  const b = i >= 0 ? bars[i] : undefined;
  if (b && b.close_time >= at) return b.open_time;
  return Math.floor(at / step) * step;
}

function fmtCny(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return t('订阅额度,不计费');
  return `¥${v.toFixed(3)}`;
}

function fmtR(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`;
}

function shortActionLabel(action: string | null, direction: Direction | null): string {
  switch (action) {
    case 'PROPOSE':
      return direction === 'short' ? t('提议做空') : t('提议做多');
    case 'ADD':
      return direction === 'short' ? t('加空') : t('加多');
    case 'WATCH':
      return t('观察');
    case 'HOLD':
      return t('持有');
    case 'REDUCE':
      return t('减仓');
    case 'EXIT':
      return t('离场');
    case 'INVALIDATE':
      return t('论点失效');
    case 'NO_TRADE':
      return t('不交易');
    default:
      return action ?? t('判断失败');
  }
}

/** 配色沿用全站口径:绿/红只表示多/空或盈亏,其余用主色/琥珀/灰。 */
function stepBadgeClass(action: string | null, direction: Direction | null): string {
  if (action === 'PROPOSE' || action === 'ADD') {
    if (direction === 'short') return 'bg-down/15 text-down border-down/30';
    if (direction === 'long') return 'bg-up/15 text-up border-up/30';
    return 'bg-primary/15 text-primary border-primary/30';
  }
  if (action === 'WATCH' || action === 'REDUCE') return 'bg-warn/15 text-warn border-warn/30';
  if (action === 'EXIT' || action === 'INVALIDATE') return 'bg-down/15 text-down border-down/30';
  return 'bg-muted text-muted-foreground border-transparent'; // NO_TRADE / HOLD / 判断失败
}

interface Committed {
  symbol: string;
  interval: ReplayInterval;
  from: number;
  to: number;
}

// ---------------------------------------------------------------------------
// 页面

export function ReplayPage() {
  const queryClient = useQueryClient();

  // --- 工具条草稿 / 已提交区间 -------------------------------------------------
  const initial = useMemo<Committed>(() => {
    const to = Date.now();
    return { symbol: 'BTCUSDT', interval: '15m', from: to - DEFAULT_BARS * intervalMs('15m'), to };
  }, []);
  const [draftSymbol, setDraftSymbol] = useState(initial.symbol);
  const [draftInterval, setDraftInterval] = useState<ReplayInterval>(initial.interval);
  const [draftFrom, setDraftFrom] = useState(() => toLocalInput(initial.from));
  const [draftTo, setDraftTo] = useState(() => toLocalInput(initial.to));
  const [committed, setCommitted] = useState<Committed>(initial);

  const symbolsQ = useQuery({ queryKey: ['symbols'], queryFn: api.symbols, staleTime: 300_000 });
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, staleTime: 10_000 });
  const watchlist = overviewQ.data?.workflow.watchlist ?? [];

  /** 换周期就把起始时间按同样根数重算——4h 的「最近 30 天」只有 180 根,不是用户想要的。 */
  const pickInterval = (item: ReplayInterval) => {
    setDraftInterval(item);
    const to = fromLocalInput(draftTo) ?? Date.now();
    setDraftFrom(toLocalInput(to - DEFAULT_BARS * intervalMs(item)));
  };

  const commit = () => {
    const from = fromLocalInput(draftFrom);
    const to = fromLocalInput(draftTo);
    if (from === null || to === null) {
      toast.error(t('起止时间填得不对'));
      return;
    }
    if (to <= from) {
      toast.error(t('结束时间要晚于开始时间'));
      return;
    }
    setCommitted({ symbol: draftSymbol, interval: draftInterval, from, to });
  };

  // --- 历史 K 线 --------------------------------------------------------------
  const klinesQ = useQuery({
    queryKey: ['klines-history', committed.symbol, committed.interval, committed.from, committed.to],
    queryFn: () => api.klinesHistory(committed.symbol, committed.interval, committed.from, committed.to),
    enabled: Boolean(committed.symbol),
    staleTime: 600_000,
  });
  const bars = useMemo<Kline[]>(() => klinesQ.data?.klines ?? [], [klinesQ.data]);
  const step = useMemo(() => intervalMs(committed.interval), [committed.interval]);

  // --- 游标与播放 -------------------------------------------------------------
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  /** 新数据集(换币种/周期/区间)要重置视窗;往前补历史时不重置,视觉上原地不动。 */
  const freshRef = useRef(true);
  /** 往前补历史前记下游标那根的 open_time,数据回来后按时间找回同一根。 */
  const anchorRef = useRef<number | null>(null);

  const lastIdx = bars.length > 0 ? bars.length - 1 : 0;
  const cursorIdx = Math.min(Math.max(0, cursor), lastIdx);
  const cursorBar = bars.length > 0 ? bars[cursorIdx] : undefined;
  const cursorTime = cursorBar?.close_time ?? 0;

  useEffect(() => {
    setPlaying(false);
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor !== null && bars.length > 0) {
      const i = barIndexAt(bars, anchor);
      if (i >= 0) {
        setCursor(i); // 前面接上了新历史,游标还停在原来那根
        return;
      }
    }
    freshRef.current = true;
    setCursor(bars.length > 0 ? bars.length - 1 : 0);
  }, [bars]);

  // --- 往前补历史 --------------------------------------------------------------
  const maxBars = klinesQ.data?.max_bars ?? FALLBACK_MAX_BARS;
  const spanBars = Math.max(0, Math.round((committed.to - committed.from) / step));
  const canExtend = bars.length > 0 && spanBars < maxBars;

  const extendBack = () => {
    if (!canExtend) return;
    setPlaying(false);
    anchorRef.current = bars[cursorIdx]?.open_time ?? null;
    const floor = committed.to - maxBars * step; // 单次请求的硬上限就在这儿
    const next = Math.max(floor, committed.from - EXTEND_BARS * step);
    if (next >= committed.from) return;
    setDraftFrom(toLocalInput(next));
    setCommitted((c) => ({ ...c, from: next }));
  };

  useEffect(() => {
    if (!playing) return;
    if (bars.length === 0) {
      setPlaying(false);
      return;
    }
    const timer = window.setInterval(() => {
      setCursor((c) => {
        const next = c + 1;
        if (next >= bars.length - 1) {
          setPlaying(false);
          return Math.max(0, bars.length - 1);
        }
        return next;
      });
    }, Math.max(20, Math.round(BASE_STEP_MS / speed)));
    return () => window.clearInterval(timer);
  }, [playing, speed, bars.length]);

  const stepBack = () => {
    setPlaying(false);
    setCursor((c) => Math.max(0, Math.min(c, lastIdx) - 1));
  };
  const stepForward = () => {
    setPlaying(false);
    setCursor((c) => Math.min(lastIdx, Math.min(c, lastIdx) + 1));
  };
  const jumpToEnd = () => {
    setPlaying(false);
    setCursor(lastIdx);
  };

  // --- 回测 run 选择 ----------------------------------------------------------
  const runsQ = useQuery({ queryKey: ['backtest'], queryFn: () => api.backtests(50), staleTime: 5_000 });
  const runs = useMemo(() => runsQ.data?.runs ?? [], [runsQ.data]);
  const matchingRuns = useMemo(
    () => runs.filter((r) => r.symbol === committed.symbol && r.timeframe === committed.interval).sort((a, b) => b.created_at - a.created_at),
    [runs, committed.symbol, committed.interval],
  );

  /** null = 还没选(自动挑最新一条);'' = 用户明确选了「不加载」。 */
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedRunId(null);
  }, [committed.symbol, committed.interval]);
  useEffect(() => {
    if (selectedRunId === null && matchingRuns.length > 0) setSelectedRunId(matchingRuns[0]!.id);
  }, [selectedRunId, matchingRuns]);

  const detailQ = useQuery({
    queryKey: ['backtest', selectedRunId],
    queryFn: () => api.backtest(selectedRunId!),
    enabled: Boolean(selectedRunId),
    refetchInterval: (q) => {
      const status = q.state.data?.run.status;
      return status === 'running' || status === 'queued' ? 2000 : false;
    },
  });
  const run: BacktestRun | null = detailQ.data?.run ?? null;
  const steps = useMemo<BacktestStep[]>(() => [...(detailQ.data?.steps ?? [])].sort((a, b) => a.at_ms - b.at_ms), [detailQ.data]);
  const trades = useMemo<BacktestTrade[]>(() => detailQ.data?.trades ?? [], [detailQ.data]);

  // --- 图表 ------------------------------------------------------------------
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const sizeRef = useRef({ w: 0, h: 0 });
  /** 当前视窗要铺多少根;用户自己缩放后跟随用户。 */
  const viewBarsRef = useRef(DEFAULT_VIEW_BARS);
  /** >0 表示这次视窗变化是我们自己设的,别当成用户缩放(否则每帧漂 2 根)。 */
  const programmaticRef = useRef(0);
  /** 上一次真正喂进去的前缀,用来判断能不能只 update 一根。 */
  const renderedRef = useRef<{ bars: Kline[]; count: number } | null>(null);

  /** 把可视区贴到前缀末尾:露出来的最后 N 根铺满整个面板,而不是被挤到最右边一条缝里。 */
  const applyView = useCallback((count: number) => {
    const chart = chartRef.current;
    if (!chart || count <= 0) return;
    const width = Math.max(10, Math.min(count, viewBarsRef.current));
    programmaticRef.current += 1;
    chart.timeScale().setVisibleLogicalRange({ from: count - width, to: count + 2 });
    requestAnimationFrame(() => {
      programmaticRef.current = Math.max(0, programmaticRef.current - 1);
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = CHART_COLORS.dark;
    // 显式给宽高 + ResizeObserver,不用 autoSize:图表区是 flex 子项,挂载那一刻高度可能还是 0,
    // autoSize 会把蜡烛画进一条零高的带子里(现象就是「整片空白只剩右上角一条红线」)。
    const initialW = Math.max(1, container.clientWidth);
    const initialH = Math.max(1, container.clientHeight);
    sizeRef.current = { w: initialW, h: initialH };
    const chart = createChart(container, {
      width: initialW,
      height: initialH,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text, fontSize: 11 },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderVisible: false,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    const onRange = (range: { from: number; to: number } | null): void => {
      if (programmaticRef.current > 0 || !range) return;
      const w = range.to - range.from;
      if (Number.isFinite(w) && w >= 10 && w <= 20_000) viewBarsRef.current = w;
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const w = Math.max(1, Math.floor(box.width));
      const h = Math.max(1, Math.floor(box.height));
      if (w === sizeRef.current.w && h === sizeRef.current.h) return;
      sizeRef.current = { w, h };
      chart.applyOptions({ width: w, height: h });
      applyView(renderedRef.current?.count ?? 0);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      markersRef.current?.detach();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      renderedRef.current = null;
      priceLinesRef.current = [];
    };
  }, [applyView]);

  // 只按游标切前缀重喂数据,绝不重建图表实例。
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const point = (k: Kline) => ({
      time: Math.floor(k.open_time / 1000) as UTCTimestamp, // 网关给毫秒,lightweight-charts 要秒
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
    });
    const count = bars.length > 0 ? cursorIdx + 1 : 0;
    if (count === 0) {
      series.setData([]);
      renderedRef.current = null;
      return;
    }
    const prev = renderedRef.current;
    if (prev && prev.bars === bars && count === prev.count + 1) {
      series.update(point(bars[cursorIdx]!)); // 播放时逐根推进,别每帧重喂几千根
    } else {
      series.setData(bars.slice(0, count).map(point)); // open_time 升序且唯一,直接喂
      if (freshRef.current) viewBarsRef.current = DEFAULT_VIEW_BARS;
    }
    renderedRef.current = { bars, count };
    freshRef.current = false;
    applyView(count);
  }, [bars, cursorIdx, applyView]);

  // 盲测可视化:只画 at_ms ≤ 当前这根收盘的判断,游标没走到就看不见。
  const visibleSteps = useMemo(() => (cursorTime > 0 ? steps.filter((s) => s.at_ms <= cursorTime) : []), [steps, cursorTime]);

  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    const colors = CHART_COLORS.dark;
    const list: SeriesMarker<Time>[] = [];
    for (const s of visibleSteps) {
      const action = s.action;
      if (action === 'NO_TRADE' || action === 'HOLD' || action === null) continue; // 太密,不画
      const time = Math.floor(alignToBar(bars, s.at_ms, step) / 1000) as UTCTimestamp;
      const text = shortActionLabel(action, s.direction);
      if (action === 'PROPOSE' || action === 'ADD') {
        const isShort = s.direction === 'short';
        list.push({
          time,
          position: isShort ? 'aboveBar' : 'belowBar',
          shape: isShort ? 'arrowDown' : 'arrowUp',
          color: isShort ? colors.down : colors.up,
          text,
          size: action === 'PROPOSE' ? 1.2 : 0.9,
        } as SeriesMarker<Time>);
      } else if (action === 'EXIT' || action === 'INVALIDATE' || action === 'REDUCE') {
        list.push({ time, position: 'aboveBar', shape: 'square', color: colors.vwap, text, size: 0.9 } as SeriesMarker<Time>);
      } else {
        list.push({ time, position: 'aboveBar', shape: 'circle', color: colors.text, text, size: 0.7 } as SeriesMarker<Time>);
      }
    }
    list.sort((a, b) => Number(a.time) - Number(b.time));
    plugin.setMarkers(list);
  }, [visibleSteps, bars, step]);

  // 游标那一刻还开着的那笔:入场/止损/止盈三条线。
  const openTrade = useMemo<BacktestTrade | null>(() => {
    if (cursorTime <= 0) return null;
    for (const t of trades) {
      if (t.proposed_at <= cursorTime && (t.exit_at === null || t.exit_at >= cursorTime)) return t;
    }
    return null;
  }, [trades, cursorTime]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    if (!openTrade) return;
    const colors = CHART_COLORS.dark;
    const add = (price: number | null, color: string, style: LineStyle, title: string) => {
      if (price === null || !Number.isFinite(price) || price <= 0) return;
      priceLinesRef.current.push(series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    add(openTrade.fill_price ?? openTrade.limit_price, colors.text, LineStyle.Solid, t('入场'));
    add(openTrade.stop, colors.down, LineStyle.Dashed, t('止损'));
    add(openTrade.tp, colors.up, LineStyle.Dashed, t('止盈'));
  }, [openTrade]);

  // --- 步骤列表:跟着游标滚 ----------------------------------------------------
  const activeStepIdx = visibleSteps.length > 0 ? visibleSteps[visibleSteps.length - 1]!.idx : null;
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeStepIdx]);

  const gotoStep = useCallback(
    (at: number) => {
      setPlaying(false);
      const i = barIndexAt(bars, at);
      setCursor(i >= 0 ? i : 0);
    },
    [bars],
  );

  const tradeByStep = useMemo(() => {
    const m = new Map<number, BacktestTrade>();
    for (const t of trades) m.set(t.step_idx, t);
    return m;
  }, [trades]);

  // --- 回测表单 --------------------------------------------------------------
  const [mode, setMode] = useState<BacktestMode>('triggers');
  const [maxJudgments, setMaxJudgments] = useState(60);
  const [reviewEveryClose, setReviewEveryClose] = useState(false);
  const [attribute, setAttribute] = useState(false);

  // v3.5:这次回测拿哪几条策略去判断。回测**允许**点名 backtest / shadow 状态的策略——
  // 那正是回测的用处;实盘启用才卡 ≥ paper(那个在策略库页)。
  const strategiesQ = useQuery({ queryKey: ['strategies'], queryFn: () => api.strategies(), staleTime: 30_000 });
  const strategyOptions = useMemo(() => (strategiesQ.data?.strategies ?? []).filter((x) => x.status !== 'retired'), [strategiesQ.data]);
  const strategyDefault = useMemo(() => strategiesQ.data?.active ?? [], [strategiesQ.data]);
  /** null = 用户还没动过,跟随网关给的 active 默认值。 */
  const [strategyPick, setStrategyPick] = useState<string[] | null>(null);
  const strategyIds = strategyPick ?? strategyDefault;
  const strategyName = useCallback(
    (id: string) => strategyOptions.find((x) => x.id === id)?.name ?? id,
    [strategyOptions],
  );
  const toggleStrategy = (id: string) => {
    const on = strategyIds.includes(id);
    if (!on && strategyIds.length >= MAX_STRATEGIES) {
      toast.error(t('一次最多带 {n} 条策略', { n: MAX_STRATEGIES }));
      return;
    }
    setStrategyPick(on ? strategyIds.filter((x) => x !== id) : [...strategyIds, id]);
  };

  const formKey = `${committed.symbol}|${committed.interval}|${committed.from}|${committed.to}|${mode}|${maxJudgments}|${reviewEveryClose}|${attribute}|${[...strategyIds].sort().join(',')}`;
  const [estimate, setEstimate] = useState<{ key: string; data: BacktestEstimate } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const formKeyRef = useRef(formKey);
  formKeyRef.current = formKey;

  useEffect(() => {
    // 任何一个入参变了,旧估算立刻作废 —— 不能拿别的参数的 ¥ 去骗确认框。
    setEstimate(null);
    setEstimateError(null);
  }, [formKey]);

  const doEstimate = async () => {
    const key = formKey;
    setEstimating(true);
    setEstimateError(null);
    try {
      const data = await api.backtestEstimate({
        symbol: committed.symbol,
        timeframe: committed.interval,
        from: committed.from,
        to: committed.to,
        mode,
        max_judgments: maxJudgments,
        review_every_close: reviewEveryClose,
        strategy_ids: strategyIds,
      });
      if (formKeyRef.current === key) setEstimate({ key, data });
    } catch (err: unknown) {
      if (formKeyRef.current === key) setEstimateError(err instanceof Error ? err.message : String(err));
    } finally {
      setEstimating(false);
    }
  };

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const runningId = runsQ.data?.running ?? null;
  const estimateReady = estimate !== null && estimate.key === formKey;
  const canStart = estimateReady && !starting && runningId === null;

  const confirmText = (() => {
    if (!estimate) return '';
    const e = estimate.data;
    const money =
      e.est_cny === null
        ? t('走订阅额度,不单独计费。')
        : t('预计花费 {est}(最坏 {max})。', { est: fmtCny(e.est_cny), max: fmtCny(e.max_cny) });
    const attr = attribute ? t('跑完还会再调一次副脑做归因(另计费用)。') : '';
    return t('这次回测最多调用模型 {n} 次,', { n: maxJudgments }) + money + attr + t('判断一旦开始就是真花钱,确认开始?');
  })();

  const doStart = async () => {
    setStarting(true);
    try {
      const res = await api.startBacktest({
        symbol: committed.symbol,
        timeframe: committed.interval,
        from: committed.from,
        to: committed.to,
        mode,
        max_judgments: maxJudgments,
        review_every_close: reviewEveryClose,
        strategy_ids: strategyIds,
        attribute,
      });
      if (res.error) {
        toast.error(res.error);
      } else {
        setSelectedRunId(res.run.id);
        setConfirmOpen(false);
      }
      await queryClient.invalidateQueries({ queryKey: ['backtest'] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const [cancelling, setCancelling] = useState(false);
  const doCancel = async (id: string) => {
    setCancelling(true);
    try {
      await api.cancelBacktest(id);
      await queryClient.invalidateQueries({ queryKey: ['backtest'] });
      await queryClient.invalidateQueries({ queryKey: ['backtest', id] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const inFlight = run !== null && (run.status === 'queued' || run.status === 'running');
  const progress = run?.progress ?? null;
  const progressPct = progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  const summary = run?.summary ?? null;

  // --- v3.5 归因 --------------------------------------------------------------
  // 只读列表随时能拉(便宜);真正跑一次归因要调便宜大脑,**会花钱**,所以走确认框。
  const runDone = run?.status === 'done';
  const attributionQ = useQuery({
    queryKey: ['backtest', selectedRunId, 'attribution'],
    queryFn: () => api.backtestAttribution(selectedRunId!),
    enabled: Boolean(selectedRunId) && runDone,
    staleTime: 30_000,
  });
  const points = useMemo<AttributionPoint[]>(() => attributionQ.data?.points ?? [], [attributionQ.data]);

  const [attrConfirmOpen, setAttrConfirmOpen] = useState(false);
  const [attrBusy, setAttrBusy] = useState(false);
  const doAttribute = async () => {
    if (!selectedRunId) return;
    setAttrBusy(true);
    try {
      const res = await api.runBacktestAttribution(selectedRunId);
      if (res.error) toast.error(`${t('归因失败')}:${res.error}`);
      else if (res.cached) toast.success(t('这次回测之前归因过,直接给旧结果,没再花钱'));
      else toast.success(t('归因跑完了,{n} 个问题点位', { n: res.points.length }));
      setAttrConfirmOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['backtest', selectedRunId, 'attribution'] });
      await queryClient.invalidateQueries({ queryKey: ['strategies'] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAttrBusy(false);
    }
  };

  /** 采纳 = 在那条策略上落一个 draft 新版本;参数永远不会就地被改。 */
  const [adoptingId, setAdoptingId] = useState<string | null>(null);
  const doAdopt = async (point: AttributionPoint) => {
    if (!point.strategy_id) return;
    setAdoptingId(point.id);
    try {
      const res = await api.proposeStrategyVersion(point.strategy_id, { attribution_id: point.id });
      toast.success(t('新版本 v{n} 生成好了(草稿);要上线,还得一格一格晋升', { n: res.strategy.version }));
      await queryClient.invalidateQueries({ queryKey: ['strategies'] });
      if (selectedRunId) await queryClient.invalidateQueries({ queryKey: ['backtest', selectedRunId, 'attribution'] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAdoptingId(null);
    }
  };

  const changePct = cursorBar && Number(cursorBar.open) > 0 ? ((Number(cursorBar.close) - Number(cursorBar.open)) / Number(cursorBar.open)) * 100 : null;

  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      {/* 1. 工具条 */}
      <Workspace className="shrink-0">
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
          <div className="w-36">
            <SymbolPicker symbols={symbolsQ.data?.symbols ?? []} value={draftSymbol} onChange={setDraftSymbol} watchlist={watchlist} />
          </div>
          <div className="flex items-center gap-1">
            {INTERVALS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => pickInterval(item)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                  draftInterval === item ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item}
              </button>
            ))}
          </div>
          <Label htmlFor="replay-from" className="text-[11px] text-muted-foreground">
            {t('起')}
          </Label>
          <Input id="replay-from" type="datetime-local" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} className="num h-7 w-[190px] text-[11px]" />
          <Label htmlFor="replay-to" className="text-[11px] text-muted-foreground">
            {t('止')}
          </Label>
          <Input id="replay-to" type="datetime-local" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} className="num h-7 w-[190px] text-[11px]" />
          <Button size="sm" onClick={commit} disabled={klinesQ.isFetching}>
            {klinesQ.isFetching ? t('加载中…') : t('加载')}
          </Button>
          <Button size="sm" variant="outline" onClick={extendBack} disabled={!canExtend || klinesQ.isFetching} title={t('每次往前多加载 {n} 根,上限 {max} 根', { n: EXTEND_BARS, max: maxBars })}>
            {t('再往前加载')}
          </Button>
          <span className="num ml-auto text-[10.5px] text-muted-foreground">
            {committed.symbol} · {committed.interval} · {t('{n} 根', { n: bars.length })}
            {bars.length > 0 ? ` · ${t('{date} 起', { date: new Date(bars[0]!.open_time).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'zh-CN') })}` : ''}
            {bars.length > 0 && !canExtend ? ` · ${t('已到单次上限 {n} 根', { n: maxBars })}` : ''}
            {klinesQ.data && !klinesQ.data.complete ? ` · ${t('区间太长,已经从最新往回截断')}` : ''}
          </span>
        </div>
      </Workspace>

      {/* 2 + 3. 图表 | 判断列表 */}
      {/* shrink-0 + 固定高:这一行不能被下面的汇总/归因挤扁,否则里面 min-h 的图表容器会溢出并盖住汇总表 */}
      <div className="grid h-[560px] shrink-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,1.15fr)]">
        <Workspace className="flex min-h-0 flex-col">
          <Pane
            className="min-h-0 flex-1"
            title={t('回放')}
            hint={cursorBar ? t('第 {i} / {n} 根', { i: cursorIdx + 1, n: bars.length }) : t('还没有 K 线')}
            contentClassName="flex min-h-0 flex-col"
            actions={
              <span className="num text-[10.5px] text-muted-foreground">
                {t('{shown} / {total} 条判断已浮现', { shown: visibleSteps.length, total: steps.length })}
              </span>
            }
          >
            {/* 图表区必须有真实高度:flex-1 + min-h-[360px],容器再 absolute 铺满,
                否则 h-full 撑在一个高度 auto 的父级上会算成 0,蜡烛全画进零高带子里。 */}
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <div ref={containerRef} className="absolute inset-0" />
              {bars.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center text-[11.5px] text-muted-foreground">
                  {klinesQ.isFetching ? t('正在拉历史 K 线…') : klinesQ.isError ? `${t('历史 K 线加载失败')}:${klinesQ.error instanceof Error ? klinesQ.error.message : t('网关没给数据')}` : t('选好币种、周期和起止时间,点「加载」。')}
                </div>
              ) : null}
            </div>

            {/* 当前这根的读数 */}
            <div className="num flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t px-3 py-1.5 text-[11px]">
              {cursorBar ? (
                <>
                  <span className="text-muted-foreground">{new Date(cursorBar.open_time).toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false })}</span>
                  <span>
                    <span className="text-muted-foreground">{t('开')} </span>
                    {fmtPrice(cursorBar.open)}
                  </span>
                  <span>
                    <span className="text-muted-foreground">{t('高')} </span>
                    {fmtPrice(cursorBar.high)}
                  </span>
                  <span>
                    <span className="text-muted-foreground">{t('低')} </span>
                    {fmtPrice(cursorBar.low)}
                  </span>
                  <span>
                    <span className="text-muted-foreground">{t('收')} </span>
                    {fmtPrice(cursorBar.close)}
                  </span>
                  <span style={{ color: (changePct ?? 0) >= 0 ? CHART_COLORS.dark.up : CHART_COLORS.dark.down }}>
                    {changePct === null ? '—' : `${changePct >= 0 ? '+' : '−'}${Math.abs(changePct).toFixed(2)}%`}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>

            {/* 游标 + 播放控制 */}
            <div className="flex shrink-0 flex-col gap-1.5 border-t px-3 py-2">
              <input
                type="range"
                min={0}
                max={Math.max(0, bars.length - 1)}
                value={cursorIdx}
                disabled={bars.length === 0}
                onChange={(e) => {
                  setPlaying(false);
                  setCursor(Number(e.target.value));
                }}
                className="w-full accent-primary"
                aria-label={t('回放游标')}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="icon-xs" variant="outline" onClick={stepBack} disabled={bars.length === 0 || cursorIdx === 0} aria-label={t('上一根')}>
                  <SkipBack data-slot="icon" />
                </Button>
                <Button size="icon-xs" variant={playing ? 'default' : 'outline'} onClick={() => setPlaying((p) => !p)} disabled={bars.length === 0 || cursorIdx >= lastIdx} aria-label={playing ? t('暂停') : t('播放')}>
                  {playing ? <Pause data-slot="icon" /> : <Play data-slot="icon" />}
                </Button>
                <Button size="icon-xs" variant="outline" onClick={stepForward} disabled={bars.length === 0 || cursorIdx >= lastIdx} aria-label={t('下一根')}>
                  <SkipForward data-slot="icon" />
                </Button>
                <div className="ml-1 flex items-center gap-1">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSpeed(s)}
                      className={cn('num rounded px-1.5 py-0.5 text-[11px] transition-colors', speed === s ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
                <Button size="xs" variant="outline" className="ml-1" onClick={jumpToEnd} disabled={bars.length === 0 || cursorIdx >= lastIdx}>
                  {t('跳到最后')}
                </Button>
                <span className="ml-auto text-[10.5px] text-muted-foreground">{t('判断跟着游标一条条出现——回放到哪儿才看得到那儿的判断,和 agent 当时看到的一样。')}</span>
              </div>
            </div>
          </Pane>
        </Workspace>

        <div className="flex min-h-0 flex-col gap-3">
          {/* 4. 回测表单 */}
          <Workspace className="shrink-0">
            <Pane title={t('agent 回测')} hint={estimateReady ? t('估算好了') : t('先估算再开始')} contentClassName="flex flex-col gap-2 p-2.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t('判断时机')}</span>
                {(['triggers', 'every_close'] as BacktestMode[]).map((m) => (
                  <Button key={m} type="button" size="xs" variant={mode === m ? 'default' : 'outline'} className="rounded-full" onClick={() => setMode(m)}>
                    {MODE_LABEL[m]}
                    {m === 'triggers' ? t('(推荐)') : ''}
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="replay-max" className="shrink-0 text-[11px] text-muted-foreground">
                  {t('最多判断次数')}
                </Label>
                <Input
                  id="replay-max"
                  type="number"
                  min={1}
                  max={500}
                  value={maxJudgments}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setMaxJudgments(Number.isFinite(n) ? Math.max(1, Math.min(500, Math.round(n))) : 60);
                  }}
                  className="num h-7 w-24 text-[11px]"
                />
                <span className="text-[10.5px] text-muted-foreground">1–500</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="shrink-0 text-[11px] text-muted-foreground">{t('策略')}</span>
                {strategyOptions.length === 0 ? (
                  <span className="text-[10.5px] text-muted-foreground">{strategiesQ.isLoading ? t('加载中…') : t('策略库是空的')}</span>
                ) : (
                  strategyOptions.map((x) => (
                    <Button
                      key={x.id}
                      type="button"
                      size="xs"
                      variant={strategyIds.includes(x.id) ? 'default' : 'outline'}
                      className="rounded-full"
                      onClick={() => toggleStrategy(x.id)}
                      title={`${x.id} · v${x.version} · ${x.status_label}`}
                    >
                      {x.name}
                    </Button>
                  ))
                )}
              </div>
              <div className="text-[10px] leading-relaxed text-muted-foreground">
                {t('回测可以点名还没上线的策略(回测中 / 影子),这正是回测的用处;最多 {n} 条。不选就用当前实盘启用的那几条。', { n: MAX_STRATEGIES })}
              </div>

              <div className="flex items-center gap-2">
                <Switch id="replay-review" size="sm" checked={reviewEveryClose} onCheckedChange={setReviewEveryClose} />
                <Label htmlFor="replay-review" className="text-[11px] font-normal text-muted-foreground">
                  {t('持仓期间每根收盘都复查(更贵)')}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="replay-attribute" size="sm" checked={attribute} onCheckedChange={setAttribute} />
                <Label htmlFor="replay-attribute" className="text-[11px] font-normal text-muted-foreground">
                  {t('跑完自动归因(走副脑)')}
                </Label>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="xs" variant="outline" onClick={() => void doEstimate()} disabled={estimating || bars.length === 0}>
                  <Calculator data-slot="icon" />
                  {estimating ? t('估算中…') : t('估算')}
                </Button>
                <Button size="xs" onClick={() => setConfirmOpen(true)} disabled={!canStart}>
                  {t('开始回测')}
                </Button>
                {!estimateReady && !estimating ? <span className="text-[10.5px] text-muted-foreground">{t('要先估算才能开始')}</span> : null}
                {runningId !== null && !inFlight ? <span className="text-[10.5px] text-warn">{t('已经有别的回测在跑')}</span> : null}
              </div>

              {estimateError ? <div className="text-[10.5px] text-destructive">{t('估算失败')}:{estimateError}</div> : null}
              {estimateReady && estimate ? (
                <div className="num rounded-sm bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed">
                  {t('候选 {c} 根 / 共 {n} 根 K 线', { c: estimate.data.candidates, n: estimate.data.bars })}
                  <span className="mx-1.5 text-muted-foreground">·</span>
                  {estimate.data.est_cny === null ? (
                    <span className="text-muted-foreground">{t('订阅额度,不计费')}</span>
                  ) : (
                    <>
                      {t('预计')} {fmtCny(estimate.data.est_cny)}
                      <span className="mx-1.5 text-muted-foreground">·</span>
                      {t('最坏')} {fmtCny(estimate.data.max_cny)}
                    </>
                  )}
                  {estimate.data.note ? <div className="mt-0.5 text-[10.5px] text-muted-foreground">{estimate.data.note}</div> : null}
                </div>
              ) : null}

              {inFlight && run ? (
                <div className="flex flex-col gap-1 rounded-sm border px-2 py-1.5">
                  <div className="num flex items-center gap-2 text-[11px]">
                    <span>
                      {STATUS_LABEL[run.status]} {progress ? `${progress.done} / ${progress.total}` : ''}
                    </span>
                    <Button size="xs" variant="outline" className="ml-auto" onClick={() => void doCancel(run.id)} disabled={cancelling}>
                      <Ban data-slot="icon" />
                      {cancelling ? t('取消中…') : t('取消')}
                    </Button>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
                  </div>
                  {progress?.last_action ? <div className="text-[10.5px] text-muted-foreground">{t('最近动作')} {progress.last_action}</div> : null}
                </div>
              ) : null}

              {run?.error ? <div className="text-[10.5px] text-destructive">{t('回测失败')}:{run.error}</div> : null}

              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[11px] text-muted-foreground">{t('历史回测')}</span>
                <select
                  value={selectedRunId ?? ''}
                  onChange={(e) => setSelectedRunId(e.target.value)}
                  className="num h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-[11px] outline-none"
                >
                  <option value="">{t('不加载')}</option>
                  {matchingRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      {new Date(r.created_at).toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} · {MODE_LABEL[r.mode]} ·{' '}
                      {STATUS_LABEL[r.status]} · {t('{n} 次判断', { n: r.summary?.judgments ?? r.progress?.done ?? 0 })}
                    </option>
                  ))}
                </select>
              </div>
              {matchingRuns.length === 0 ? <div className="text-[10.5px] text-muted-foreground">{t('这个区间还没有回测,先估算再开始。')}</div> : null}
            </Pane>
          </Workspace>

          {/* 3. 判断列表 */}
          <Workspace className="flex min-h-0 flex-1 flex-col">
            <Pane title={t('判断列表')} hint={run ? `${t('{n} 条', { n: steps.length })} · ${STATUS_LABEL[run.status]}` : t('没有选中的回测')} contentClassName="flex min-h-0 flex-col">
              {detailQ.isLoading && selectedRunId ? <div className="p-3 text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
              {!selectedRunId ? <div className="p-3 text-[11px] leading-relaxed text-muted-foreground">{t('还没加载回测。K 线和游标照样能拖,只是没有判断可看。')}</div> : null}
              {selectedRunId && !detailQ.isLoading && steps.length === 0 ? <div className="p-3 text-[11px] text-muted-foreground">{t('这次回测还没有判断记录。')}</div> : null}
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col">
                  {steps.map((s) => {
                    const seen = cursorTime > 0 && s.at_ms <= cursorTime;
                    const active = s.idx === activeStepIdx;
                    const t = tradeByStep.get(s.idx);
                    return (
                      <button
                        key={`${s.run_id}-${s.idx}`}
                        type="button"
                        ref={active ? activeRowRef : undefined}
                        onClick={() => gotoStep(s.at_ms)}
                        className={cn(
                          'flex w-full flex-col gap-0.5 border-b px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50',
                          !seen && 'opacity-40',
                          active && 'bg-muted/60',
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="num shrink-0 text-[10.5px] text-muted-foreground">
                            {new Date(s.at_ms).toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                          </span>
                          <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px]', stepBadgeClass(s.action, s.direction))}>
                            {shortActionLabel(s.action, s.direction)}
                          </Badge>
                          <span className="num shrink-0 text-[10.5px] text-muted-foreground">{s.confidence === null ? '—' : s.confidence.toFixed(2)}</span>
                          {t && t.r !== null ? (
                            <span className={cn('num ml-auto shrink-0 text-[10.5px] font-semibold', t.r >= 0 ? 'text-up' : 'text-down')}>{fmtR(t.r)}</span>
                          ) : null}
                        </div>
                        <div className="truncate text-[11px] text-foreground/90">{s.judgment?.headline ?? s.error ?? '—'}</div>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </Pane>
          </Workspace>
        </div>
      </div>

      {/* 5. 汇总 */}
      {summary ? (
        <Workspace className="shrink-0">
          <Pane title={t('回测汇总')} hint={`${summary.model} · ${run ? MODE_LABEL[run.mode] : ''}`} contentClassName="flex flex-col gap-2 p-2.5">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border bg-border sm:grid-cols-4 xl:grid-cols-8">
              <SummaryTile label={t('判断次数')} value={String(summary.judgments)} sub={`${t('扫描 {n}', { n: summary.scans })} · ${t('复查 {n}', { n: summary.reviews })}`} />
              <SummaryTile label={t('交易数')} value={String(summary.trades)} sub={`${t('盈 {n}', { n: summary.wins })} · ${t('亏 {n}', { n: summary.losses })} · ${t('平 {n}', { n: summary.flat })}`} />
              <SummaryTile label={t('胜率')} value={summary.win_rate === null ? '—' : `${(summary.win_rate * 100).toFixed(0)}%`} />
              <SummaryTile label={t('平均 R')} value={fmtR(summary.avg_r)} tone={summary.avg_r === null ? undefined : summary.avg_r >= 0 ? 'up' : 'down'} />
              <SummaryTile label={t('累计 R')} value={fmtR(summary.sum_r)} tone={summary.sum_r >= 0 ? 'up' : 'down'} />
              <SummaryTile label={t('最大回撤')} value={`${summary.max_drawdown_r.toFixed(2)}R`} />
              <SummaryTile label={t('平均持仓')} value={summary.avg_hold_bars === null ? '—' : t('{n} 根', { n: summary.avg_hold_bars.toFixed(1) })} />
              <SummaryTile label={t('花费')} value={fmtCny(summary.cost.cny)} sub={`${summary.cost.input_tokens + summary.cost.output_tokens} tokens`} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {Object.entries(summary.actions).map(([action, count]) => (
                <Badge key={action} variant="outline" className={cn('h-4 px-1.5 text-[10px]', stepBadgeClass(action, null))}>
                  <span className="num">
                    {action} {count}
                  </span>
                </Badge>
              ))}
              {summary.capped ? <span className="text-[10.5px] text-warn">{t('到判断次数上限了,后面的候选没跑')}</span> : null}
            </div>
            {Object.keys(summary.by_strategy ?? {}).length > 0 ? (
              <div className="overflow-hidden rounded-sm border">
                <div className="grid grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,0.8fr))] gap-px bg-border">
                  {[t('策略'), t('成交'), t('胜率'), t('期望 R'), t('累计 R'), t('MAE 中位')].map((h) => (
                    <div key={h} className="bg-muted/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground select-none">
                      {h}
                    </div>
                  ))}
                  {Object.entries(summary.by_strategy).map(([id, b]) => {
                    const used = summary.strategies?.find((x) => x.id === id);
                    return (
                      <Fragment key={id}>
                        <div className="min-w-0 bg-card px-2 py-1">
                          <div className="truncate text-[10.5px]">{id === 'unattributed' ? t('没标策略') : strategyName(id)}</div>
                          <div className="num truncate text-[10px] text-muted-foreground">
                            {id === 'unattributed' ? t('模型判断时没写策略名') : `${id}${used ? ` · v${used.version}` : ''}`}
                          </div>
                        </div>
                        <div className="num bg-card px-2 py-1 text-[10.5px]">
                          {b.trades}
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            {b.wins}/{b.losses}
                          </span>
                        </div>
                        <div className="num bg-card px-2 py-1 text-[10.5px]">{b.win_rate === null ? '—' : `${(b.win_rate * 100).toFixed(0)}%`}</div>
                        <div className={cn('num bg-card px-2 py-1 text-[10.5px]', b.expectancy_r !== null && (b.expectancy_r >= 0 ? 'text-up' : 'text-down'))}>
                          {fmtR(b.expectancy_r)}
                        </div>
                        <div className={cn('num bg-card px-2 py-1 text-[10.5px]', b.sum_r >= 0 ? 'text-up' : 'text-down')}>{fmtR(b.sum_r)}</div>
                        <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">{fmtR(b.mae_r_p50)}</div>
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {summary.missed_move ? (
              <div className="num text-[11px] text-muted-foreground">
                {t('空仓期间错过的最大行情:平均 {avg} ATR / 最大 {max} ATR({n} 次采样)', { avg: summary.missed_move.avg_atr.toFixed(1), max: summary.missed_move.max_atr.toFixed(1), n: summary.missed_move.samples })}
              </div>
            ) : null}
            <div className="text-[10.5px] leading-relaxed text-muted-foreground">
              {t('盲测:每次判断只看得到当根收盘为止的 K 线;资金费率取历史值,持仓量、新闻、信息员在回测里拿不到。')}
            </div>
          </Pane>
        </Workspace>
      ) : null}

      {/* 6. 归因(v3.5):证据说了什么 / 规则说了什么 / 实际发生了什么 / 提议怎么改。
             提议只提议——要变成现实,得在这里点「采纳为新版本」落一个 draft,再一格一格晋升。 */}
      {selectedRunId && run ? (
        <Workspace className="shrink-0">
          <Pane
            title={t('归因')}
            hint={runDone ? t('{n} 个问题点位', { n: points.length }) : t('回测{status},跑完才能归因', { status: STATUS_LABEL[run.status] })}
            contentClassName="flex flex-col gap-2 p-2.5"
            actions={
              points.length > 0 ? (
                <Button size="xs" variant="outline" onClick={() => setAttrConfirmOpen(true)} disabled={!runDone || attrBusy}>
                  <Sparkles data-slot="icon" />
                  {t('重跑归因')}
                </Button>
              ) : null
            }
          >
            {attributionQ.isLoading ? <div className="text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
            {points.length === 0 && !attributionQ.isLoading ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="xs" onClick={() => setAttrConfirmOpen(true)} disabled={!runDone || attrBusy}>
                  <Sparkles data-slot="icon" />
                  {attrBusy ? t('归因中…') : t('跑归因(走副脑,会花钱)')}
                </Button>
                <span className="text-[10.5px] leading-relaxed text-muted-foreground">
                  {runDone
                    ? t('让副脑读这次的成交和当时的理由,最多吐 3 个问题点位;它只提议,不会自己改任何参数。')
                    : t('回测{status},跑完了才能归因。', { status: STATUS_LABEL[run.status] })}
                </span>
              </div>
            ) : null}
            {points.map((point) => (
              <div key={point.id} className="flex flex-col gap-1 rounded-sm border px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px]', attributionKindClass(point.kind))}>
                    {ATTRIBUTION_KIND_LABEL[point.kind]}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{point.title}</span>
                  <span className="num shrink-0 text-[10px] text-muted-foreground">
                    {point.strategy_id ? strategyName(point.strategy_id) : t('没指向具体策略')}
                    {point.symbol ? ` · ${point.symbol}` : ''}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 text-[10.5px] leading-relaxed">
                  <div>
                    <span className="text-muted-foreground">{t('证据显示')} </span>
                    {point.evidence_said}
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('规则说')} </span>
                    {point.rule_said}
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('实际')} </span>
                    {point.actual}
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('提议')} </span>
                    {point.proposal.kind === 'param' && point.proposal.param
                      ? t('把 {param} 改成 {value}', { param: point.proposal.param, value: point.proposal.value ?? '—' })
                      : point.proposal.text}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {point.applied_version !== null ? (
                    <span className="num text-[10.5px] text-muted-foreground">{t('已采纳')} → v{point.applied_version}</span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void doAdopt(point)}
                      disabled={point.strategy_id === null || adoptingId !== null}
                      title={point.strategy_id === null ? t('这条归因没指向具体策略,生成不了新版本') : undefined}
                    >
                      {adoptingId === point.id ? t('生成中…') : t('采纳为新版本')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </Pane>
        </Workspace>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={t('确认开始回测')}
        summary={t('开始回测')}
        busy={starting}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void doStart()}
      >
        <p className="leading-relaxed">{confirmText}</p>
        <p className="num text-[11.5px] text-muted-foreground">
          {committed.symbol} · {committed.interval} · {new Date(committed.from).toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false })} → {new Date(committed.to).toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false })} ·{' '}
          {MODE_LABEL[mode]}
          {reviewEveryClose ? ` · ${t('持仓每根收盘复查')}` : ''}
          {attribute ? ` · ${t('跑完自动归因')}` : ''}
          {strategyIds.length > 0 ? ` · ${t('策略 {list}', { list: strategyIds.map(strategyName).join('、') })}` : ''}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={attrConfirmOpen}
        title={t('确认跑归因')}
        summary={t('跑归因')}
        busy={attrBusy}
        onCancel={() => setAttrConfirmOpen(false)}
        onConfirm={() => void doAttribute()}
      >
        <p className="leading-relaxed">
          {t('归因会调一次副脑,读这次回测的成交和判断,是真花钱(一次调用,量级和一次判断差不多)。它只吐提议;要不要落成新版本,还是你点了才算。')}
        </p>
      </ConfirmDialog>
    </div>
  );
}

function SummaryTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="min-w-0 bg-card px-2.5 py-1.5">
      <div className="text-[10.5px] text-muted-foreground select-none">{label}</div>
      <div className={cn('num mt-0.5 truncate text-[15px]/6 font-semibold', tone === 'up' && 'text-up', tone === 'down' && 'text-down')}>{value}</div>
      {sub ? <div className="num mt-0.5 truncate text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
