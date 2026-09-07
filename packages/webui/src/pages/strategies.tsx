/**
 * 策略库页(#/strategies,v3.5,design notes):
 * 一条策略是**不可变的版本化对象**——触发(哪些事件才唤醒它)+ 清单(代码必须能算出来的证据)+
 * 规则(模型只能在这些边里选)+ 参数(带范围,改一个就是新版本 + 新 hash)+ 评测统计。
 *
 * 这一页刻意**没有**「直接改一个在跑的策略的数字」这条路:
 *   改参数 = 采纳一条归因 → 生成 draft 新版本;
 *   上线   = draft → backtest → shadow → paper → live_capped 一格一格晋升,
 *            而且 paper → live_capped 必须原样输入 LIVE 才放行;
 *   实盘启用开关只对 ≥ paper 的策略开放,低于 paper 的开关是灰的。
 *
 * react-query key 约定见 App.tsx 顶部注释:
 *   ['strategies']      GET /api/strategies(列表 + active + 文案表)
 *   ['strategies', id]  GET /api/strategies/:id(spec + 版本列表 + 归因点)
 * 任何写操作后两个 key 都失效;SSE `strategy.changed` 在 App.tsx 里按 ['strategies'] 前缀
 * 一次性失效,本页不自己开 /api/events。
 */
