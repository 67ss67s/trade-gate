/**
 * 筛选页(#/screener):雷达(网关 src/demo/screener.ts)的产出。
 *
 * 一次筛选 = 一行 ScreenRow + 若干张 WatchCandidate(每张嵌一整张 OpportunityCard)。
 * 页面分三段:头部(周期 tab / 上次跑的时间与花销 / 下次倒计时 / 立即筛选 / 应用提案 / 设置)、
 * 中部名次表(可展开看逐策略的条件命中)、底部历史列表(点一条就用 GET /api/screener/:id 载入旧结果)。
 *
 * 红线两条:
 *   1. 「应用提案」只改 workflow.watchlist,而且必须先在确认框里给出 before → after 的 diff;
 *   2. 候选理由里以「模型:」开头的那行是**不可信的模型自由文本**,画成独立样式并标注,
 *      不要让它看起来和代码算出来的证据是一回事。
 *
 * react-query key 约定见 src/App.tsx 顶部注释:本页只用 ['screener', ...] / ['workflow'],
 * 不再开自己的 SSE 连接——App.tsx 那条连接收到 screener.changed 会按前缀失效。
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Eye, ListChecks, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type {
  ScreenHorizon,
  ScreenRow,
  ScreenSchedule,
  ScreenUniverse,
  StrategyFit,
  WatchCandidate,
  Workflow,
} from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { directionLabel, fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

// label 是 i18n key(中文原文),渲染时过 t()
const HORIZONS: { id: ScreenHorizon; label: string }[] = [
  { id: 'short', label: '短线(12h)' },
  { id: 'swing', label: '中线(3d)' },
  { id: 'weekly', label: '周线' },
];

/** 周线周期是写死的 7 天,不是 workflow 字段。 */
const WEEKLY_EVERY_MS = 7 * 86_400_000;

const UNIVERSE_LABEL: Record<ScreenUniverse, string> = tmap({
  'watchlist+whitelist': '观察列表 + 白名单',
  top_volume: '成交量前列',
  explicit: '手填列表',
});

const SCREENER_DEFAULTS = {
  screener_enabled: false,
  screener_short_every_ms: 12 * 3_600_000,
  screener_swing_every_ms: 3 * 86_400_000,
  screener_universe: 'watchlist+whitelist' as ScreenUniverse,
  screener_symbols: [] as string[],
  screener_whitelist: null as string[] | null,
  screener_max_symbols: 60,
  screener_use_brain: false,
  screener_apply: 'propose' as NonNullable<Workflow['screener_apply']>,
  screener_expectancy: true,
  watchlist_max: 60,
};

// ---------------------------------------------------------------------------
// 小工具

function fmtScore(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2);
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

function fmtPctNum(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`;
}

/** 成交额:紧凑到 1.2B / 345M / 12K。 */
function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtCny(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '¥0.000';
  return `¥${v.toFixed(3)}`;
}

/** 倒计时:超过一小时给 h:mm,否则 m:ss。 */
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
  return `${m}:${String(rs).padStart(2, '0')}`;
}

function fmtEvery(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round((ms / 86_400_000) * 10) / 10}d`;
  if (ms >= 3_600_000) return `${Math.round((ms / 3_600_000) * 10) / 10}h`;
  return `${Math.round(ms / 60_000)}m`;
}

function fitClass(score: number): string {
  if (score >= 0.7) return 'text-up';
  if (score >= 0.5) return 'text-warn';
  return 'text-muted-foreground';
}

const MODEL_PREFIXES = ['模型:', '模型:'];

function isModelReason(line: string): boolean {
  return MODEL_PREFIXES.some((p) => line.trimStart().startsWith(p));
}

// ---------------------------------------------------------------------------
// 头部

