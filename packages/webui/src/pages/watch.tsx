// 盯盘参数独立页(这块太重要,不该只躲在 Agent 页的抽屉里;抽屉入口保留,两处编辑同一份 workflow)。
// 上半是名单板(本页自己画,宽屏铺开:概览条 / 搜索排序筛选 / 批量操作 / 逐行 判断·Radar·持仓),
// 下半是 WorkflowForm 的 pace 组去掉名单(周期 / 扫描方式 / 心跳 / 急拉阈值 / 收盘复查 / 信息员频率)。
// 风险、额度、自动化、大脑仍在「设置 › 工作流」;新币候选在「筛选」。
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Search, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Action, Workflow } from '@/api/types';
import { Pane, Workspace } from '@/components/pane';
import { WorkflowForm } from '@/components/workflow-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtPrice, relativeTime, useNow } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type SortKey = 'name' | 'judged' | 'fit';
type Filter = 'all' | 'trade' | 'watch' | 'position' | 'radar' | 'proposed';

const ACTION_STYLE: Record<string, string> = {
  PROPOSE: 'border-up/40 bg-up/15 text-up',
  ADD: 'border-up/40 bg-up/10 text-up',
  WATCH: 'border-warn/40 bg-warn/10 text-warn',
  HOLD: 'border-primary/40 bg-primary/10 text-primary',
  REDUCE: 'border-warn/40 bg-warn/10 text-warn',
  EXIT: 'border-down/40 bg-down/10 text-down',
  INVALIDATE: 'border-down/40 bg-down/10 text-down',
  NO_TRADE: 'border-border bg-muted/40 text-muted-foreground',
};

function actionBadge(action: Action | null | undefined) {
  if (!action) return <span className="text-muted-foreground">—</span>;
  return <Badge variant="outline" className={cn('h-4.5 px-1.5 text-[10px]', ACTION_STYLE[action] ?? ACTION_STYLE['NO_TRADE'])}>{action}</Badge>;
}

interface Row {
  sym: string;
  trade: boolean;
  last: { at: number; action: Action | null; headline: string | null; confidence: number | null } | null;
  radar: { strategy: string; fit: number; rank: number } | null;
  price: string | null;
  position: 'in_position' | 'pending_entry' | 'orphan' | null;
  fromRadar: boolean;
}

