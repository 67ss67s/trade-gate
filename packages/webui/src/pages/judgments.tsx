/**
 * 判断记录页:v1(README.md §2)时间线的移植 + v2(v2-agent-loop.md §7)增量——按 symbol 过滤、
 * 每张卡带「查看线程」跳转。旧版 EpisodeCard/Timeline(见 git history)是纯 CSS 实现,这里用
 * Pane + Badge + Tailwind 重做,交互模型不变:折叠态先看摘要,点开才懒加载 GET /api/episodes/:id。
 *
 * react-query key 约定见 src/App.tsx 顶部注释:这里只用 ['episodes'] / ['episode', id]——
 * App.tsx 的单条 SSE 连接会在 episode.finished 时把新摘要 prepend 进 ['episodes'] 缓存,本页
 * 不用自己再开一条 /api/events 连接。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleQuestionMark, ExternalLink } from 'lucide-react';
import { api } from '@/api/client';
import type { Episode, EpisodeSummary, JudgmentGraph } from '@/api/types';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { askAgent, whyQuestion } from '@/lib/ask-agent';
import {
  ACTION_LABEL,
  INTENT_KIND_LABEL,
  INTENT_STATUS_LABEL,
  STATE_LABEL,
  triggerLabel,
  actionBadgeClass,
  actionLabel,
  directionLabel,
  directionText,
  fmtClock,
  fmtPrice,
  fmtQty,
  relativeTime,
  useNow,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

function distinctSymbols(episodes: EpisodeSummary[]): string[] {
  const set = new Set<string>();
  for (const e of episodes) if (e.symbol) set.add(e.symbol);
  return Array.from(set).sort();
}

function goToTradePage() {
  window.location.hash = 'trade';
}

/** episode.graph.edge(边 id,如 "scan.PROPOSE")在判断图里对应的边定义,取不到就是 null。 */
function resolveEdge(graph: JudgmentGraph | null | undefined, edgeId: string | null) {
  if (!graph || !edgeId) return null;
  return graph.model_edges.find((e) => e.id === edgeId) ?? null;
}

/** 把一组闸 id 翻译成中文闸名(/api/graph 的 guards[id].gate_name),查不到就原样返回 id。 */
function guardNames(graph: JudgmentGraph | null | undefined, guardIds: string[]): string[] {
  if (!graph) return guardIds;
  return guardIds.map((id) => graph.guards[id]?.gate_name ?? id);
}

/** 卡片头部的判断图小徽章:节点 → 动作;越权(edge=null 但 illegal_action 非空)则红色提示。 */
function GraphBadge({ graph, episodeGraph }: { graph: JudgmentGraph | null | undefined; episodeGraph: NonNullable<Episode['graph']> }) {
  const edge = resolveEdge(graph, episodeGraph.edge);
  if (!episodeGraph.edge && episodeGraph.illegal_action) {
    return (
      <Badge variant="destructive" className="text-[10.5px]" title={t('节点 {node} 不允许 {action}', { node: episodeGraph.node, action: episodeGraph.illegal_action })}>
        {t('越权动作')} {ACTION_LABEL[episodeGraph.illegal_action as keyof typeof ACTION_LABEL] ?? episodeGraph.illegal_action}
      </Badge>
    );
  }
  const actionText = edge ? (ACTION_LABEL[edge.action] ?? edge.action) : (episodeGraph.edge ?? '—');
  return (
    <Badge variant="outline" className="num text-[10.5px]" title={edge?.description}>
      {episodeGraph.node} → {actionText}
    </Badge>
  );
}

/**
 * 展开态的闸列表。优先用 episode 自己 graph.guards(非空 = 真评估过,PROPOSE 会填满,
 * 复查只有 thread_still_open),按 gate_name 去 episode.gates 里找对应的通过/拒绝结果;
 * graph.guards 为空(NO_TRADE/WATCH 没有走到过闸这步)时退回该边在判断图里声明的闸列表,
 * 标注"本次未评估"。
 */