function ScreenerHeader({
  horizon,
  onHorizon,
  horizons,
  screen,
  schedule,
  now,
  viewingOld,
  onBackToLatest,
  running,
  onRun,
  applyDisabledReason,
  onApply,
  onOpenSettings,
  workflow,
}: {
  workflow: Workflow | null;
  horizon: ScreenHorizon;
  onHorizon: (h: ScreenHorizon) => void;
  horizons: { id: ScreenHorizon; label: string }[];
  screen: ScreenRow | null;
  schedule: ScreenSchedule | null;
  now: number;
  viewingOld: boolean;
  onBackToLatest: () => void;
  running: boolean;
  onRun: () => void;
  applyDisabledReason: string | null;
  onApply: () => void;
  onOpenSettings: () => void;
}) {
  const isRunning = screen?.status === 'running' || schedule?.running === true;
  const countdown = schedule?.next_at != null ? schedule.next_at - now : null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2">
      <div className="flex items-center gap-1">
        {horizons.map((h) => (
          <Button
            key={h.id}
            size="xs"
            variant={h.id === horizon ? 'secondary' : 'ghost'}
            className={cn(h.id === horizon && 'font-semibold')}
            onClick={() => onHorizon(h.id)}
          >
            {t(h.label)}
          </Button>
        ))}
      </div>

      <span className="mx-1 h-4 w-px bg-border" />

      {screen ? (
        <>
          <span className="text-[11px] text-muted-foreground" title={fmtDateTime(screen.started_at)}>
            {viewingOld ? t('这次跑于') : t('上次跑于')} {relativeTime(screen.finished_at ?? screen.started_at, now)}
          </span>
          <span className="num text-[11px] text-muted-foreground">{fmtCny(screen.cost_cny)}</span>
          {screen.status === 'failed' ? (
            <Badge variant="outline" className="h-4 border-down/30 bg-down/10 px-1.5 text-[10px] text-down">
              {t('失败')}
            </Badge>
          ) : null}
        </>
      ) : (
        <span className="text-[11.5px] text-muted-foreground">{t('这个周期还没跑过')}</span>
      )}
      <UniversePopover workflow={workflow} screen={screen} />

      {isRunning ? (
        <Badge variant="outline" className="h-4 gap-1 border-warn/30 bg-warn/10 px-1.5 text-[10px] text-warn">
          <RefreshCw className="size-2.5 animate-spin" />
          {t('筛选中…')}
        </Badge>
      ) : countdown !== null ? (
        <span className="num text-[11px] text-muted-foreground">
          {schedule?.enabled === false ? t('排程关了') : countdown > 0 ? t('下次 {t}', { t: fmtCountdown(countdown) }) : t('马上开始')}
        </span>
      ) : null}

      {viewingOld ? (
        <Button size="xs" variant="ghost" onClick={onBackToLatest}>
          {t('回到最新')}
        </Button>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={running || isRunning} onClick={onRun}>
          <RefreshCw data-slot="icon" className={running || isRunning ? 'animate-spin' : undefined} />
          {running || isRunning ? t('筛选中…') : t('立即筛选')}
        </Button>
        {applyDisabledReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button size="sm" variant="outline" disabled>
                  <ListChecks data-slot="icon" />
                  {t('应用提案')}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{applyDisabledReason}</TooltipContent>
          </Tooltip>
        ) : (
          <Button size="sm" onClick={onApply}>
            <ListChecks data-slot="icon" />
            {t('应用提案')}
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" title={t('筛选设置')} onClick={onOpenSettings}>
          <Settings2 />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 顶栏「范围」标签:点开直接加/删白名单(或手填列表),存进 workflow,不用进设置抽屉

const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;

function UniversePopover({ workflow, screen }: { workflow: Workflow | null; screen: ScreenRow | null }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const mode = (workflow?.screener_universe ?? screen?.universe ?? 'watchlist+whitelist') as ScreenUniverse;
  const label = UNIVERSE_LABEL[mode] ?? mode;
  const watchlist = workflow?.watchlist ?? [];
  const whitelistSupported = Array.isArray(workflow?.screener_whitelist);
  // 可编辑的那份:白名单模式改 screener_whitelist,手填模式改 screener_symbols;成交量模式没有
  const field: 'screener_whitelist' | 'screener_symbols' | null = mode === 'watchlist+whitelist' ? (whitelistSupported ? 'screener_whitelist' : null) : mode === 'explicit' ? 'screener_symbols' : null;
  const editable = field ? (workflow?.[field] ?? []) : [];
  const liveCount = mode === 'watchlist+whitelist' ? new Set([...watchlist, ...editable]).size : mode === 'explicit' ? editable.length : (screen?.symbols.length ?? 0);

  const save = useMutation({
    mutationFn: (list: string[]) => api.patchWorkflow(field ? { [field]: list } : {}),
    onSuccess: (res) => {
      if (res.errors?.length) {
        toast.error(t('没保存'), { description: res.errors.join('；') });
        return;
      }
      queryClient.setQueryData(['workflow'], res.workflow);
      setText('');
    },
    onError: (err) => toast.error(t('没保存'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const add = () => {
    const incoming = text
      .split(/[,\s]+/)
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
      .map((x) => (x.endsWith('USDT') ? x : `${x}USDT`));
    const bad = incoming.filter((x) => !SYMBOL_RE.test(x));
    if (bad.length) {
      toast.error(t('币种格式不对'), { description: t('{list}(要写成 BTCUSDT 这样)', { list: bad.join('、') }) });
      return;
    }
    const next = [...new Set([...editable, ...incoming])];
    if (next.length === editable.length) {
      toast.info(t('都已经在里面了'));
      setText('');
      return;
    }
    save.mutate(next);
  };
  const remove = (sym: string) => save.mutate(editable.filter((x) => x !== sym));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" title={t('点开加 / 删范围里的币')}>
          <Badge variant="outline" className="h-4 cursor-pointer px-1.5 text-[10px] hover:bg-muted/60">
            {label} · {t('{n} 个', { n: liveCount })}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] p-3 text-[12px]">
        <div className="mb-2 flex items-baseline justify-between">
          <div className="font-medium">{label}</div>
          <div className="text-[10.5px] text-muted-foreground">
            {mode === 'top_volume' ? t('按 24h 成交额自动挑,改范围去设置') : mode === 'watchlist+whitelist' ? t('观察列表 ∪ 白名单;白名单在这儿直接改') : t('手填列表在这儿直接改')}
          </div>
        </div>
        {mode === 'watchlist+whitelist' && watchlist.length ? (
          <div className="mb-2">
            <div className="mb-1 text-[10.5px] text-muted-foreground">{t('观察列表 {n} 个(在「盯盘参数」页里改)', { n: watchlist.length })}</div>
            <div className="flex flex-wrap gap-1">
              {watchlist.map((sym) => (
                <Badge key={sym} variant="outline" className="h-5 border-up/30 bg-up/10 px-1.5 text-[11px] text-up">
                  {sym}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
        {field ? (
          <>
            <div className="mb-1 text-[10.5px] text-muted-foreground">
              {mode === 'explicit' ? t('手填') : t('白名单')} {t('{n} 个,点 × 删', { n: editable.length })}
            </div>
            <div className="mb-2 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
              {editable.length === 0 ? <span className="text-[11px] text-muted-foreground">{t('空')}</span> : null}
              {editable.map((sym) => (
                <span key={sym} className="inline-flex h-5 items-center gap-0.5 rounded-md border px-1.5 text-[11px]">
                  {sym}
                  {watchlist.includes(sym) ? <span className="text-[9px] text-muted-foreground">{t('(也在观察)')}</span> : null}
                  <button type="button" className="ml-0.5 text-muted-foreground hover:text-down" disabled={save.isPending} title={t('删除')} onClick={() => remove(sym)}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                className="num h-7 flex-1"
                placeholder={t('加币:BTCUSDT 或 btc,eth(可以多个)')}
                value={text}
                disabled={save.isPending}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <Button size="sm" disabled={!text.trim() || save.isPending} onClick={add}>
                <Plus data-slot="icon" />
                {t('加')}
              </Button>
            </div>
            <div className="mt-1.5 text-[10.5px] text-muted-foreground">{t('改完下次筛选生效;币安上没有的会被跳过。')}</div>
          </>
        ) : mode === 'watchlist+whitelist' ? (
          <div className="text-[11px] text-muted-foreground">{t('这个网关版本还不能编辑白名单,升级之后再来。')}</div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// 行展开:逐策略的条件命中

function ConditionChip({ c }: { c: StrategyFit['conditions'][number] }) {
  const tone = c.pass ? 'border-up/30 bg-up/10 text-up' : c.near ? 'border-warn/30 bg-warn/10 text-warn' : 'border-border bg-muted/40 text-muted-foreground';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10.5px]', tone)}>
          <span>{c.pass ? '✓' : c.near ? '~' : '✕'}</span>
          {c.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{c.detail || c.key}</TooltipContent>
    </Tooltip>
  );
}

function StrategyFitBlock({ fit }: { fit: StrategyFit }) {
  return (
    <div className="rounded-sm border bg-background/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium">{fit.name}</span>
        <span className="text-[10.5px] text-muted-foreground">
          v{fit.version} · {fit.status}
        </span>
        <span className={cn('num text-[12px] font-semibold', fitClass(fit.fit_score))}>{fmtScore(fit.fit_score)}</span>
        <span className="num text-[10.5px] text-muted-foreground">
          {t('{passed}/{total} 过', { passed: fit.passed, total: fit.total })}{fit.near ? ` · ${t('{n} 近', { n: fit.near })}` : ''}
        </span>
        {fit.direction ? (
          <Badge
            variant="outline"
            className={cn('h-4 px-1.5 text-[10px]', fit.direction === 'long' ? 'border-up/30 bg-up/15 text-up' : 'border-down/30 bg-down/15 text-down')}
          >
            {directionLabel(fit.direction)}
          </Badge>
        ) : null}
        {fit.expectancy ? (
          <span className="num text-[10.5px] text-muted-foreground">
            {t('期望')} {fit.expectancy.expectancy_r === null ? '—' : `${fit.expectancy.expectancy_r.toFixed(2)}R`} · n={fit.expectancy.n} ·{' '}
            {fit.expectancy.win_rate === null ? '—' : `${(fit.expectancy.win_rate * 100).toFixed(0)}%`} · {fit.expectancy.per_week.toFixed(1)}{t('/周')}
          </span>
        ) : fit.expectancy_note ? (
          <span className="text-[10.5px] text-muted-foreground">{fit.expectancy_note}</span>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {fit.conditions.map((c) => (
          <ConditionChip key={c.key} c={c} />
        ))}
      </div>
      {fit.reasons.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
          {fit.reasons.map((r, i) => (
            <li key={i}>· {r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 名次表

function ReasonList({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <div className="space-y-1">
      {reasons.map((r, i) =>
        isModelReason(r) ? (
          // 模型自由文本:不可信,和代码算出来的证据分开画。
          <div key={i} className="flex items-start gap-1.5 rounded-sm border border-warn/30 bg-warn/10 px-1.5 py-1 text-[11px] text-warn italic">
            <span className="shrink-0 rounded-sm bg-warn/20 px-1 text-[9.5px] not-italic">{t('模型生成 · 没核实过')}</span>
            <span className="min-w-0">{r.replace(/^\s*模型[:：]\s*/, '')}</span>
          </div>
        ) : (
          <div key={i} className="text-[11px] text-muted-foreground">
            {r}
          </div>
        ),
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  expanded,
  onToggle,
  inWatchlist,
  watchOnly,
  watchFull,
  watchBusy,
  onWatch,
  picked,
  onPick,
}: {
  candidate: WatchCandidate;
  expanded: boolean;
  onToggle: () => void;
  inWatchlist: boolean;
  /** 名单里标了「只观察」(workflow.watch_only),和 Agent 页名单表同一口径 */
  watchOnly: boolean;
  watchFull: boolean;
  watchBusy: boolean;
  onWatch: () => void;
  picked: boolean;
  onPick: (v: boolean) => void;
}) {
  const card = candidate.card;
  const best = card.strategies.find((s) => s.strategy_id === candidate.strategy_id) ?? null;
  const disabled = inWatchlist || watchFull || watchBusy;
  const reason = inWatchlist ? t('已经在名单里了(去「盯盘参数」页改可交易 / 只观察,或者移掉)') : watchFull ? t('名单满了,先去「盯盘参数」页移掉一个,或者调高上限') : null;

  const watchBtn = inWatchlist ? (
    <a href="#agent" className={cn('inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px]', watchOnly ? 'border-warn/30 bg-warn/10 text-warn' : 'border-up/30 bg-up/10 text-up')} title={t('已在名单;点这里去名单表')}>
      <Eye className="size-3" />
      {watchOnly ? t('只观察') : t('可交易')}
    </a>
  ) : (
    <Button size="xs" variant="outline" disabled={disabled} onClick={onWatch}>
      <Eye data-slot="icon" />
      {t('加入名单')}
    </Button>
  );

  return (
    <>
      <tr className={cn('border-b hover:bg-muted/40', picked && 'bg-primary/5')}>
        <td className="px-2 py-1.5 align-top">
          <input
            type="checkbox"
            className="size-3.5 accent-primary disabled:opacity-30"
            checked={picked}
            disabled={inWatchlist}
            title={inWatchlist ? t('已经在名单里') : t('勾上,用上面的「加入名单」一起加')}
            onChange={(e) => onPick(e.target.checked)}
          />
        </td>
        <td className="px-2 py-1.5 align-top">
          <button type="button" className="flex items-center gap-1 text-left" onClick={onToggle}>
            {expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
            <span className="num text-[12px] text-muted-foreground">{candidate.rank}</span>
          </button>
        </td>
        <td className="px-2 py-1.5 align-top text-[12.5px] font-medium">{candidate.symbol}</td>
        <td className="px-2 py-1.5 align-top">
          <div className="text-[12px]">{best?.name ?? candidate.strategy_id}</div>
          <div className={cn('num text-[12px] font-semibold', fitClass(candidate.fit_score))}>{fmtScore(candidate.fit_score)}</div>
        </td>
        <td className="px-2 py-1.5 align-top">
          {card.trend.agree ? (
            <Badge
              variant="outline"
              className={cn('h-4 px-1.5 text-[10px]', card.trend.agree === 'long' ? 'border-up/30 bg-up/15 text-up' : 'border-down/30 bg-down/15 text-down')}
            >
              {t('{side}一致', { side: directionLabel(card.trend.agree) })}
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t('不一致')}</span>
          )}
          <div className="num mt-0.5 text-[10.5px] text-muted-foreground">
            ADX {fmtNum(card.trend.adx_base, 1)} / {fmtNum(card.trend.adx_confirm, 1)}
          </div>
        </td>
        <td className="px-2 py-1.5 align-top">
          <div className="num text-[12px]">{fmtPctNum(card.atr_pct)}</div>
          <div className="num text-[10.5px] text-muted-foreground">
            {card.atr_pct_rank_90 === null ? '—' : t('分位 {n}%', { n: (card.atr_pct_rank_90 * 100).toFixed(0) })}
          </div>
        </td>
        <td className="px-2 py-1.5 align-top">
          {card.squeeze_on ? (
            <Badge variant="outline" className="h-4 border-warn/30 bg-warn/10 px-1.5 text-[10px] text-warn">
              {t('挤压 {n} 根', { n: card.squeeze_bars ?? 0 })}
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          )}
        </td>
        <td className="num px-2 py-1.5 align-top text-[12px]">
          {fmtNum(card.funding.z_30d)}
          <div className="num text-[10.5px] text-muted-foreground">{fmtPctNum(card.funding.rate_pct, 4)}</div>
        </td>
        <td className="px-2 py-1.5 align-top">
          <div className="num text-[12px]">{fmtCompact(card.volume.quote_24h)}</div>
          <div className="num text-[10.5px] text-muted-foreground">{card.volume.rank === null ? '—' : `#${card.volume.rank}/${card.volume.of}`}</div>
        </td>
        <td className="max-w-96 px-2 py-1.5 align-top">
          <ReasonList reasons={candidate.reasons} />
        </td>
        <td className="px-2 py-1.5 text-right align-top">
          {reason ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{watchBtn}</span>
              </TooltipTrigger>
              <TooltipContent>{reason}</TooltipContent>
            </Tooltip>
          ) : (
            watchBtn
          )}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b bg-muted/20">
          <td colSpan={11} className="px-3 py-2">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                {card.timeframe} / {t('确认')} {card.confirm_timeframe} · {t('{n} 根', { n: card.bars })}
              </span>
              {card.daily_regime ? <span>{t('日线')} {card.daily_regime}</span> : null}
              {card.reversion?.text ? <span>{card.reversion.text}</span> : null}
              {card.note ? <span className="text-warn">{card.note}</span> : null}
              <span>{card.trend.note}</span>
            </div>
            <div className="grid gap-1.5">
              {card.strategies.length === 0 ? (
                <div className="text-[11.5px] text-muted-foreground">{t('这张卡上没有任何策略打分。')}</div>
              ) : (
                [...card.strategies]
                  .sort((a, b) => b.fit_score - a.fit_score)
                  .map((f) => <StrategyFitBlock key={`${f.strategy_id}-${f.version}`} fit={f} />)
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CandidatesTable({
  candidates,
  watchlist,
  watchOnly,
  watchlistMax,
  watchBusy,
  onWatch,
  onWatchMany,
  batchBusy,
}: {
  candidates: WatchCandidate[];
  watchlist: string[];
  watchOnly: string[];
  watchlistMax: number;
  watchBusy: string | null;
  onWatch: (symbol: string) => void;
  onWatchMany: (symbols: string[]) => void;
  batchBusy: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const pickable = [...new Set(candidates.map((c) => c.symbol))].filter((s) => !watchlist.includes(s));
  const pickedList = pickable.filter((s) => picked.has(s));
  const room = Math.max(0, watchlistMax - watchlist.length);
  const setPick = (symbol: string, v: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (v) next.add(symbol);
      else next.delete(symbol);
      return next;
    });
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const full = watchlist.length >= watchlistMax;

  return (
    <div className="overflow-x-auto">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          checked={pickable.length > 0 && pickedList.length === pickable.length}
          disabled={pickable.length === 0}
          onChange={(e) => setPicked(e.target.checked ? new Set(pickable) : new Set())}
          title={t('全选还没进名单的候选')}
        />
        <span>
          {t('勾了')} <span className="num">{pickedList.length}</span> {t('个 · 名单')} <span className="num">{watchlist.length}/{watchlistMax}</span>
          {room < pickedList.length ? <span className="ml-1 text-warn">{t('(超上限 {n} 个,会被截掉;上限在设置里调)', { n: pickedList.length - room })}</span> : null}
        </span>
        <Button size="xs" className="ml-auto" disabled={pickedList.length === 0 || batchBusy} onClick={() => onWatchMany(pickedList)}>
          <Eye data-slot="icon" />
          {batchBusy ? t('加入中…') : t('加入名单({n})', { n: pickedList.length })}
        </Button>
      </div>
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-1 bg-muted/60 text-[10.5px] text-muted-foreground">
          <tr className="border-b">
            <th className="w-6 px-2 py-1 font-medium" />
            <th className="px-2 py-1 font-medium">#</th>
            <th className="px-2 py-1 font-medium">{t('币种')}</th>
            <th className="px-2 py-1 font-medium">{t('最佳策略 / 契合度')}</th>
            <th className="px-2 py-1 font-medium">{t('趋势 / ADX')}</th>
            <th className="px-2 py-1 font-medium">{t('ATR% / 分位')}</th>
            <th className="px-2 py-1 font-medium">{t('挤压')}</th>
            <th className="px-2 py-1 font-medium">{t('资金费 z')}</th>
            <th className="px-2 py-1 font-medium">{t('24h 成交额')}</th>
            <th className="px-2 py-1 font-medium">{t('理由')}</th>
            <th className="px-2 py-1 text-right font-medium">{t('操作')}</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => {
            const key = `${c.screen_id}-${c.symbol}-${c.strategy_id}`;
            return (
              <CandidateRow
                key={key}
                candidate={c}
                expanded={expanded.has(key)}
                onToggle={() => toggle(key)}
                inWatchlist={watchlist.includes(c.symbol)}
                watchOnly={watchOnly.includes(c.symbol)}
                watchFull={full}
                watchBusy={watchBusy === c.symbol}
                onWatch={() => onWatch(c.symbol)}
                picked={picked.has(c.symbol) && !watchlist.includes(c.symbol)}
                onPick={(v) => setPick(c.symbol, v)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 设置抽屉

function SettingsSheet({ open, onOpenChange, workflow }: { open: boolean; onOpenChange: (v: boolean) => void; workflow: Workflow | null }) {
  const queryClient = useQueryClient();
  const merged = { ...SCREENER_DEFAULTS, ...(workflow ?? {}) };
  const [draft, setDraft] = useState(merged);
  const [symbolsText, setSymbolsText] = useState((merged.screener_symbols ?? []).join(','));
  const [whitelistText, setWhitelistText] = useState((merged.screener_whitelist ?? []).join(','));
  // 老网关没有 screener_whitelist 字段时不发这个键,免得 PATCH 被整个打回
  const whitelistSupported = Array.isArray(workflow?.screener_whitelist);

  useEffect(() => {
    if (!open) return;
    const next = { ...SCREENER_DEFAULTS, ...(workflow ?? {}) };
    setDraft(next);
    setSymbolsText((next.screener_symbols ?? []).join(','));
    setWhitelistText((next.screener_whitelist ?? []).join(','));
    // 只在打开时从服务端灌一次,免得保存中途被 SSE 覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useMutation({
    mutationFn: (patch: Partial<Workflow>) => api.patchWorkflow(patch),
    onSuccess: (res) => {
      if (res.errors?.length) {
        toast.error(t('有几项没保存'), { description: res.errors.join('；') });
        return;
      }
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['screener'] });
      toast.success(t('筛选设置保存好了'));
      onOpenChange(false);
    },
    onError: (err) => toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const parseList = (text: string) =>
    text
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

  const submit = () => {
    const symbols = parseList(symbolsText);
    save.mutate({
      ...(whitelistSupported ? { screener_whitelist: parseList(whitelistText) } : {}),
      screener_enabled: draft.screener_enabled,
      screener_short_every_ms: draft.screener_short_every_ms,
      screener_swing_every_ms: draft.screener_swing_every_ms,
      screener_universe: draft.screener_universe,
      screener_symbols: symbols,
      screener_max_symbols: draft.screener_max_symbols,
      screener_use_brain: draft.screener_use_brain,
      screener_apply: draft.screener_apply,
      screener_expectancy: draft.screener_expectancy,
      watchlist_max: draft.watchlist_max,
    });
  };

  const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[24rem] sm:max-w-none">
        <SheetHeader>
          <SheetTitle>{t('筛选设置')}</SheetTitle>
          <SheetDescription>{t('雷达的排程、范围和提案方式。周线固定 7 天一次,改不了。')}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-[12px]">{t('定时筛选')}</Label>
            <Switch checked={draft.screener_enabled} onCheckedChange={(v) => setDraft((d) => ({ ...d, screener_enabled: v }))} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label className="text-[12px]">{t('短线周期(小时)')}</Label>
            <Input
              className="num h-7 w-24"
              type="number"
              min={1}
              step={1}
              value={hours(draft.screener_short_every_ms)}
              onChange={(e) => setDraft((d) => ({ ...d, screener_short_every_ms: Math.max(1, Number(e.target.value) || 1) * 3_600_000 }))}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label className="text-[12px]">{t('中线周期(小时)')}</Label>
            <Input
              className="num h-7 w-24"
              type="number"
              min={1}
              step={1}
              value={hours(draft.screener_swing_every_ms)}
              onChange={(e) => setDraft((d) => ({ ...d, screener_swing_every_ms: Math.max(1, Number(e.target.value) || 1) * 3_600_000 }))}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label className="text-[12px]">{t('扫描范围')}</Label>
            <Select value={draft.screener_universe} onValueChange={(v) => setDraft((d) => ({ ...d, screener_universe: v as ScreenUniverse }))}>
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(UNIVERSE_LABEL) as ScreenUniverse[]).map((u) => (
                  <SelectItem key={u} value={u}>
                    {UNIVERSE_LABEL[u]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-[12px]">{t('手填币种(逗号分隔,范围选「手填列表」时生效)')}</Label>
            <Input className="num h-7" value={symbolsText} placeholder="BTCUSDT,ETHUSDT" onChange={(e) => setSymbolsText(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-[12px]">
              {t('白名单(范围选「观察列表 + 白名单」时生效,')}{whitelistSupported ? t('{n} 个', { n: parseList(whitelistText).length }) : t('这个网关版本不支持')}{')'}
            </Label>
            <Textarea
              className="num min-h-20 text-[11.5px]"
              value={whitelistText}
              disabled={!whitelistSupported}
              placeholder="BTCUSDT,ETHUSDT,SOLUSDT…"
              onChange={(e) => setWhitelistText(e.target.value)}
            />
            <div className="text-[10.5px] text-muted-foreground">{t('逗号或空格分隔;币安上没有的,筛选时会跳过。留空 = 只筛观察列表。')}</div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label className="text-[12px]">{t('最多扫多少个(1–300)')}</Label>
            <Input
              className="num h-7 w-24"
              type="number"
              min={1}
              max={300}
              value={draft.screener_max_symbols}
              onChange={(e) => setDraft((d) => ({ ...d, screener_max_symbols: Math.min(300, Math.max(1, Number(e.target.value) || 1)) }))}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label className="text-[12px]">{t('观察列表上限')}</Label>
            <Input
              className="num h-7 w-24"
              type="number"
              min={1}
              value={draft.watchlist_max}
              max={300}
              onChange={(e) => setDraft((d) => ({ ...d, watchlist_max: Math.min(300, Math.max(1, Number(e.target.value) || 1)) }))}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div>
              <Label className="text-[12px]">{t('用副脑复排')}</Label>
              <div className="text-[10.5px] text-muted-foreground">{t('要花钱;模型只重排理由,不改代码算出来的分数。')}</div>
            </div>
            <Switch checked={draft.screener_use_brain} onCheckedChange={(v) => setDraft((d) => ({ ...d, screener_use_brain: v }))} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div>
              <Label className="text-[12px]">{t('算前瞻期望')}</Label>
              <div className="text-[10.5px] text-muted-foreground">{t('纯代码回看,会慢一些。')}</div>
            </div>
            <Switch checked={draft.screener_expectancy} onCheckedChange={(v) => setDraft((d) => ({ ...d, screener_expectancy: v }))} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div>
              <Label className="text-[12px]">{t('提案方式')}</Label>
              <div className="text-[10.5px] text-muted-foreground">{t('选自动应用,它就直接改观察列表,不再问你。')}</div>
            </div>
            <Select
              value={draft.screener_apply}
              onValueChange={(v) => setDraft((d) => ({ ...d, screener_apply: v as NonNullable<Workflow['screener_apply']> }))}
            >
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="propose">{t('只提案')}</SelectItem>
                <SelectItem value="auto">{t('自动应用')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <SheetFooter>
          <Button size="sm" disabled={save.isPending} onClick={submit}>
            {save.isPending ? t('保存中…') : t('保存')}
          </Button>
          <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 历史

function HistoryList({
  screens,
  activeId,
  now,
  onPick,
}: {
  screens: ScreenRow[];
  activeId: string | null;
  now: number;
  onPick: (id: string) => void;
}) {
  if (screens.length === 0) return <div className="px-3 py-4 text-[11.5px] text-muted-foreground">{t('还没有历史。')}</div>;
  return (
    <ul className="divide-y">
      {screens.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => onPick(s.id)}
            className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] hover:bg-muted/50', s.id === activeId && 'bg-muted/60')}
          >
            <span className="num text-muted-foreground" title={fmtDateTime(s.started_at)}>
              {relativeTime(s.finished_at ?? s.started_at, now)}
            </span>
            <Badge
              variant="outline"
              className={cn(
                'h-4 px-1.5 text-[10px]',
                s.status === 'done'
                  ? 'border-up/30 bg-up/10 text-up'
                  : s.status === 'failed'
                    ? 'border-down/30 bg-down/10 text-down'
                    : 'border-warn/30 bg-warn/10 text-warn',
              )}
            >
              {s.status === 'done' ? t('完成') : s.status === 'failed' ? t('失败') : t('进行中')}
            </Badge>
            <span className="num text-muted-foreground">{t('{n} 个', { n: s.symbols.length })}</span>
            <span className="num text-muted-foreground">{fmtCny(s.cost_cny)}</span>
            {s.proposal ? <span className="text-muted-foreground">{t('提案 {n} 个', { n: s.proposal.symbols.length })}</span> : null}
            {s.errors.length > 0 ? <span className="text-down">{t('{n} 个报错', { n: s.errors.length })}</span> : null}
            <span className="num ml-auto truncate text-[10.5px] text-muted-foreground">{s.id}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// 页面

export function ScreenerPage() {
  const queryClient = useQueryClient();
  const now = useNow(1000);
  const [horizon, setHorizon] = useState<ScreenHorizon>('short');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [watchBusy, setWatchBusy] = useState<string | null>(null);

  const latestQ = useQuery({ queryKey: ['screener', 'latest', horizon], queryFn: () => api.screenerLatest(horizon) });
  const historyQ = useQuery({ queryKey: ['screener', 'history', horizon], queryFn: () => api.screenerHistory(horizon, 20) });
  const detailQ = useQuery({
    queryKey: ['screener', 'detail', pickedId ?? ''],
    queryFn: () => api.screen(pickedId as string),
    enabled: pickedId !== null,
  });
  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });

  const latest = latestQ.data ?? null;
  const viewingOld = pickedId !== null && pickedId !== latest?.screen?.id;
  const screen = viewingOld ? (detailQ.data?.screen ?? null) : (latest?.screen ?? null);
  const candidates = viewingOld ? (detailQ.data?.candidates ?? []) : (latest?.candidates ?? []);
  const horizons = latest?.horizons?.length ? latest.horizons : HORIZONS;
  const schedule = latest?.schedule?.find((s) => s.horizon === horizon) ?? null;

  const workflow = workflowQ.data ?? null;
  const watchlist = latest?.watchlist ?? workflow?.watchlist ?? [];
  const watchlistMax = latest?.watchlist_max ?? workflow?.watchlist_max ?? SCREENER_DEFAULTS.watchlist_max;
  const watchOnly = workflow?.watch_only ?? [];

  // 排程里没有 weekly 的 every_ms 时按固定 7d 显示
  const scheduleView: ScreenSchedule | null = useMemo(() => {
    if (!schedule) return null;
    if (horizon === 'weekly' && !schedule.every_ms) return { ...schedule, every_ms: WEEKLY_EVERY_MS };
    return schedule;
  }, [schedule, horizon]);

  const run = useMutation({
    mutationFn: () => api.runScreener(horizon),
    onSuccess: () => {
      toast.info(t('筛选开始了,结果出来自动刷新'));
      void queryClient.invalidateQueries({ queryKey: ['screener'] });
    },
    // 409:该周期正在跑,或运行时被暂停了——网关的 message 会说清是哪种
    onError: (err) => toast.error(t('跑不了'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const apply = useMutation({
    mutationFn: ({ id, watchlist }: { id: string; watchlist: string[] }) => api.applyScreen(id, watchlist),
    onSuccess: (res) => {
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['screener'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(t('观察列表更新了:{n} 个', { n: res.after.length }));
      setApplyOpen(false);
    },
    onError: (err) => toast.error(t('应用失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const addWatch = useMutation({
    mutationFn: (symbol: string) => api.patchWorkflow({ watchlist: [...watchlist, symbol].slice(0, watchlistMax) }),
    onSuccess: (res, symbol) => {
      if (res.errors?.length) {
        toast.error(t('没能加进观察列表'), { description: res.errors.join('；') });
        return;
      }
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['screener'] });
      toast.success(t('{symbol} 加进观察列表了', { symbol }));
    },
    onError: (err) => toast.error(t('没能加进观察列表'), { description: err instanceof Error ? err.message : String(err) }),
    onSettled: () => setWatchBusy(null),
  });

  const addWatchMany = useMutation({
    mutationFn: (symbols: string[]) => api.patchWorkflow({ watchlist: [...new Set([...watchlist, ...symbols])].slice(0, watchlistMax) }),
    onSuccess: (res, symbols) => {
      if (res.errors?.length) {
        toast.error(t('没能加进观察列表'), { description: res.errors.join('；') });
        return;
      }
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['screener'] });
      toast.success(t('加进观察列表了:{list}', { list: symbols.join('、') }));
    },
    onError: (err) => toast.error(t('没能加进观察列表'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const proposal = screen?.proposal ?? null;
  const applyDisabledReason = !screen
    ? t('还没有筛选结果')
    : screen.status === 'running'
      ? t('这次筛选还没跑完')
      : !proposal || proposal.symbols.length === 0
        ? t('这次没有提案')
        : null;

  // 确认框里的勾选:默认 = 提案原样(新增全勾、移出全不勾);点 chip 翻转。打开时重置。
  const proposed = proposal ? proposal.symbols : [];
  const [pick, setPick] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (applyOpen) setPick(new Set(proposed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyOpen, screen?.id]);
  const togglePick = (s: string) =>
    setPick((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const universe = [...new Set([...watchlist, ...proposed])];
  const after = universe.filter((s) => pick.has(s)).slice(0, watchlistMax);
  const added = after.filter((s) => !watchlist.includes(s));
  const removed = watchlist.filter((s) => !after.includes(s));
  const overCap = universe.filter((s) => pick.has(s)).length - after.length;

  const loading = latestQ.isLoading || (viewingOld && detailQ.isLoading);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ScreenerHeader
        workflow={workflow}
        horizon={horizon}
        onHorizon={(h) => {
          setHorizon(h);
          setPickedId(null);
        }}
        horizons={horizons}
        screen={screen}
        schedule={scheduleView}
        now={now}
        viewingOld={viewingOld}
        onBackToLatest={() => setPickedId(null)}
        running={run.isPending}
        onRun={() => run.mutate()}
        applyDisabledReason={applyDisabledReason}
        onApply={() => setApplyOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {screen && screen.errors.length > 0 ? (
          <Workspace className="shrink-0">
            <Pane title={t('这次的报错')} hint={t('{n} 个币没算出来', { n: screen.errors.length })}>
              <ul className="max-h-32 space-y-1 overflow-y-auto p-2">
                {screen.errors.map((e, i) => (
                  <li key={`${e.symbol}-${i}`} className="rounded-sm border border-down/30 bg-down/10 px-2 py-1 text-[11.5px] text-down">
                    <span className="font-medium">{e.symbol}</span> — {e.error}
                  </li>
                ))}
              </ul>
            </Pane>
          </Workspace>
        ) : null}

        {screen?.error ? (
          <div className="shrink-0 rounded-md border border-down/30 bg-down/10 px-3 py-2 text-[12px] text-down">{screen.error}</div>
        ) : null}

        <Workspace className="shrink-0">
          <Pane
            title={t('候选名次')}
            hint={
              screen
                ? `${t('{n} 张卡', { n: candidates.length })}${proposal ? ` · ${t('提案 {n} 个', { n: proposal.symbols.length })}` : ''}${
                    screen.brain?.used ? ` · ${t('模型 {name} 复排', { name: screen.brain.model ?? '?' })}` : ''
                  }`
                : undefined
            }
            contentClassName="min-h-0"
          >
            {loading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : latestQ.isError ? (
              <div className="py-8 text-center text-[12px] text-destructive">{t('筛选结果加载失败。')}</div>
            ) : !screen ? (
              <div className="flex flex-col items-center gap-1.5 py-10 text-center">
                <div className="text-[12.5px] text-muted-foreground">{t('这个周期还没跑过筛选。')}</div>
                <div className="text-[11.5px] text-muted-foreground">
                  {scheduleView?.enabled === false
                    ? t('定时筛选是关的。点右上角「立即筛选」跑一次,或者去设置里打开排程。')
                    : scheduleView?.next_at
                      ? t('下次自动跑在 {time},也可以点右上角「立即筛选」。', { time: fmtDateTime(scheduleView.next_at) })
                      : t('点右上角「立即筛选」跑第一次。')}
                </div>
              </div>
            ) : candidates.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-muted-foreground">
                {screen.status === 'running' ? t('正在算,稍等…') : t('这次一个候选都没挑出来。')}
              </div>
            ) : (
              <CandidatesTable
                candidates={candidates}
                watchlist={watchlist}
                watchOnly={watchOnly}
                watchlistMax={watchlistMax}
                watchBusy={watchBusy}
                onWatch={(symbol) => {
                  setWatchBusy(symbol);
                  addWatch.mutate(symbol);
                }}
                onWatchMany={(symbols) => addWatchMany.mutate(symbols)}
                batchBusy={addWatchMany.isPending}
              />
            )}
          </Pane>
        </Workspace>

        <Workspace className="shrink-0">
          <Pane title={t('历史')} hint={historyQ.data ? t('最近 {n} 次', { n: historyQ.data.screens.length }) : undefined}>
            {historyQ.isLoading ? (
              <div className="space-y-1.5 p-2">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : historyQ.isError ? (
              <div className="py-4 text-center text-[11.5px] text-destructive">{t('历史加载失败。')}</div>
            ) : (
              <HistoryList
                screens={historyQ.data?.screens ?? []}
                activeId={screen?.id ?? null}
                now={now}
                onPick={(id) => setPickedId(id === latest?.screen?.id ? null : id)}
              />
            )}
          </Pane>
        </Workspace>
      </div>

      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} workflow={workflow} />

      <ConfirmDialog
        open={applyOpen}
        title={t('应用筛选提案')}
        summary={t('改观察列表')}
        busy={apply.isPending}
        onCancel={() => setApplyOpen(false)}
        onConfirm={() => {
          if (!screen) return;
          if (after.length === 0) {
            toast.error(t('至少留一个币'), { description: t('观察列表不能是空的;勾回一个再应用。') });
            return;
          }
          apply.mutate({ id: screen.id, watchlist: after });
        }}
      >
        <p className="text-muted-foreground">{t('这一步只改工作流的观察列表,不动策略、不下单。点币种能勾 / 去勾:留住要移出的,或者去掉不想要的新币。')}</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">{t('现在({n})', { n: watchlist.length })}</div>
            <div className="flex flex-wrap gap-1">
              {watchlist.length === 0 ? <span className="text-[11.5px] text-muted-foreground">{t('空')}</span> : null}
              {watchlist.map((s) => (
                <button key={s} type="button" onClick={() => togglePick(s)} title={pick.has(s) ? t('点一下移出') : t('点一下留住')}>
                  <Badge variant="outline" className={cn('h-5 cursor-pointer px-1.5 text-[11px]', removed.includes(s) && 'border-down/30 bg-down/10 text-down line-through')}>
                    {s}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">
              {t('应用后')}({after.length}/{watchlistMax})
            </div>
            <div className="flex flex-wrap gap-1">
              {after.length === 0 ? <span className="text-[11.5px] text-muted-foreground">{t('空')}</span> : null}
              {universe
                .filter((s) => !watchlist.includes(s) || after.includes(s))
                .map((s) => {
                  const on = after.includes(s);
                  return (
                    <button key={s} type="button" onClick={() => togglePick(s)} title={on ? t('点一下去掉') : t('点一下加回')}>
                      <Badge
                        variant="outline"
                        className={cn(
                          'h-5 cursor-pointer px-1.5 text-[11px]',
                          on && added.includes(s) && 'border-up/30 bg-up/10 text-up',
                          !on && 'border-dashed text-muted-foreground line-through opacity-60',
                        )}
                      >
                        {s}
                      </Badge>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
        <div className="text-[11.5px] text-muted-foreground">
          {t('新增 {added} 个,移出 {removed} 个。', { added: added.length, removed: removed.length })}{overCap > 0 ? ` ${t('超名单上限 {n} 个,会被截掉(上限在设置里调)。', { n: overCap })}` : ''}
          {proposal?.note ? <span className="ml-1">{proposal.note}</span> : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