function WatchBoard() {
  const queryClient = useQueryClient();
  const now = useNow(15_000);
  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const symbolsQ = useQuery({ queryKey: ['symbols'], queryFn: api.symbols, staleTime: 5 * 60_000 });
  const episodesQ = useQuery({ queryKey: ['episodes'], queryFn: () => api.episodes({ limit: 200 }), staleTime: 30_000 });
  const screenQ = useQuery({ queryKey: ['screener', 'latest', 'short'], queryFn: () => api.screenerLatest('short'), retry: false, staleTime: 60_000 });

  // ---- 草稿:只管 watchlist / watch_only / watchlist_max 三个字段;服务端变了且本地干净就跟着换
  const server = workflowQ.data ?? null;
  const [draft, setDraft] = useState<{ watchlist: string[]; watch_only: string[]; watchlist_max: number } | null>(null);
  const [baseKey, setBaseKey] = useState<string>('');
  const serverKey = server ? JSON.stringify([server.watchlist, server.watch_only ?? [], server.watchlist_max]) : '';
  const dirty = draft !== null && JSON.stringify([draft.watchlist, draft.watch_only, draft.watchlist_max]) !== baseKey;
  useEffect(() => {
    if (!server) return;
    if (draft === null || !dirty) {
      setDraft({ watchlist: [...server.watchlist], watch_only: [...(server.watch_only ?? [])], watchlist_max: server.watchlist_max ?? 60 });
      setBaseKey(serverKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const save = useMutation({
    mutationFn: (p: Partial<Workflow>) => api.patchWorkflow(p),
    onSuccess: (res) => {
      if (res.errors?.length) {
        toast.error(t('部分没保存'), { description: res.errors.join('；') });
        return;
      }
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      setBaseKey(JSON.stringify([res.workflow.watchlist, res.workflow.watch_only ?? [], res.workflow.watchlist_max]));
      setDraft({ watchlist: [...res.workflow.watchlist], watch_only: [...(res.workflow.watch_only ?? [])], watchlist_max: res.workflow.watchlist_max ?? 60 });
      toast.success(t('名单已保存,下一轮生效'));
    },
    onError: (err) => toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  // ---- 派生数据
  const lastByAgent = useMemo(() => {
    const m = new Map<string, Row['last']>();
    for (const e of episodesQ.data ?? []) if (!m.has(e.symbol)) m.set(e.symbol, { at: e.at, action: e.action, headline: e.headline, confidence: e.confidence });
    return m;
  }, [episodesQ.data]);
  const radarBest = useMemo(() => {
    const m = new Map<string, Row['radar']>();
    for (const c of screenQ.data?.candidates ?? []) {
      if (m.has(c.symbol)) continue;
      const st = c.card.strategies.find((f) => f.strategy_id === c.strategy_id);
      m.set(c.symbol, { strategy: st?.name ?? c.strategy_id, fit: c.fit_score, rank: c.rank });
    }
    return m;
  }, [screenQ.data]);
  const radarProposed = useMemo(() => new Set(screenQ.data?.screen?.proposal?.symbols ?? []), [screenQ.data]);
  const positions = useMemo(() => {
    const m = new Map<string, Row['position']>();
    for (const th of overviewQ.data?.threads ?? []) if (th.status === 'in_position' || th.status === 'pending_entry') m.set(th.symbol, th.status);
    for (const p of overviewQ.data?.account?.positions ?? []) if (!m.has(p.symbol)) m.set(p.symbol, 'orphan');
    return m;
  }, [overviewQ.data]);
  const rows: Row[] = useMemo(() => {
    if (!draft) return [];
    const watchOnly = new Set(draft.watch_only);
    return draft.watchlist.map((sym) => ({
      sym,
      trade: !watchOnly.has(sym),
      last: lastByAgent.get(sym) ?? null,
      radar: radarBest.get(sym) ?? null,
      price: overviewQ.data?.markets?.[sym]?.last ?? null,
      position: positions.get(sym) ?? null,
      fromRadar: radarProposed.has(sym),
    }));
  }, [draft, lastByAgent, radarBest, overviewQ.data, positions, radarProposed]);

  // ---- 视图状态
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('judged');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [addText, setAddText] = useState('');
  const known = useMemo(() => new Set((symbolsQ.data?.symbols ?? []).map((s) => s.symbol)), [symbolsQ.data]);

  const visible = useMemo(() => {
    const qq = q.trim().toUpperCase();
    let list = rows.filter((r) => !qq || r.sym.includes(qq));
    if (filter === 'trade') list = list.filter((r) => r.trade);
    else if (filter === 'watch') list = list.filter((r) => !r.trade);
    else if (filter === 'position') list = list.filter((r) => r.position);
    else if (filter === 'radar') list = list.filter((r) => r.radar);
    else if (filter === 'proposed') list = list.filter((r) => r.fromRadar);
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      name: (a, b) => a.sym.localeCompare(b.sym),
      judged: (a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0),
      fit: (a, b) => (b.radar?.fit ?? -1) - (a.radar?.fit ?? -1),
    };
    return [...list].sort(by[sort]);
  }, [rows, q, filter, sort]);

  const counts = useMemo(() => {
    const c = { trade: 0, watch: 0, position: 0, radar: 0, actions: {} as Record<string, number> };
    for (const r of rows) {
      if (r.trade) c.trade++;
      else c.watch++;
      if (r.position) c.position++;
      if (r.radar) c.radar++;
      const a = r.last?.action ?? '—';
      c.actions[a] = (c.actions[a] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  // ---- 编辑动作(都只改草稿)
  const setTrade = (syms: string[], trade: boolean) =>
    setDraft((d) => (d ? { ...d, watch_only: trade ? d.watch_only.filter((s) => !syms.includes(s)) : [...new Set([...d.watch_only, ...syms])] } : d));
  const remove = (syms: string[]) => {
    setDraft((d) => (d ? { ...d, watchlist: d.watchlist.filter((s) => !syms.includes(s)), watch_only: d.watch_only.filter((s) => !syms.includes(s)) } : d));
    setSelected((s) => {
      const n = new Set(s);
      for (const x of syms) n.delete(x);
      return n;
    });
  };
  const add = () => {
    const syms = addText
      .split(/[,\s]+/)
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
      .map((x) => (x.endsWith('USDT') ? x : `${x}USDT`));
    if (!syms.length || !draft) return;
    const bad = syms.filter((x) => symbolsQ.data && !known.has(x));
    if (bad.length) {
      toast.error(t('不认识这些币'), { description: bad.join('、') });
      return;
    }
    const fresh = [...new Set(syms)].filter((x) => !draft.watchlist.includes(x));
    if (!fresh.length) {
      toast.info(t('都已经在名单里了'));
      setAddText('');
      return;
    }
    if (draft.watchlist.length + fresh.length > draft.watchlist_max) {
      toast.error(t('超过名单上限 {n}', { n: draft.watchlist_max }), { description: t('把上限调高,或先移掉几个') });
      return;
    }
    setDraft((d) => (d ? { ...d, watchlist: [...d.watchlist, ...fresh] } : d));
    setAddText('');
  };
  const discard = () => {
    if (!server) return;
    setDraft({ watchlist: [...server.watchlist], watch_only: [...(server.watch_only ?? [])], watchlist_max: server.watchlist_max ?? 60 });
    setSelected(new Set());
  };
  const commit = () => {
    if (!draft) return;
    if (draft.watchlist.length === 0) {
      toast.error(t('名单不能为空'));
      return;
    }
    save.mutate({ watchlist: draft.watchlist, watch_only: draft.watch_only, watchlist_max: draft.watchlist_max });
  };

  const selVisible = visible.filter((r) => selected.has(r.sym)).map((r) => r.sym);
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.sym));

  if (!draft) return <div className="p-4 text-[12px] text-muted-foreground">{workflowQ.isError ? t('工作流读取失败') : t('加载中…')}</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 概览条 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2 text-[11.5px]">
        <span className="num">
          {t('名单')} <b className="text-foreground">{draft.watchlist.length}</b>/{draft.watchlist_max}
        </span>
        <span className="num text-muted-foreground">
          {t('可交易')} <b className="text-foreground">{counts.trade}</b> · {t('只观察')} <b className="text-foreground">{counts.watch}</b>
        </span>
        <span className="num text-muted-foreground">
          {t('持仓中')} <b className="text-foreground">{counts.position}</b> · {t('Radar 候选')} <b className="text-foreground">{counts.radar}</b>
        </span>
        <span className="num flex items-center gap-1 text-muted-foreground">
          {t('最近判断')}
          {(['PROPOSE', 'WATCH', 'HOLD', 'NO_TRADE'] as const).map((a) => (
            <Badge key={a} variant="outline" className={cn('h-4 px-1 text-[9.5px]', ACTION_STYLE[a])}>
              {a} {counts.actions[a] ?? 0}
            </Badge>
          ))}
        </span>
        <label className="num ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground" title={t('每多一个币 = 多一份心跳/收盘判断的模型费')}>
          {t('上限')}
          <Input
            type="number"
            min={1}
            max={300}
            className="num h-6 w-16 text-[11px]"
            value={draft.watchlist_max}
            onChange={(e) => setDraft((d) => (d ? { ...d, watchlist_max: Math.min(300, Math.max(1, Number(e.target.value) || 1)) } : d))}
          />
        </label>
      </div>

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('过滤')} className="h-6 w-36 pl-6 text-[11px]" />
        </div>
        <div className="flex items-center gap-1">
          {(
            [
              ['all', t('全部')],
              ['trade', t('可交易')],
              ['watch', t('只观察')],
              ['position', t('持仓中')],
              ['radar', t('Radar 候选')],
              ['proposed', t('Radar 提案')],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={cn('rounded-full border px-2 py-0.5 text-[10.5px] transition-colors', filter === k ? 'border-primary/50 bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger size="sm" className="h-6 w-32 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="judged">{t('按最近判断')}</SelectItem>
            <SelectItem value="fit">{t('按 Radar 契合')}</SelectItem>
            <SelectItem value="name">{t('按名称')}</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-muted-foreground">
          {t('显示')} {visible.length}/{rows.length}
        </span>
        {selVisible.length ? (
          <div className="ml-auto flex items-center gap-1">
            <span className="num text-muted-foreground">
              {t('选中')} {selVisible.length}
            </span>
            <Button size="xs" variant="outline" onClick={() => setTrade(selVisible, true)}>
              {t('设为可交易')}
            </Button>
            <Button size="xs" variant="outline" onClick={() => setTrade(selVisible, false)}>
              {t('设为只观察')}
            </Button>
            <Button size="xs" variant="outline" className="border-down/40 text-down hover:bg-down/10 hover:text-down" onClick={() => remove(selVisible)}>
              {t('移除')}
            </Button>
          </div>
        ) : null}
      </div>

      {/* 表 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-[11.5px]">
          <thead className="sticky top-0 z-1 bg-muted/60 text-[10px] text-muted-foreground">
            <tr className="border-b">
              <th className="w-7 px-2 py-1">
                <input type="checkbox" className="size-3.5 accent-primary" checked={allVisibleSelected} onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((r) => r.sym)) : new Set())} />
              </th>
              <th className="px-2 py-1 font-medium">{t('币')}</th>
              <th className="px-2 py-1 font-medium">{t('现价')}</th>
              <th className="px-2 py-1 font-medium">{t('可交易')}</th>
              <th className="px-2 py-1 font-medium">{t('最近判断')}</th>
              <th className="px-2 py-1 font-medium" title={t('最近一次短线筛选给的最佳策略 / 契合度,和筛选页同一份')}>
                {t('Radar 策略 / 契合')}
              </th>
              <th className="px-2 py-1 font-medium">{t('来源')}</th>
              <th className="w-8 px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-muted-foreground">
                  {rows.length === 0 ? t('名单是空的,下面加几个币,或去「筛选」让 Radar 提案') : t('没有匹配的币')}
                </td>
              </tr>
            ) : (
              visible.map((r, i) => (
                <tr key={r.sym} className={cn('border-b hover:bg-muted/40', i % 2 ? 'bg-muted/15' : '', selected.has(r.sym) && 'bg-primary/5')}>
                  <td className="px-2 py-1">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={selected.has(r.sym)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(r.sym);
                          else n.delete(r.sym);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <a href={`#trade?symbol=${r.sym}`} className="num font-semibold hover:underline">
                        {r.sym}
                      </a>
                      {r.position ? (
                        <Badge variant="outline" className={cn('h-4 px-1 text-[9.5px]', r.position === 'orphan' ? 'border-warn/40 text-warn' : 'border-up/40 text-up')} title={r.position === 'orphan' ? t('交易所上有仓但没有线程(去交易页「交给 agent」)') : r.position === 'pending_entry' ? t('待入场') : t('持仓中,agent 在管')}>
                          {r.position === 'orphan' ? t('无主仓') : r.position === 'pending_entry' ? t('待入场') : t('持仓')}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="num px-2 py-1 text-muted-foreground">{r.price ? fmtPrice(r.price) : '—'}</td>
                  <td className="px-2 py-1">
                    <label className="flex items-center gap-1.5" title={r.trade ? t('可交易:判断能出 PROPOSE') : t('只观察:判断只能出 NO_TRADE / WATCH')}>
                      <Switch checked={r.trade} onCheckedChange={(v) => setTrade([r.sym], v)} className="scale-75" />
                      <span className={cn('text-[10.5px]', r.trade ? 'text-foreground' : 'text-muted-foreground')}>{r.trade ? t('可交易') : t('只观察')}</span>
                    </label>
                  </td>
                  <td className="px-2 py-1">
                    {r.last ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-1.5">
                            {actionBadge(r.last.action)}
                            <span className="num text-[10.5px] text-muted-foreground">{relativeTime(r.last.at, now)}</span>
                            {r.last.confidence !== null ? <span className="num text-[10px] text-muted-foreground/70">{Math.round(r.last.confidence * 100)}%</span> : null}
                            {r.last.headline ? <span className="max-w-64 truncate text-[10.5px] text-muted-foreground">{r.last.headline}</span> : null}
                          </div>
                        </TooltipTrigger>
                        {r.last.headline ? <TooltipContent className="max-w-80 text-[11px]">{r.last.headline}</TooltipContent> : null}
                      </Tooltip>
                    ) : (
                      <span className="text-muted-foreground">{t('还没判断过')}</span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    {r.radar ? (
                      <a href="#screener" className="flex items-center gap-1.5 hover:underline" title={t('筛选排名 #{rank}', { rank: r.radar.rank })}>
                        <span className="text-[10.5px] text-muted-foreground">{r.radar.strategy}</span>
                        <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                          <span className={cn('absolute inset-y-0 left-0 rounded-full', r.radar.fit >= 0.85 ? 'bg-up' : r.radar.fit >= 0.6 ? 'bg-warn' : 'bg-muted-foreground/50')} style={{ width: `${Math.round(Math.max(0, Math.min(1, r.radar.fit)) * 100)}%` }} />
                        </span>
                        <span className="num text-[11px]">{r.radar.fit.toFixed(2)}</span>
                      </a>
                    ) : (
                      <span className="text-[10.5px] text-muted-foreground" title={t('最近一次筛选没把它列进候选(没算,或者没过门槛)')}>
                        {t('没进候选')}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-[10.5px] text-muted-foreground">{r.fromRadar ? t('Radar 提案') : t('手动')}</td>
                  <td className="px-2 py-1 text-right">
                    <button type="button" onClick={() => remove([r.sym])} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t('移除 {symbol}', { symbol: r.sym })}>
                      <X className="size-3" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 底栏:添加 + 保存 */}
      <div className={cn('flex flex-wrap items-center gap-2 border-t px-3 py-2 text-[11.5px]', dirty && 'bg-primary/5')}>
        <Input
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={t('加币:BTC 或 btc,eth,sol(可多个,自动补 USDT)')}
          className="num h-7 w-80 text-[12px]"
          autoComplete="off"
          spellCheck={false}
        />
        <Button size="sm" variant="outline" onClick={add} disabled={!addText.trim()}>
          <Plus data-slot="icon" />
          {t('添加')}
        </Button>
        <a href="#screener" className="text-[10.5px] text-muted-foreground hover:underline">
          {t('让 Radar 提案 →')}
        </a>
        <div className="ml-auto flex items-center gap-2">
          {dirty ? <span className="text-[11px] text-warn">{t('有未保存的改动')}</span> : <span className="text-[11px] text-muted-foreground">{t('改完点保存,下一轮生效')}</span>}
          <Button size="sm" variant="outline" disabled={!dirty || save.isPending} onClick={discard}>
            <Undo2 data-slot="icon" />
            {t('放弃')}
          </Button>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={commit}>
            <Save data-slot="icon" />
            {save.isPending ? t('保存中…') : t('保存')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function WatchPage() {
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3">
      <Workspace className="flex min-h-0 flex-col">
        <Pane title={t('名单')} hint={t('agent 能看、能交易的币就是这一份。风险、额度、自动化、大脑在「设置 › 工作流」;新币候选在「筛选」')} className="min-h-0 flex-1" contentClassName="min-h-0">
          <WatchBoard />
        </Pane>
      </Workspace>
      <Workspace className="max-h-[45vh] overflow-y-auto">
        <Pane title={t('节奏')} hint={t('模型多久看一次盘、什么时候才值得叫模型;改完点下面的保存')}>
          <div className="mx-auto w-full max-w-5xl">
            <WorkflowForm groups={['pace']} hideWatchlist />
          </div>
        </Pane>
      </Workspace>
    </div>
  );
}