import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, History, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { AttributionKind, AttributionPoint, StrategySpec, StrategyStatus, StrategyView } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { fmtDateTime, triggerLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 文案与样式(策略库契约独有,只在本页用,不进 lib/format.ts)

/** 晋升路线,retired 不在其中。「低于 paper 不能实盘启用」也按这个序判定。 */
const STATUS_ORDER: StrategyStatus[] = ['draft', 'backtest', 'shadow', 'paper', 'live_capped'];

const FALLBACK_STATUS_LABEL: Record<StrategyStatus, string> = tmap({
  draft: '草稿',
  backtest: '回测中',
  shadow: '影子',
  paper: '纸面',
  live_capped: '限额实盘',
  retired: '已退役',
});

/** 配色约束沿用全站口径:绿/红只表示多空或盈亏,所以 live_capped 用强调色 + 加粗,不用红。 */
function statusBadgeClass(status: StrategyStatus): string {
  switch (status) {
    case 'backtest':
      return 'bg-primary/15 text-primary border-primary/30';
    case 'shadow':
      return 'bg-warn/15 text-warn border-warn/30';
    case 'paper':
      return 'bg-up/15 text-up border-up/30';
    case 'live_capped':
      return 'bg-accent text-accent-foreground border-foreground/25 font-semibold';
    case 'retired':
      return 'bg-muted text-muted-foreground border-transparent opacity-60';
    default:
      return 'bg-muted text-muted-foreground border-transparent'; // draft
  }
}

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

function statusRank(status: StrategyStatus): number {
  return STATUS_ORDER.indexOf(status);
}

/** 低于 paper 的(草稿/回测中/影子)以及已退役的,都不能挂到实盘启用列表里。 */
function canGoLive(status: StrategyStatus): boolean {
  const r = statusRank(status);
  return r >= 0 && r >= statusRank('paper');
}

function fmtR(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`;
}

function fmtWinRate(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

// ---------------------------------------------------------------------------
// 小组件

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground select-none">{label}</div>
      <div className={cn('num truncate text-[11px] font-semibold', tone === 'up' && 'text-up', tone === 'down' && 'text-down')}>{value}</div>
    </div>
  );
}

function LineList({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10.5px] font-semibold text-muted-foreground select-none">{title}</div>
      <ul className="flex flex-col gap-0.5">
        {lines.map((line, i) => (
          <li key={`${i}-${line}`} className="flex gap-1.5 text-[11px] leading-relaxed">
            <span className="num shrink-0 text-muted-foreground">{i + 1}.</span>
            <span className="min-w-0 flex-1">{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 卡片

function StrategyCard({
  s,
  busy,
  onToggleActive,
  onPromote,
  onRetire,
  onOpenDetail,
}: {
  s: StrategyView;
  busy: boolean;
  onToggleActive: (next: boolean) => void;
  onPromote: () => void;
  onRetire: () => void;
  onOpenDetail: () => void;
}) {
  const liveAllowed = canGoLive(s.status);
  const entryPreview = s.rules.entry.slice(0, 2);
  const st = s.eval_stats;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 rounded-md border bg-card px-2.5 py-2', s.status === 'retired' && 'opacity-70')}>
      {/* 名字 / 家族 / 状态 / 版本 */}
      <div className="flex min-w-0 items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold">{s.name}</div>
          <div className="num truncate text-[10px] text-muted-foreground">{s.id}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', statusBadgeClass(s.status))}>
            {s.status_label || FALLBACK_STATUS_LABEL[s.status]}
          </Badge>
          <span className="num text-[10px] text-muted-foreground">
            v{s.version} · {shortHash(s.content_hash)}
          </span>
        </div>
      </div>

      {/* 触发 */}
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="h-4 shrink-0 border-transparent bg-muted px-1.5 text-[10px] text-muted-foreground">
          {s.family_label}
        </Badge>
        {s.trigger.kinds.map((k) => (
          <Badge key={k} variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
            {triggerLabel(k)}
          </Badge>
        ))}
        <span className="num text-[10px] text-muted-foreground">≥{s.trigger.min_timeframe}</span>
        <span className="num text-[10px] text-muted-foreground">{t('冷却 {n} 根', { n: s.trigger.cooldown_bars })}</span>
      </div>

      {/* 入场规则前两条 */}
      <div className="flex flex-col gap-0.5">
        {entryPreview.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{t('还没写入场规则')}</span>
        ) : (
          entryPreview.map((line, i) => (
            <div key={`${i}-${line}`} className="truncate text-[11px] text-foreground/90" title={line}>
              <span className="num mr-1 text-muted-foreground">{i + 1}.</span>
              {line}
            </div>
          ))
        )}
        {s.rules.entry.length > 2 ? <span className="text-[10px] text-muted-foreground">{t('还有 {n} 条,点「查看版本」看全', { n: s.rules.entry.length - 2 })}</span> : null}
      </div>

      {/* 评测统计 */}
      <div className="grid grid-cols-5 gap-1.5 rounded-sm bg-muted/40 px-2 py-1.5">
        <Stat label={t('回测次数')} value={String(st.backtests)} />
        <Stat label={t('成交')} value={String(st.trades)} />
        <Stat label={t('胜率')} value={fmtWinRate(st.win_rate)} />
        <Stat label={t('期望 R')} value={fmtR(st.expectancy_r)} tone={st.expectancy_r === null ? undefined : st.expectancy_r >= 0 ? 'up' : 'down'} />
        <Stat label={t('MAE 中位')} value={fmtR(st.mae_r_p50)} />
      </div>
      {st.noise_note ? <div className="text-[10px] leading-relaxed text-muted-foreground">{st.noise_note}</div> : null}

      {/* 操作 */}
      <div className="flex flex-wrap items-center gap-1.5 border-t pt-1.5">
        <span
          className="flex items-center gap-1.5"
          title={liveAllowed ? undefined : t('还没到 paper,不能在实盘启用')}
        >
          <Switch
            id={`strategy-active-${s.id}`}
            size="sm"
            checked={s.active}
            disabled={!liveAllowed || busy}
            onCheckedChange={onToggleActive}
            aria-label={s.active ? t('停用') : t('启用')}
          />
          <label htmlFor={`strategy-active-${s.id}`} className="text-[11px] text-muted-foreground">
            {s.active ? t('已启用') : t('停用')}
          </label>
        </span>
        {!liveAllowed ? <span className="text-[10px] text-muted-foreground">{t('还没到 paper,不能在实盘启用')}</span> : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            onClick={onPromote}
            disabled={busy || s.promote_blocked !== null || s.next_status === null}
            title={s.promote_blocked ?? undefined}
          >
            <ArrowUpCircle data-slot="icon" />
            {t('晋升')}
          </Button>
          <Button size="xs" variant="outline" onClick={onRetire} disabled={busy || s.status === 'retired'}>
            <Trash2 data-slot="icon" />
            {t('退役')}
          </Button>
          <Button size="xs" variant="outline" onClick={onOpenDetail}>
            <History data-slot="icon" />
            {t('查看版本')}
          </Button>
        </div>
      </div>
      {s.promote_blocked ? <div className="text-[10px] leading-relaxed text-muted-foreground">{t('还不能晋升')}:{s.promote_blocked}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 详情抽屉:完整规则 / 参数 / 清单 / 版本列表 / 归因

function DetailSheet({
  id,
  open,
  onOpenChange,
  onAdopt,
  adoptingId,
}: {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopt: (point: AttributionPoint) => void;
  adoptingId: string | null;
}) {
  const detailQ = useQuery({
    queryKey: ['strategies', id],
    queryFn: () => api.strategyDetail(id!),
    enabled: open && Boolean(id),
  });

  const strategy = detailQ.data?.strategy ?? null;
  const versions = detailQ.data?.versions ?? [];
  const attributions = detailQ.data?.attributions ?? [];
  const paramRows = useMemo(() => (strategy ? Object.entries(strategy.params) : []), [strategy]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="text-[13px]">{strategy ? strategy.name : t('策略详情')}</SheetTitle>
          <SheetDescription className="num text-[11px]">
            {strategy ? `${strategy.id} · v${strategy.version} · ${shortHash(strategy.content_hash)} · ${strategy.status_label}` : t('加载中…')}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-4">
            {detailQ.isLoading ? <div className="text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
            {detailQ.isError ? (
              <div className="text-[11px] text-destructive">
                {t('加载失败')}:{detailQ.error instanceof Error ? detailQ.error.message : t('网关没给数据')}
              </div>
            ) : null}

            {strategy ? (
              <>
                {/* 规则 */}
                <section className="flex flex-col gap-2 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">{t('规则')}</div>
                  <LineList title={t('入场')} lines={strategy.rules.entry} />
                  <LineList title={t('失效条件')} lines={strategy.rules.invalidation} />
                  <LineList title={t('离场')} lines={strategy.rules.exit} />
                  {strategy.rules.sizing_note ? (
                    <div className="flex flex-col gap-0.5">
                      <div className="text-[10.5px] font-semibold text-muted-foreground select-none">{t('仓位说明')}</div>
                      <div className="text-[11px] leading-relaxed">{strategy.rules.sizing_note}</div>
                    </div>
                  ) : null}
                </section>

                {/* 参数 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">{t('参数')}</div>
                  {paramRows.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">{t('这条策略没有可调参数。')}</span>
                  ) : (
                    <div className="overflow-hidden rounded-sm border">
                      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,2fr)] gap-px bg-border">
                        {[t('参数'), t('当前值'), t('范围'), t('说明')].map((h) => (
                          <div key={h} className="bg-muted/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground select-none">
                            {h}
                          </div>
                        ))}
                        {paramRows.map(([key, p]) => (
                          <Fragment key={key}>
                            <div className="num bg-card px-2 py-1 text-[10.5px]">{key}</div>
                            <div className="num bg-card px-2 py-1 text-[10.5px] font-semibold">
                              {p.value}
                              {p.unit ? <span className="ml-0.5 font-normal text-muted-foreground">{p.unit}</span> : null}
                            </div>
                            <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">
                              [{p.min}, {p.max}]
                            </div>
                            <div className="bg-card px-2 py-1 text-[10.5px] text-muted-foreground">{p.note ?? '—'}</div>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="text-[10px] leading-relaxed text-muted-foreground">
                    {t('参数不能就地改。想落地,只能采纳一条归因生成新版本,再一格一格晋升。')}
                  </div>
                </section>

                {/* 清单 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">{t('清单')}</div>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10.5px] text-muted-foreground">{t('必备证据')}</span>
                    {strategy.checklist.required.length === 0 ? (
                      <span className="text-[10.5px] text-muted-foreground">—</span>
                    ) : (
                      strategy.checklist.required.map((r) => (
                        <Badge key={r} variant="outline" className="num h-4 px-1.5 text-[10px]">
                          {r}
                        </Badge>
                      ))
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10.5px] text-muted-foreground">{t('周期')}</span>
                    {strategy.checklist.timeframes.length === 0 ? (
                      <span className="text-[10.5px] text-muted-foreground">—</span>
                    ) : (
                      strategy.checklist.timeframes.map((tf) => (
                        <Badge key={tf} variant="outline" className="num h-4 px-1.5 text-[10px]">
                          {tf}
                        </Badge>
                      ))
                    )}
                  </div>
                </section>

                {/* 版本列表 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">
                    {t('版本')} <span className="num ml-1 text-[10.5px] font-normal text-muted-foreground">{t('{n} 个', { n: versions.length })}</span>
                  </div>
                  <div className="overflow-hidden rounded-sm border">
                    <div className="grid grid-cols-[minmax(0,0.5fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.5fr)_minmax(0,0.7fr)] gap-px bg-border">
                      {[t('版本'), t('状态'), 'hash', t('创建时间'), t('父版本')].map((h) => (
                        <div key={h} className="bg-muted/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground select-none">
                          {h}
                        </div>
                      ))}
                      {versions.map((v: StrategySpec) => (
                        <Fragment key={`${v.id}-${v.version}`}>
                          <div className="num bg-card px-2 py-1 text-[10.5px] font-semibold">v{v.version}</div>
                          <div className="bg-card px-2 py-1">
                            <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', statusBadgeClass(v.status))}>
                              {FALLBACK_STATUS_LABEL[v.status] ?? v.status}
                            </Badge>
                          </div>
                          <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">{shortHash(v.content_hash)}</div>
                          <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">{fmtDateTime(v.created_at)}</div>
                          <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">
                            {v.parent_version === null || v.parent_version === undefined ? '—' : `v${v.parent_version}`}
                          </div>
                        </Fragment>
                      ))}
                    </div>
                  </div>
                </section>

                {/* 归因 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">
                    {t('归因')} <span className="num ml-1 text-[10.5px] font-normal text-muted-foreground">{t('{n} 条', { n: attributions.length })}</span>
                  </div>
                  {attributions.length === 0 ? (
                    <span className="text-[11px] leading-relaxed text-muted-foreground">{t('还没有归因点位。跑完一次回测,去回放页点「跑归因」。')}</span>
                  ) : (
                    attributions.map((point) => (
                      <div key={point.id} className="flex flex-col gap-1 rounded-sm border px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px]', attributionKindClass(point.kind))}>
                            {ATTRIBUTION_KIND_LABEL[point.kind]}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{point.title}</span>
                          <span className="num shrink-0 text-[10px] text-muted-foreground">{fmtDateTime(point.at)}</span>
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
                            <Button size="xs" variant="outline" onClick={() => onAdopt(point)} disabled={adoptingId !== null}>
                              <Sparkles data-slot="icon" />
                              {adoptingId === point.id ? t('生成中…') : t('生成新版本')}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </section>
              </>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 页面

export function StrategiesPage() {
  const queryClient = useQueryClient();
  const [includeRetired, setIncludeRetired] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<StrategyView | null>(null);
  const [retireTarget, setRetireTarget] = useState<StrategyView | null>(null);
  const [adoptingId, setAdoptingId] = useState<string | null>(null);

  const listQ = useQuery({ queryKey: ['strategies'], queryFn: () => api.strategies(true), staleTime: 10_000 });

  const all = useMemo(() => listQ.data?.strategies ?? [], [listQ.data]);
  const active = useMemo(() => listQ.data?.active ?? [], [listQ.data]);
  const shown = useMemo(() => (includeRetired ? all : all.filter((s) => s.status !== 'retired')), [all, includeRetired]);
  const retiredCount = useMemo(() => all.filter((s) => s.status === 'retired').length, [all]);

  /** 两个 key 一起失效:列表 + 已打开的详情。 */
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['strategies'] });
    await queryClient.invalidateQueries({ queryKey: ['overview'] });
  };

  const failed = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err));

  const activeMut = useMutation({
    mutationFn: (ids: string[]) => api.setActiveStrategies(ids),
    onSuccess: () => void refresh(),
    onError: failed,
  });

  const promoteMut = useMutation({
    mutationFn: ({ id, to, confirm }: { id: string; to: StrategyStatus; confirm: boolean }) => api.promoteStrategy(id, to, confirm),
    onSuccess: (res) => {
      toast.success(t('{name} 晋升到「{status}」了', { name: res.strategy.name, status: res.strategy.status_label }));
      setPromoteTarget(null);
      void refresh();
    },
    onError: failed,
  });

  const retireMut = useMutation({
    mutationFn: (id: string) => api.retireStrategy(id),
    onSuccess: (res) => {
      toast.success(t('{name} 已退役', { name: res.strategy.name }));
      setRetireTarget(null);
      void refresh();
    },
    onError: failed,
  });

  const adoptMut = useMutation({
    mutationFn: ({ strategyId, attributionId }: { strategyId: string; attributionId: string }) =>
      api.proposeStrategyVersion(strategyId, { attribution_id: attributionId }),
    onSuccess: (res) => {
      toast.success(t('新版本 v{n} 生成好了(草稿);要上线,还得一格一格晋升', { n: res.strategy.version }));
      void refresh();
    },
    onError: failed,
    onSettled: () => setAdoptingId(null),
  });

  const toggleActive = (s: StrategyView, next: boolean) => {
    const ids = next ? [...new Set([...active, s.id])] : active.filter((x) => x !== s.id);
    activeMut.mutate(ids);
  };

  const adopt = (point: AttributionPoint) => {
    if (!point.strategy_id) {
      toast.error(t('这条归因没指向具体策略,生成不了新版本'));
      return;
    }
    setAdoptingId(point.id);
    adoptMut.mutate({ strategyId: point.strategy_id, attributionId: point.id });
  };

  const promoteToLive = promoteTarget?.next_status === 'live_capped';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 工具条 */}
      <Workspace className="shrink-0">
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
          <span className="text-[11px] text-muted-foreground">
            {t('实盘启用')} <span className="num font-semibold text-foreground">{active.length}</span> {t('条')}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t('共')} <span className="num font-semibold text-foreground">{shown.length}</span> {t('条')}
          </span>
          <div className="flex items-center gap-1.5">
            <Switch id="strategies-retired" size="sm" checked={includeRetired} onCheckedChange={setIncludeRetired} />
            <label htmlFor="strategies-retired" className="text-[11px] text-muted-foreground">
              {t('显示已退役({n})', { n: retiredCount })}
            </label>
          </div>
          <span className="ml-auto text-[10.5px] leading-relaxed text-muted-foreground">
            {t('参数不能就地改:改一个数字 = 生成一个草稿新版本,再 draft → backtest → shadow → paper → live_capped 一格一格晋升。')}
          </span>
        </div>
      </Workspace>

      {/* 卡片列表 */}
      <Workspace className="flex min-h-0 flex-1 flex-col">
        <Pane
          title={t('策略库')}
          hint={listQ.isFetching ? t('刷新中…') : t('{n} 条', { n: shown.length })}
          contentClassName="flex min-h-0 flex-col"
        >
          {listQ.isLoading ? <div className="p-3 text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
          {listQ.isError ? (
            <div className="p-3 text-[11px] text-destructive">
              {t('策略库加载失败')}:{listQ.error instanceof Error ? listQ.error.message : t('网关没给数据')}
            </div>
          ) : null}
          {!listQ.isLoading && !listQ.isError && shown.length === 0 ? (
            <div className="p-3 text-[11px] text-muted-foreground">{t('策略库是空的。')}</div>
          ) : null}
          <ScrollArea className="min-h-0 flex-1">
            <div className="grid gap-2 p-2.5 sm:grid-cols-2 2xl:grid-cols-3">
              {shown.map((s) => (
                <StrategyCard
                  key={s.id}
                  s={s}
                  busy={activeMut.isPending || promoteMut.isPending || retireMut.isPending}
                  onToggleActive={(next) => toggleActive(s, next)}
                  onPromote={() => setPromoteTarget(s)}
                  onRetire={() => setRetireTarget(s)}
                  onOpenDetail={() => setDetailId(s.id)}
                />
              ))}
            </div>
          </ScrollArea>
        </Pane>
      </Workspace>

      <DetailSheet
        id={detailId}
        open={detailId !== null}
        onOpenChange={(open) => setDetailId(open ? detailId : null)}
        onAdopt={adopt}
        adoptingId={adoptingId}
      />

      {/* 晋升确认;到 live_capped 是真钱,必须原样输入 LIVE */}
      <ConfirmDialog
        open={promoteTarget !== null}
        title={promoteTarget ? t('晋升「{name}」', { name: promoteTarget.name }) : t('晋升')}
        summary={t('确认晋升')}
        danger={promoteToLive}
        {...(promoteToLive ? { requireText: 'LIVE' } : {})}
        busy={promoteMut.isPending}
        onCancel={() => setPromoteTarget(null)}
        onConfirm={() => {
          if (!promoteTarget?.next_status) return;
          promoteMut.mutate({ id: promoteTarget.id, to: promoteTarget.next_status, confirm: promoteToLive });
        }}
      >
        <p className="leading-relaxed">
          {promoteTarget
            ? t('把 {name}(v{version})从「{from}」晋升到「{to}」。', {
                name: promoteTarget.name,
                version: promoteTarget.version,
                from: promoteTarget.status_label,
                to: promoteTarget.next_status ? FALLBACK_STATUS_LABEL[promoteTarget.next_status] : '—',
              })
            : ''}
        </p>
        {promoteToLive ? (
          <p className="leading-relaxed text-destructive">{t('限额实盘会用真钱下单。这条策略的纸面成绩,够了吗?')}</p>
        ) : null}
      </ConfirmDialog>

      {/* 退役确认 */}
      <ConfirmDialog
        open={retireTarget !== null}
        title={retireTarget ? t('退役「{name}」', { name: retireTarget.name }) : t('退役')}
        summary={t('确认退役')}
        danger
        busy={retireMut.isPending}
        onCancel={() => setRetireTarget(null)}
        onConfirm={() => {
          if (!retireTarget) return;
          retireMut.mutate(retireTarget.id);
        }}
      >
        <p className="leading-relaxed">
          {t('退役之后这条策略会从实盘启用列表里摘掉,而且晋升不回来了。历史版本和回测记录都还在。')}
        </p>
      </ConfirmDialog>
    </div>
  );
}