function GuardsList({
  graph,
  episodeGraph,
  gates,
}: {
  graph: JudgmentGraph | null | undefined;
  episodeGraph: NonNullable<Episode['graph']>;
  gates: Episode['gates'];
}) {
  const evaluated = episodeGraph.guards.length > 0;
  const guardIds = evaluated ? episodeGraph.guards : (resolveEdge(graph, episodeGraph.edge)?.guards ?? []);
  if (guardIds.length === 0) return null;

  return (
    <div className="mb-1.5 flex flex-col gap-1">
      <div className="text-[10.5px] text-muted-foreground">{evaluated ? t('闸') : t('这条边声明的闸(这次没评估)')}</div>
      <ul className="flex flex-wrap gap-1">
        {guardIds.map((id, i) => {
          const gateName = graph?.guards[id]?.gate_name ?? id;
          if (!evaluated) {
            return (
              <li key={`${id}-${i}`}>
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {gateName}
                </Badge>
              </li>
            );
          }
          const matches = gates.filter((g) => g.name === gateName);
          const passed = matches.length > 0 ? matches.every((m) => m.passed) : null;
          const reason = matches.map((m) => m.reason).filter(Boolean).join('; ');
          return (
            <li key={`${id}-${i}`}>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px]',
                  passed === true && 'border-up/30 text-up',
                  passed === false && 'border-destructive/30 text-destructive',
                )}
                title={reason || undefined}
              >
                {passed === true ? '✓' : passed === false ? '✗' : '?'} {gateName}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 顶部可折叠的「判断图」区块:节点表 + 边表,纯表格渲染,不引入 mermaid。 */
function GraphOverview({ graph }: { graph: JudgmentGraph }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('节点')}</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-7 text-[11px]">{t('节点')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('允许动作')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('说明')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(graph.nodes).map(([id, n]) => (
              <TableRow key={id}>
                <TableCell className="num py-1.5 text-[11.5px] font-medium">{id}</TableCell>
                <TableCell className="py-1.5 text-[11.5px] text-muted-foreground">
                  {n.allowed_actions.map((a) => ACTION_LABEL[a] ?? a).join('、') || '—'}
                </TableCell>
                <TableCell className="py-1.5 text-[11.5px] text-muted-foreground">{n.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('边(模型动作)')}</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-7 text-[11px]">{t('从')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('动作')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('效果')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('闸数')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('说明')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {graph.model_edges.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="num py-1.5 text-[11.5px]">{e.from}</TableCell>
                <TableCell className="py-1.5 text-[11.5px] font-medium">{ACTION_LABEL[e.action] ?? e.action}</TableCell>
                <TableCell className="num py-1.5 text-[11.5px] text-muted-foreground">{e.effect}</TableCell>
                <TableCell className="num py-1.5 text-[11.5px] text-muted-foreground" title={guardNames(graph, e.guards).join('、')}>
                  {e.guards.length}
                </TableCell>
                <TableCell className="py-1.5 text-[11.5px] text-muted-foreground">{e.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

type Section = 'evidence' | 'context' | 'raw';

function EvidenceList({ episode, now }: { episode: Episode; now: number }) {
  if (episode.evidence.length === 0) {
    return <p className="px-1 py-1 text-[11px] text-muted-foreground">{t('没有登记证据')}</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {episode.evidence.map((ev) => (
        <li
          key={ev.ref}
          className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px]', ev.stale && 'opacity-60')}
        >
          <span className="font-medium text-foreground">{ev.label}</span>
          <span className="num text-muted-foreground">{ev.value}</span>
          <span className="text-[10.5px] text-muted-foreground">
            {relativeTime(ev.observed_at, now)} · {ev.source}
          </span>
          {ev.stale ? (
            <Badge variant="outline" className="border-warn/30 text-[10px] text-warn">
              {t('过期')}
            </Badge>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function EpisodeCard({ summary, now, graph }: { summary: EpisodeSummary; now: number; graph: JudgmentGraph | null | undefined }) {
  const [detail, setDetail] = useState<Episode | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [openSection, setOpenSection] = useState<Section | null>(null);

  const ensureDetail = () => {
    if (detail || detailLoading) return;
    setDetailLoading(true);
    setDetailError(null);
    api
      .episode(summary.id)
      .then(setDetail)
      .catch((err: unknown) => setDetailError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDetailLoading(false));
  };

  const toggleSection = (section: Section) => {
    setOpenSection((cur) => (cur === section ? null : section));
    ensureDetail();
  };

  const badgeLabel = summary.action ? actionLabel(summary.action, summary.direction) : t('判断失败');
  const badgeCls = summary.action ? actionBadgeClass(summary.action, summary.direction) : 'bg-muted text-muted-foreground border-transparent';
  const stateChanged = summary.from_state !== summary.to_state;
  const intent = summary.intent;
  const confidencePct = summary.confidence !== null ? Math.round(summary.confidence * 100) : null;
  // 折叠态就有 summary.graph(后端已补齐);展开后 detail.graph 是同一份数据,兜底优先用 summary。
  const episodeGraph = summary.graph ?? detail?.graph ?? null;

  return (
    <article className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="num text-[11px] text-muted-foreground">
          {fmtClock(summary.at)} <span className="text-muted-foreground/70">· {relativeTime(summary.at, now)}</span>
        </span>
        <Badge variant="outline" className="text-[11px] font-normal" title={summary.trigger.detail}>
          {triggerLabel(summary.trigger.kind)}
        </Badge>
        <Badge variant="outline" className={cn('text-[11px]', badgeCls)}>
          {badgeLabel}
        </Badge>
        <span className="text-[11px] text-muted-foreground">{summary.symbol}</span>
        {episodeGraph ? <GraphBadge graph={graph} episodeGraph={episodeGraph} /> : null}
        {confidencePct !== null ? (
          <span className="flex items-center gap-1.5" title={t('置信度 {n}%', { n: confidencePct })}>
            <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
              <span className="block h-full bg-primary" style={{ width: `${confidencePct}%` }} />
            </span>
            <span className="num text-[10.5px] text-muted-foreground">{confidencePct}%</span>
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => askAgent(whyQuestion({ symbol: summary.symbol, at: summary.at, action: summary.action ? actionLabel(summary.action, summary.direction) : null, episodeId: summary.id }))}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary hover:underline"
            title={t('跳到 Agent 页,把问题预填进对话框')}
          >
            <CircleQuestionMark className="size-3" />
            {t('问 agent 为什么')}
          </button>
          {summary.thread_id ? (
            <button type="button" onClick={goToTradePage} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
              {t('查看线程')}
              <ExternalLink className="size-3" />
            </button>
          ) : null}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 px-3 py-2 text-[13px]">
        {summary.headline ? <p className="font-medium">{summary.headline}</p> : null}
        {summary.reasons.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4 text-[12.5px] text-muted-foreground">
            {summary.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
        {stateChanged ? (
          <p className="text-[11.5px] text-muted-foreground">
            {t('策略')}:{STATE_LABEL[summary.from_state]} → {summary.to_state ? STATE_LABEL[summary.to_state] : '—'}
          </p>
        ) : null}
        {summary.reducer && !summary.reducer.accepted ? (
          <p className="text-[11.5px] text-muted-foreground">{t('这次判断没改变策略状态')}:{summary.reducer.reason}</p>
        ) : null}
        {summary.schema_errors.length > 0 ? (
          <p className="text-[11.5px] text-warn">{t('模型输出没过校验,按不交易处理了')}:{summary.schema_errors.join('; ')}</p>
        ) : null}
        {summary.error ? <p className="text-[11.5px] text-warn">{t('出错了')}:{summary.error}</p> : null}

        {intent ? (
          <div className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-muted/40 px-2 py-1.5 text-[11.5px]">
            <span className={directionText(intent.direction)}>
              {INTENT_KIND_LABEL[intent.kind]} · {directionLabel(intent.direction)}
            </span>
            <span>{t('数量')} {fmtQty(intent.quantity)}</span>
            <span>{t('入场')} {intent.entry === 'market' ? t('市价') : t('限价 {price}', { price: fmtPrice(intent.limit_price) })}</span>
            <span>{t('止损')} {fmtPrice(intent.stop_price)}</span>
            <span>{t('止盈')} {intent.take_profit_price ? fmtPrice(intent.take_profit_price) : '—'}</span>
            <Badge variant="outline" className="text-[10.5px]">
              {INTENT_STATUS_LABEL[intent.status]}
            </Badge>
            {intent.error ? <span className="text-warn">{intent.error}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1 border-t px-2 py-1.5">
        <Button variant="ghost" size="xs" onClick={() => toggleSection('evidence')} aria-expanded={openSection === 'evidence'}>
          {t('看到了什么')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => toggleSection('context')} aria-expanded={openSection === 'context'}>
          {t('模型看到的原文')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => toggleSection('raw')} aria-expanded={openSection === 'raw'}>
          {t('原始 JSON')}
        </Button>
      </div>

      {openSection ? (
        <div className="border-t px-3 py-2">
          {detailLoading ? <p className="text-[11px] text-muted-foreground">{t('加载中…')}</p> : null}
          {detailError ? <p className="text-[11px] text-warn">{t('加载失败')}:{detailError}</p> : null}
          {detail && openSection === 'evidence' ? (
            <>
              {detail.graph ? (
                <>
                  <p className="mb-1 text-[10.5px] text-muted-foreground">
                    <span className="num">
                      {t('判断图:节点')} {detail.graph.node}
                      {detail.graph.edge ? ` → ${resolveEdge(graph, detail.graph.edge)?.action ?? detail.graph.edge}` : ''}
                    </span>
                  </p>
                  <GuardsList graph={graph} episodeGraph={detail.graph} gates={detail.gates} />
                </>
              ) : null}
              <EvidenceList episode={detail} now={now} />
            </>
          ) : null}
          {detail && openSection === 'context' ? (
            <pre className="num max-h-80 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/40 p-2 text-[11px] leading-relaxed">
              {detail.context_text}
            </pre>
          ) : null}
          {detail && openSection === 'raw' ? (
            <pre className="num max-h-80 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/40 p-2 text-[11px] leading-relaxed">
              {JSON.stringify(detail.judgment, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function JudgmentsPage() {
  const episodesQ = useQuery({ queryKey: ['episodes'], queryFn: () => api.episodes({ limit: 100 }) });
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: () => api.graph(), staleTime: Infinity });
  const [symbolFilter, setSymbolFilter] = useState<string>('all');
  const [graphOpen, setGraphOpen] = useState(false);
  const now = useNow();

  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, staleTime: 5_000 });
  const episodes = episodesQ.data ?? [];
  // 可交易资产 = workflow.watchlist(唯一真源,和交易页观察列表 / 盯盘参数抽屉是同一份);历史 episode 里有、现在不在观察的币归「其它」
  const watchlist = overviewQ.data?.workflow.watchlist ?? [];
  const watchOnly = new Set(overviewQ.data?.workflow.watch_only ?? []);
  const historical = distinctSymbols(episodes).filter((s) => !watchlist.includes(s));
  const visible = symbolFilter === 'all' ? episodes : episodes.filter((e) => e.symbol === symbolFilter);
  const graph = graphQ.data?.graph ?? null;

  return (
    <Workspace className="flex h-full min-h-0 flex-col">
      <Pane title={t('判断记录')} hint={episodesQ.isLoading ? undefined : t('共 {n} 条', { n: visible.length })} contentClassName="flex min-h-0 flex-col">
        <div className="shrink-0 border-b">
          <button
            type="button"
            onClick={() => setGraphOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
            aria-expanded={graphOpen}
          >
            {graphOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t('判断图')}{graph ? <span className="text-[10.5px] text-muted-foreground/70">· {graph.version}</span> : null}
          </button>
          {graphOpen ? (
            graph ? (
              <div className="max-h-72 overflow-auto border-t">
                <GraphOverview graph={graph} />
              </div>
            ) : (
              <p className="px-3 pb-2 text-[11px] text-muted-foreground">
                {graphQ.isLoading ? t('加载中…') : graphQ.isError ? t('加载失败') : t('没有数据')}
              </p>
            )
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
          <span className="mr-1 text-[11px] text-muted-foreground">{t('币种')}</span>
          <Button type="button" variant={symbolFilter === 'all' ? 'default' : 'outline'} size="xs" className="rounded-full" onClick={() => setSymbolFilter('all')}>
            {t('全部')}
          </Button>
          {watchlist.map((sym) => (
            <Button key={sym} type="button" variant={symbolFilter === sym ? 'default' : 'outline'} size="xs" className="num rounded-full" onClick={() => setSymbolFilter(sym)} title={watchOnly.has(sym) ? t('只观察不交易:判断只能出 NO_TRADE / WATCH') : t('可交易')}>
              {sym}
              {watchOnly.has(sym) ? <span className="ml-1 text-[9px] text-muted-foreground">{t('观')}</span> : null}
            </Button>
          ))}
          <a href="#agent" className="text-[10.5px] text-muted-foreground hover:text-foreground hover:underline" title={t('观察列表就是 agent 能交易的币,在「盯盘参数」页里改')}>
            {t('改观察列表 →')}
          </a>
          {historical.length ? (
            <>
              <span className="ml-2 text-[11px] text-muted-foreground/70">{t('其它(历史)')}</span>
              {historical.map((sym) => (
                <Button key={sym} type="button" variant={symbolFilter === sym ? 'secondary' : 'ghost'} size="xs" className="num rounded-full text-muted-foreground" onClick={() => setSymbolFilter(sym)}>
                  {sym}
                </Button>
              ))}
            </>
          ) : null}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-3">
            {episodesQ.isLoading ? (
              <>
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-28 w-full" />
              </>
            ) : null}
            {episodesQ.isError ? (
              <p className="py-6 text-center text-[12px] text-destructive">
                {t('加载失败')}:{episodesQ.error instanceof Error ? episodesQ.error.message : String(episodesQ.error)}
              </p>
            ) : null}
            {!episodesQ.isLoading && !episodesQ.isError && visible.length === 0 ? (
              <p className="py-10 text-center text-[12px] text-muted-foreground">{t('还没有判断记录,等下一次触发。')}</p>
            ) : null}
            {visible.map((ep) => (
              <EpisodeCard key={ep.id} summary={ep} now={now} graph={graph} />
            ))}
          </div>
        </ScrollArea>
      </Pane>
    </Workspace>
  );
}
