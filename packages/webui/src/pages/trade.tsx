/**
 * 交易页(design notes「前端」的「交易页」):
 * 左 = 下单面板(单向账户,开多/开空 + 只减仓 = 平多/平空)
 * 中 = 策略线程列表(点一行 → 填入下单面板 + 喂图表价格线)
 * 右上 = 图表 / 线程详情 / Agent 对话 三个 tab 共享区域(图表 tab 左侧挂一条币种列表,
 *        对齐 参考控制台:持仓/挂单 → 观察列表 → 全部合约,可折叠)
 * 底 = 持仓 / 挂单 两个 tab
 *
 * 严格按 App.tsx 顶部注释的 react-query key 约定发 useQuery,不自己开 SSE 连接——
 * App.tsx 的单一 SSE 连接会失效 / 更新这些 key,页面自动跟着活。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Direction, ManualOrderRequest, MarketView, Overview, OpenOrderView, PositionView, StrategyThread, SymbolInfo } from '@/api/types';
import { Workspace, Pane } from '@/components/pane';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TradeChart } from '@/components/trade-chart';
import { ChartSymbolList } from '@/components/chart-symbol-list';
import { ChatPanel } from '@/components/chat-panel';
import { SymbolPicker } from '@/components/symbol-picker';
import { ChevronDown, ChevronLeft, ChevronRight, CircleQuestionMark } from 'lucide-react';
import { askAgent, whyQuestion } from '@/lib/ask-agent';
import { Button } from '@/components/ui/button';
import { openExecutionSetup } from '@/components/execution-panel';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import {
  DAILY_REGIME_LABEL,
  SESSION_LABEL,
  THREAD_SOURCE_LABEL,
  THREAD_STATUS_LABEL,
  dailyRegimeClass,
  directionLabel,
  directionText,
  fmtPrice,
  fmtQty,
  fmtSigned,
  pnlText,
  relativeTime,
  threadStatusBadgeClass,
  backendLabel,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { quadrantOf, quadrantSpec } from '@/domain/hedgeOrderIntent';

// ---------------------------------------------------------------------------
// 小工具

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "0.001" → 3;"1" / "1.0" → 0。用来把杠杆×保证金算出来的数量向下取整到交易所允许的步长。 */
function decimalsOf(stepSize: string | undefined | null): number {
  if (!stepSize) return 0;
  const s = stepSize.trim();
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  const frac = s.slice(dot + 1).replace(/0+$/, '');
  return frac.length;
}

function floorToDecimals(qty: number, decimals: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const factor = 10 ** Math.max(0, decimals);
  return Math.floor(qty * factor + 1e-9) / factor;
}

function marketForSymbol(overview: Overview | undefined, symbol: string): MarketView | undefined {
  if (!overview || !symbol) return undefined;
  if (overview.markets[symbol]) return overview.markets[symbol];
  if (overview.market.symbol === symbol) return overview.market;
  return undefined;
}

function entryText(thread: StrategyThread): string {
  if (thread.entry.zone) return `${fmtPrice(thread.entry.zone[0])} ~ ${fmtPrice(thread.entry.zone[1])}`;
  if (thread.entry.price) return fmtPrice(thread.entry.price);
  return t('市价');
}

// ---------------------------------------------------------------------------
// 左:下单面板

function OrderPanel({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  watchlist,
  threadSymbols,
  market,
  side,
  onSide,
  reduceOnly,
  onReduceOnly,
  orderType,
  onOrderType,
  price,
  onPrice,
  marginUsdt,
  onMarginUsdt,
  leverage,
  onLeverage,
  marginMode,
  onMarginMode,
  tp,
  onTp,
  sl,
  onSl,
  onSubmit,
  submitting,
}: {
  symbols: SymbolInfo[];
  selectedSymbol: string;
  onSelectSymbol: (s: string) => void;
  watchlist: string[];
  threadSymbols: string[];
  market: MarketView | undefined;
  side: Direction;
  onSide: (s: Direction) => void;
  reduceOnly: boolean;
  onReduceOnly: (v: boolean) => void;
  orderType: 'market' | 'limit';
  onOrderType: (t: 'market' | 'limit') => void;
  price: string;
  onPrice: (v: string) => void;
  marginUsdt: string;
  onMarginUsdt: (v: string) => void;
  leverage: string;
  onLeverage: (v: string) => void;
  marginMode: 'cross' | 'isolated';
  onMarginMode: (v: 'cross' | 'isolated') => void;
  tp: string;
  onTp: (v: string) => void;
  sl: string;
  onSl: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const symbolInfo = symbols.find((s) => s.symbol === selectedSymbol);
  const refPrice = market ? Number(market.last) : NaN;
  const marginNum = Number(marginUsdt);
  const leverageNum = Number(leverage);
  const notional = Number.isFinite(marginNum) && Number.isFinite(leverageNum) ? marginNum * leverageNum : 0;
  const stepDecimals = decimalsOf(symbolInfo?.step_size);
  const rawQty = Number.isFinite(refPrice) && refPrice > 0 ? notional / refPrice : 0;
  const qty = floorToDecimals(rawQty, stepDecimals);
  const liqPrice =
    Number.isFinite(refPrice) && refPrice > 0 && leverageNum > 0
      ? side === 'long'
        ? refPrice * (1 - (1 / leverageNum) * 0.9)
        : refPrice * (1 + (1 / leverageNum) * 0.9)
      : null;

  const quadrant = quadrantSpec(quadrantOf(side, reduceOnly));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-[12.5px]">
      <div className="flex flex-col gap-1">
        <Label htmlFor="trade-symbol">
          {t('币种')}
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">{t('{n} 个 USDT 永续都能交易', { n: symbols.length })}</span>
        </Label>
        <div className="flex items-center gap-2">
          <SymbolPicker symbols={symbols} value={selectedSymbol} onChange={onSelectSymbol} watchlist={watchlist} threadSymbols={threadSymbols} className="min-w-0 flex-1" />
          <span className="num shrink-0 text-[12.5px] font-semibold">{market ? fmtPrice(market.last) : '—'}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant={side === 'long' ? 'default' : 'outline'}
            className={cn(side === 'long' && 'bg-up text-white hover:bg-up/85')}
            onClick={() => onSide('long')}
          >
            {reduceOnly ? t('平多') : t('开多')}
          </Button>
          <Button
            type="button"
            variant={side === 'short' ? 'default' : 'outline'}
            className={cn(side === 'short' && 'bg-down text-white hover:bg-down/85')}
            onClick={() => onSide('short')}
          >
            {reduceOnly ? t('平空') : t('开空')}
          </Button>
        </div>
        <div className="flex items-center justify-between">
          <span className="num text-[10.5px] text-muted-foreground">{quadrant.hint}</span>
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground select-none">
            {t('只减仓')}
            <Switch checked={reduceOnly} onCheckedChange={onReduceOnly} />
          </label>
        </div>
      </div>

      <Tabs value={orderType} onValueChange={(v) => onOrderType(v as 'market' | 'limit')}>
        <TabsList className="w-full">
          <TabsTrigger value="market" className="flex-1">
            {t('市价')}
          </TabsTrigger>
          <TabsTrigger value="limit" className="flex-1">
            {t('限价')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {orderType === 'limit' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-price">{t('价格')}</Label>
          <Input id="trade-price" className="num" inputMode="decimal" value={price} onChange={(e) => onPrice(e.target.value)} placeholder={t('限价价格')} />
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-margin">{t('保证金(USDT)')}</Label>
          <Input id="trade-margin" className="num" inputMode="decimal" value={marginUsdt} onChange={(e) => onMarginUsdt(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-leverage">{t('杠杆')}</Label>
          <Input id="trade-leverage" className="num" inputMode="decimal" value={leverage} onChange={(e) => onLeverage(e.target.value)} />
        </div>
      </div>

      <ToggleGroup
        type="single"
        variant="outline"
        value={marginMode}
        onValueChange={(v) => v && onMarginMode(v as 'cross' | 'isolated')}
        className="w-full"
      >
        <ToggleGroupItem value="cross" className="flex-1">
          {t('全仓')}
        </ToggleGroupItem>
        <ToggleGroupItem value="isolated" className="flex-1">
          {t('逐仓')}
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-tp">{t('止盈(可选)')}</Label>
          <Input id="trade-tp" className="num" inputMode="decimal" value={tp} onChange={(e) => onTp(e.target.value)} placeholder={t('价格')} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-sl">{t('止损(可选)')}</Label>
          <Input id="trade-sl" className="num" inputMode="decimal" value={sl} onChange={(e) => onSl(e.target.value)} placeholder={t('价格')} />
        </div>
      </div>

      <Separator />

      <div className="num flex flex-col gap-1 text-[11.5px] text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>{t('名义')}</span>
          <span className="text-foreground">{notional > 0 ? `${notional.toFixed(2)} USDT` : '—'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>{t('数量')}</span>
          <span className="text-foreground">{qty > 0 ? qty.toFixed(stepDecimals) : '—'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>{t('预估强平价')}</span>
          <span className="text-foreground">{liqPrice ? fmtPrice(liqPrice) : '—'}</span>
        </div>
      </div>

      <Button onClick={onSubmit} disabled={submitting} className="mt-1">
        {submitting ? t('提交中…') : reduceOnly ? t('提交平仓') : t('提交开仓')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 中:策略线程列表

function ThreadRow({
  thread,
  selected,
  onSelect,
  onClose,
  onReview,
  reviewPending,
  closed = false,
}: {
  thread: StrategyThread;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onReview: () => void;
  reviewPending: boolean;
  /** 已结束的线程:只读回看(不给复查/平仓),用来在没有进行中线程时填空 */
  closed?: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn('cursor-pointer border-b px-2.5 py-2 text-[12px] transition-colors hover:bg-muted/40', selected && 'bg-muted/60', closed && 'opacity-70 hover:opacity-100')}
    >
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className={cn('shrink-0', threadStatusBadgeClass(thread.status))}>
          {THREAD_STATUS_LABEL[thread.status]}
        </Badge>
        <span className="num truncate font-semibold">{thread.symbol}</span>
        <span className={cn('shrink-0 text-[11px] font-medium', directionText(thread.side))}>{directionLabel(thread.side)}</span>
        <Badge variant="outline" className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {THREAD_SOURCE_LABEL[thread.source]}
        </Badge>
      </div>
      <div className="num mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{t('入场')} {entryText(thread)}</span>
        <span>{relativeTime(thread.updated_at)}</span>
      </div>
      {thread.stop_price || thread.take_profits[0] ? (
        <div className="num mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          {thread.stop_price ? <span>{t('止损')} {fmtPrice(thread.stop_price)}</span> : null}
          {thread.take_profits[0] ? <span>{t('止盈')} {fmtPrice(thread.take_profits[0])}</span> : null}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        {closed ? (
          <a href="#history" className="text-[11px] text-muted-foreground hover:text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            {t('复盘 →')}
          </a>
        ) : (
          <>
            <Button
              size="xs"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                onReview();
              }}
              disabled={reviewPending}
            >
              {t('复查')}
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              {thread.status === 'pending_entry' ? t('撤单') : t('平仓')}
            </Button>
          </>
        )}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          title={t('问 agent 这笔为什么')}
          onClick={(e) => {
            e.stopPropagation();
            askAgent(whyQuestion({ symbol: thread.symbol, at: thread.created_at, action: null, threadId: thread.id }));
          }}
        >
          <CircleQuestionMark data-slot="icon" />
          {t('问 agent')}
        </Button>
      </div>
    </div>
  );
}

/** 图表标题旁的日线状态 / 时段徽章(GET /api/market/regime;老网关没有这个接口就不显示)。 */
function RegimeBadge({ symbol }: { symbol: string }) {
  const regimeQ = useQuery({ queryKey: ['regime', symbol], queryFn: () => api.regime(symbol), enabled: !!symbol, retry: 0, staleTime: 60_000, refetchInterval: 120_000 });
  const r = regimeQ.data;
  if (!r) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1 animate-in fade-in duration-300">
          <Badge variant="outline" className={cn('h-5 px-1.5 text-[10.5px]', dailyRegimeClass(r.daily.regime))}>
            {DAILY_REGIME_LABEL[r.daily.regime] ?? r.daily.regime}
          </Badge>
          <Badge variant="outline" className={cn('h-5 px-1.5 text-[10.5px] text-muted-foreground', r.session.name === 'us_open_window' && 'border-warn/40 text-warn')}>
            {SESSION_LABEL[r.session.name] ?? r.session.name}
            {r.session.minutes_to_us_open !== null && r.session.minutes_to_us_open > 0 && r.session.minutes_to_us_open <= 60 ? <span className="num ml-1">{t('{n} 分钟后开盘', { n: r.session.minutes_to_us_open })}</span> : null}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72 text-[11.5px] leading-relaxed">
        <div>{r.daily.text}</div>
        <div className="mt-1 text-muted-foreground">{r.session.text}</div>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// 底:持仓 / 挂单

/**
 * 持仓表多一列「管理」:有线程的显示线程状态;没有线程的(手动单、撤单竞态孤立的仓)给「交给 agent」——
 * 接管后建 in_position 线程进复查循环。止损优先用交易所上已挂的,没有就要人填。
 */
function PositionsTable({ positions, threads, openOrders }: { positions: PositionView[]; threads: StrategyThread[]; openOrders: OpenOrderView[] }) {
  const queryClient = useQueryClient();
  const [adopting, setAdopting] = useState<PositionView | null>(null);
  const [stopText, setStopText] = useState('');
  const [tpText, setTpText] = useState('');
  const exchangeStopFor = (p: PositionView) =>
    openOrders.find((o) => o.symbol === p.symbol && o.stop_price && /STOP/i.test(o.type) && !/TAKE_PROFIT/i.test(o.type) && (p.side === 'long' ? /sell/i.test(o.side) : /buy/i.test(o.side))) ?? null;
  const exchangeTpFor = (p: PositionView) => openOrders.find((o) => o.symbol === p.symbol && o.stop_price && /TAKE_PROFIT/i.test(o.type) && (p.side === 'long' ? /sell/i.test(o.side) : /buy/i.test(o.side))) ?? null;
  const adopt = useMutation({
    mutationFn: (p: PositionView) => api.adoptPosition(p.symbol, { stop_price: stopText.trim() || null, take_profit: tpText.trim() || null }),
    onSuccess: (res) => {
      toast.success(t('{symbol} 交给 agent 接管了', { symbol: res.thread.symbol }), { description: `${t('止损')} ${res.thread.stop_price ?? '—'}${res.thread.take_profits[0] ? `,${t('止盈')} ${res.thread.take_profits[0]}` : ''}` });
      setAdopting(null);
      void queryClient.invalidateQueries({ queryKey: ['threads'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
      void queryClient.invalidateQueries({ queryKey: ['open-orders'] });
    },
    onError: (err) => toast.error(t('接管失败'), { description: errMsg(err) }),
  });
  const openAdopt = (p: PositionView) => {
    setStopText(exchangeStopFor(p)?.stop_price ?? '');
    setTpText(exchangeTpFor(p)?.stop_price ?? '');
    setAdopting(p);
  };
  // 平仓:有线程走线程平仓(撤保护腿+市价平+关线程);无主的走手动单 close 路径(撤该币所有挂单+市价平)
  const [closing, setClosing] = useState<{ p: PositionView; thread: StrategyThread | null } | null>(null);
  const closePos = useMutation({
    mutationFn: async ({ p, thread }: { p: PositionView; thread: StrategyThread | null }) => {
      if (thread) return api.closeThread(thread.id);
      return api.placeOrder({ symbol: p.symbol, side: p.side, action: 'close', type: 'market' });
    },
    onSuccess: (_res, { p }) => {
      toast.success(t('{symbol} 平仓已发出', { symbol: p.symbol }));
      setClosing(null);
      void queryClient.invalidateQueries({ queryKey: ['threads'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
      void queryClient.invalidateQueries({ queryKey: ['open-orders'] });
    },
    onError: (err) => toast.error(t('平仓失败'), { description: errMsg(err) }),
  });
  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('币种')}</TableHead>
          <TableHead>{t('方向')}</TableHead>
          <TableHead>{t('数量')}</TableHead>
          <TableHead>{t('开仓价')}</TableHead>
          <TableHead>{t('标记价')}</TableHead>
          <TableHead>{t('未实现盈亏')}</TableHead>
          <TableHead>{t('杠杆')}</TableHead>
          <TableHead>{t('管理')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
              {t('暂无持仓')}
            </TableCell>
          </TableRow>
        ) : (
          positions.map((p, i) => {
            const th = threads.find((t) => t.symbol === p.symbol && (t.status === 'in_position' || t.status === 'pending_entry')) ?? null;
            const exStop = exchangeStopFor(p);
            return (
            <TableRow key={`${p.symbol}-${i}`}>
              <TableCell className="num font-medium">{p.symbol}</TableCell>
              <TableCell className={cn('font-medium', directionText(p.side))}>{directionLabel(p.side)}</TableCell>
              <TableCell className="num">{fmtQty(p.qty)}</TableCell>
              <TableCell className="num">{fmtPrice(p.entry_price)}</TableCell>
              <TableCell className="num">{fmtPrice(p.mark_price)}</TableCell>
              <TableCell className={cn('num', pnlText(p.unrealized_pnl))}>{fmtSigned(p.unrealized_pnl)}</TableCell>
              <TableCell className="num">{p.leverage}x</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  {th ? (
                    <Badge variant="outline" className="h-5 px-1.5 text-[10.5px]" title={t('线程 {id}', { id: th.id })}>
                      {t('agent 在管')}{th.stop_price ? ` · ${t('止损')} ${th.stop_price}` : ''}
                    </Badge>
                  ) : (
                    <>
                      <Badge variant="outline" className="h-5 border-warn/40 px-1.5 text-[10.5px] text-warn" title={t('不属于任何线程,agent 不会管它的离场')}>
                        {t('无主')}{exStop ? ` · ${t('交易所止损 {price}', { price: exStop.stop_price })}` : ` · ${t('没有止损')}`}
                      </Badge>
                      <Button size="xs" variant="outline" onClick={() => openAdopt(p)}>
                        {t('交给 agent')}
                      </Button>
                    </>
                  )}
                  <Button size="xs" variant="outline" className="border-down/40 text-down hover:bg-down/10 hover:text-down" onClick={() => setClosing({ p, thread: th })}>
                    {t('平仓')}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
    <ConfirmDialog
      open={adopting !== null}
      title={adopting ? t('把 {symbol} 交给 agent', { symbol: adopting.symbol }) : t('交给 agent')}
      summary={t('接管')}
      busy={adopt.isPending}
      onCancel={() => setAdopting(null)}
      onConfirm={() => adopting && adopt.mutate(adopting)}
    >
      {adopting ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {directionLabel(adopting.side)} {fmtQty(adopting.qty)} @ {fmtPrice(adopting.entry_price)}。{t('接管之后建一条线程,agent 按 K 线收盘、止损止盈触发、信息更新来复查,可以 HOLD、减仓、离场;止损止盈由代码守着。')}
          </p>
          <div className="flex flex-col gap-1">
            <Label className="text-[12px]">{t('止损价(必填)')}{exchangeStopFor(adopting) ? t('(默认用交易所上已挂的)') : ''}</Label>
            <Input className="num h-7" value={stopText} onChange={(e) => setStopText(e.target.value)} placeholder={adopting.side === 'long' ? t('低于标记价') : t('高于标记价')} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[12px]">{t('止盈价(可选)')}{exchangeTpFor(adopting) ? t('(默认用交易所上已挂的)') : ''}</Label>
            <Input className="num h-7" value={tpText} onChange={(e) => setTpText(e.target.value)} placeholder={t('留空 = 不挂止盈')} />
          </div>
          <p className="text-[10.5px] text-muted-foreground">{t('填了新的止损价,会先撤掉这个币上的旧条件单再挂;沿用交易所已有的就不重复挂。')}</p>
        </div>
      ) : null}
    </ConfirmDialog>
    <ConfirmDialog
      open={closing !== null}
      title={closing ? t('市价平掉 {symbol}', { symbol: closing.p.symbol }) : t('平仓')}
      summary={t('确认平仓')}
      danger
      busy={closePos.isPending}
      onCancel={() => setClosing(null)}
      onConfirm={() => closing && closePos.mutate(closing)}
    >
      {closing ? (
        <p className="text-muted-foreground">
          {directionLabel(closing.p.side)} {fmtQty(closing.p.qty)} @ {fmtPrice(closing.p.entry_price)},{t('未实现')} {fmtSigned(closing.p.unrealized_pnl)}。
          {closing.thread ? t('会先撤掉这条线程的止损止盈,再市价全平并关掉线程。') : t('会先撤掉这个币上的全部挂单(含条件单),再市价全平。')}
          {t('agent_mcp 通道一次约 40 秒,这期间别重复点。')}
        </p>
      ) : null}
    </ConfirmDialog>
    </>
  );
}

function OpenOrdersTable({ orders }: { orders: OpenOrderView[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('币种')}</TableHead>
          <TableHead>{t('方向')}</TableHead>
          <TableHead>{t('类型')}</TableHead>
          <TableHead>{t('数量')}</TableHead>
          <TableHead>{t('价格')}</TableHead>
          <TableHead>{t('触发价')}</TableHead>
          <TableHead>{t('只减仓')}</TableHead>
          <TableHead>{t('状态')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
              {t('暂无挂单')}
            </TableCell>
          </TableRow>
        ) : (
          orders.map((o) => (
            <TableRow key={o.client_order_id}>
              <TableCell className="num font-medium">{o.symbol}</TableCell>
              <TableCell className={cn('font-medium', o.side.toUpperCase() === 'BUY' ? 'text-up' : 'text-down')}>{o.side}</TableCell>
              <TableCell>{o.type}</TableCell>
              <TableCell className="num">{fmtQty(o.qty)}</TableCell>
              <TableCell className="num">{o.price ? fmtPrice(o.price) : t('市价')}</TableCell>
              <TableCell className="num">{o.stop_price ? fmtPrice(o.stop_price) : '—'}</TableCell>
              <TableCell>{o.reduce_only ? t('是') : t('否')}</TableCell>
              <TableCell className="text-muted-foreground">{o.status}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// 主页面

type TopTab = 'chart' | 'strategy' | 'agent';
type BottomTab = 'positions' | 'orders';

export function TradePage() {
  const queryClient = useQueryClient();

  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const symbolsQ = useQuery({ queryKey: ['symbols'], queryFn: api.symbols });
  const threadsQ = useQuery({ queryKey: ['threads', 'open'], queryFn: () => api.threads('open') });
  const allThreadsQ = useQuery({ queryKey: ['threads', 'all'], queryFn: () => api.threads('all'), staleTime: 30_000 });
  const positionsQ = useQuery({ queryKey: ['positions'], queryFn: api.positions });
  const openOrdersQ = useQuery({ queryKey: ['open-orders'], queryFn: api.openOrders });

  // ---- 下单面板状态 ----
  // 深链 #trade?symbol=BNBUSDT(楼层/判断记录跳过来直接选中该币;也方便复现某个币的渲染问题)
  const [selectedSymbol, setSelectedSymbol] = useState(() => (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('symbol') ?? '').toUpperCase());
  const [side, setSide] = useState<Direction>('long');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [price, setPrice] = useState('');
  const [marginUsdt, setMarginUsdt] = useState('100');
  const [leverage, setLeverage] = useState('3');
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>('cross');
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');

  // 币种默认值:优先用当前行情币种,其次用交易所可交易列表的第一个;只在第一次拿到时设置一次。
  useEffect(() => {
    if (selectedSymbol) return;
    const fallback = overviewQ.data?.market.symbol ?? symbolsQ.data?.symbols[0]?.symbol;
    if (fallback) setSelectedSymbol(fallback);
  }, [selectedSymbol, overviewQ.data?.market.symbol, symbolsQ.data?.symbols]);

  // 杠杆/全逐仓默认值跟工作流走一次(用户改过之后不再覆盖)。
  const workflowDefaultsApplied = useRef(false);
  useEffect(() => {
    if (workflowDefaultsApplied.current) return;
    const wf = overviewQ.data?.workflow;
    if (!wf) return;
    workflowDefaultsApplied.current = true;
    setLeverage(String(wf.leverage));
    setMarginMode(wf.margin_mode);
  }, [overviewQ.data?.workflow]);

  // ---- 中间线程列表 / 选中线程 ----
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const threads = useMemo(() => threadsQ.data?.threads ?? [], [threadsQ.data]);
  // 已结束的线程:进行中为空时把最近几条摆出来填空(只读),有进行中时折在下面
  const closedThreads = useMemo(
    () =>
      (allThreadsQ.data?.threads ?? [])
        .filter((t) => t.status !== 'pending_entry' && t.status !== 'in_position')
        .sort((a, b) => b.updated_at - a.updated_at),
    [allThreadsQ.data],
  );
  const closedRecent = useMemo(() => closedThreads.slice(0, 8), [closedThreads]);
  const selectedThread = useMemo(() => threads.find((t) => t.id === selectedThreadId) ?? closedRecent.find((t) => t.id === selectedThreadId) ?? null, [threads, closedRecent, selectedThreadId]);
  const closedCount = closedThreads.length;
  // 线程栏折叠:用户没手动定过就跟着「有没有进行中线程」自动收放;手动定过记本机
  const [threadsPaneUser, setThreadsPaneUser] = useState<boolean | null>(() => {
    try {
      const v = window.localStorage.getItem('tg.trade.threads.open');
      return v === null ? null : v === '1';
    } catch {
      return null;
    }
  });
  // Codex(trade-page-layout):只有「成功加载且进行中为 0」才自动收起,失败/加载中不收
  const threadsPaneOpen = threadsPaneUser ?? !(threadsQ.isSuccess && threads.length === 0);
  const setThreadsPane = (open: boolean) => {
    setThreadsPaneUser(open);
    try {
      window.localStorage.setItem('tg.trade.threads.open', open ? '1' : '0');
    } catch {
      /* 无 storage */
    }
  };
  const [showClosed, setShowClosed] = useState(false);
  const watchlist = overviewQ.data?.workflow.watchlist ?? [];
  const threadSymbols = useMemo(() => [...new Set(threads.map((t) => t.symbol))], [threads]);

  const selectThread = (t: StrategyThread) => {
    setSelectedThreadId(t.id);
    setSelectedSymbol(t.symbol);
    setSide(t.side);
  };

  /**
   * 图表左侧币种列表 / 下单面板的 SymbolPicker 共用的切币入口:两处必须同步(都写
   * selectedSymbol),并且切到别的币时把选中的线程清掉——否则图表上还画着另一个币的
   * 入场/止损价格线。
   */
  const selectSymbol = useCallback(
    (sym: string) => {
      if (!sym) return;
      setSelectedSymbol(sym);
      setSelectedThreadId((cur) => {
        if (!cur) return cur;
        const t = threads.find((x) => x.id === cur);
        return t && t.symbol !== sym ? null : cur;
      });
    },
    [threads],
  );

  // ---- 右上 / 底部 tab ----
  const [topTab, setTopTab] = useState<TopTab>('chart');
  const [bottomTab, setBottomTab] = useState<BottomTab>('positions');

  // ---- 下单 mutation ----
  const placeOrderMut = useMutation({
    mutationFn: (payload: ManualOrderRequest) => api.placeOrder(payload),
    onSuccess: (resp) => {
      toast.success(t('已提交 {symbol} {side}', { symbol: resp.thread.symbol, side: directionLabel(resp.thread.side) }));
      void queryClient.invalidateQueries({ queryKey: ['threads', 'open'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (err) => toast.error(t('下单失败'), { description: errMsg(err) }),
  });

  const handleSubmit = () => {
    if (!selectedSymbol) {
      toast.error(t('先选个币种'));
      return;
    }
    const marginNum = Number(marginUsdt);
    const leverageNum = Number(leverage);
    if (!(marginNum > 0)) {
      toast.error(t('保证金要大于 0'));
      return;
    }
    if (!(leverageNum > 0)) {
      toast.error(t('杠杆要大于 0'));
      return;
    }
    if (orderType === 'limit' && !(Number(price) > 0)) {
      toast.error(t('填一下限价价格'));
      return;
    }
    placeOrderMut.mutate({
      symbol: selectedSymbol,
      side,
      action: reduceOnly ? 'close' : 'open',
      type: orderType,
      price: orderType === 'limit' ? price : undefined,
      margin_usdt: marginUsdt,
      leverage: leverageNum,
      tp: tp || undefined,
      sl: sl || undefined,
      margin_mode: marginMode,
    });
  };

  // ---- 线程操作 ----
  const [closeTarget, setCloseTarget] = useState<StrategyThread | null>(null);
  const closeThreadMut = useMutation({
    mutationFn: (id: string) => api.closeThread(id),
    onSuccess: () => {
      toast.success(t('已提交'));
      void queryClient.invalidateQueries({ queryKey: ['threads', 'open'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      setCloseTarget(null);
    },
    onError: (err) => toast.error(t('操作失败'), { description: errMsg(err) }),
  });
  const reviewThreadMut = useMutation({
    mutationFn: (id: string) => api.reviewThread(id),
    onSuccess: () => toast.success(t('已叫它复查')),
    onError: (err) => toast.error(t('复查失败'), { description: errMsg(err) }),
  });

  const market = marketForSymbol(overviewQ.data, selectedSymbol);
  const symbols = symbolsQ.data?.symbols ?? [];
  const positions = positionsQ.data ?? [];
  const openOrders = openOrdersQ.data ?? [];

  const chartSymbol = selectedSymbol || overviewQ.data?.market.symbol || 'BTCUSDT';
  const chartTimeframe = overviewQ.data?.workflow.timeframe ?? overviewQ.data?.market.klines_tf ?? '15m';
  const chartLines = selectedThread
    ? {
        entryPrice: selectedThread.entry.price,
        entryZone: selectedThread.entry.zone,
        stopPrice: selectedThread.stop_price,
        takeProfits: selectedThread.take_profits,
      }
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Workspace className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 divide-x overflow-hidden">
          <Pane title={t('下单')} className="w-[280px] shrink-0" contentClassName="min-h-0 flex-1">
            <OrderPanel
              symbols={symbols}
              selectedSymbol={selectedSymbol}
              onSelectSymbol={selectSymbol}
              watchlist={watchlist}
              threadSymbols={threadSymbols}
              market={market}
              side={side}
              onSide={setSide}
              reduceOnly={reduceOnly}
              onReduceOnly={setReduceOnly}
              orderType={orderType}
              onOrderType={setOrderType}
              price={price}
              onPrice={setPrice}
              marginUsdt={marginUsdt}
              onMarginUsdt={setMarginUsdt}
              leverage={leverage}
              onLeverage={setLeverage}
              marginMode={marginMode}
              onMarginMode={setMarginMode}
              tp={tp}
              onTp={setTp}
              sl={sl}
              onSl={setSl}
              onSubmit={handleSubmit}
              submitting={placeOrderMut.isPending}
            />
          </Pane>

          {!threadsPaneOpen ? (
            <button
              type="button"
              onClick={() => setThreadsPane(true)}
              className="flex w-8 shrink-0 flex-col items-center gap-2 border-r bg-muted/20 py-2 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              title={t('展开策略线程')}
            >
              <ChevronRight className="size-3.5" />
              <span className="kicker [writing-mode:vertical-rl]">{t('策略线程')} · {threads.length}</span>
              {closedCount ? <span className="num [writing-mode:vertical-rl]">{t('已结束 {n}', { n: closedCount })}</span> : null}
            </button>
          ) : (
          <Pane
            title={t('策略线程')}
            hint={threads.length ? t('{n} 条进行中', { n: threads.length }) : t('没有进行中的')}
            className="w-[320px] shrink-0"
            contentClassName="flex min-h-0 flex-1 flex-col"
            actions={
              <button type="button" onClick={() => setThreadsPane(false)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" title={t('收起(没有进行中线程时会自动收起)')}>
                <ChevronLeft className="size-3.5" />
              </button>
            }
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              {threadsQ.isLoading ? (
                <div className="p-4 text-[12px] text-muted-foreground">{t('加载中…')}</div>
              ) : threadsQ.isError ? (
                <div className="p-4 text-[12px] text-down">{t('线程列表没读到,不代表没有线程。')}{errMsg(threadsQ.error)}</div>
              ) : threads.length === 0 ? (
                <>
                  <div className="px-3 py-2 text-[11.5px] text-muted-foreground">{t('没有进行中的线程。扫描出结果、或者你手动下单之后,会出现在这里。')}</div>
                  {closedRecent.length ? (
                    <>
                      <div className="kicker border-y bg-muted/30 px-3 py-1 text-[10px] text-muted-foreground">{t('最近结束')}</div>
                      {closedRecent.map((t) => (
                        <ThreadRow key={t.id} thread={t} closed selected={t.id === selectedThreadId} onSelect={() => selectThread(t)} onClose={() => {}} onReview={() => {}} reviewPending={false} />
                      ))}
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {threads.map((t) => (
                    <ThreadRow
                      key={t.id}
                      thread={t}
                      selected={t.id === selectedThreadId}
                      onSelect={() => selectThread(t)}
                      onClose={() => setCloseTarget(t)}
                      onReview={() => reviewThreadMut.mutate(t.id)}
                      reviewPending={reviewThreadMut.isPending && reviewThreadMut.variables === t.id}
                    />
                  ))}
                  {closedRecent.length ? (
                    <>
                      <button type="button" onClick={() => setShowClosed((v) => !v)} className="kicker flex w-full items-center gap-1 border-y bg-muted/30 px-3 py-1 text-left text-[10px] text-muted-foreground hover:text-foreground">
                        {showClosed ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        {t('最近结束')} {closedRecent.length}
                      </button>
                      {showClosed ? closedRecent.map((t) => <ThreadRow key={t.id} thread={t} closed selected={t.id === selectedThreadId} onSelect={() => selectThread(t)} onClose={() => {}} onReview={() => {}} reviewPending={false} />) : null}
                    </>
                  ) : null}
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                window.location.hash = 'history';
              }}
              className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <span>
                {t('已结束')} <span className="num font-semibold text-foreground">{closedCount}</span> {t('条')}
              </span>
              <span className="text-primary">{t('复盘 →')}</span>
            </button>
          </Pane>
          )}

          <Pane
            title={t('详情')}
            className="min-w-0 flex-1"
            contentClassName="flex min-h-0 flex-1 flex-col"
            actions={
              <>
                <RegimeBadge symbol={chartSymbol} />
                <Tabs value={topTab} onValueChange={(v) => setTopTab(v as TopTab)}>
                <TabsList>
                  <TabsTrigger value="chart">{t('图表')}</TabsTrigger>
                  <TabsTrigger value="strategy">{t('策略')}</TabsTrigger>
                  <TabsTrigger value="agent">Agent</TabsTrigger>
                </TabsList>
                </Tabs>
              </>
            }
          >
            {topTab === 'chart' ? (
              <div className="flex min-h-0 flex-1">
                <ChartSymbolList
                  symbols={symbols}
                  value={chartSymbol}
                  onChange={selectSymbol}
                  watchlist={watchlist}
                  watchOnly={overviewQ.data?.workflow.watch_only ?? []}
                  positions={positions}
                  openOrders={openOrders}
                  threads={threads}
                  markets={overviewQ.data?.markets}
                  marketState={overviewQ.data?.market_state}
                />
                <div className="min-h-0 min-w-0 flex-1">
                  <TradeChart symbol={chartSymbol} timeframe={chartTimeframe} lines={chartLines} />
                </div>
              </div>
            ) : null}
            {topTab === 'strategy' ? (
              selectedThread ? (
                <div className="flex flex-col gap-2 overflow-y-auto p-3 text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={threadStatusBadgeClass(selectedThread.status)}>
                      {THREAD_STATUS_LABEL[selectedThread.status]}
                    </Badge>
                    <span className="num font-semibold">{selectedThread.symbol}</span>
                    <span className={cn('text-[11px] font-medium', directionText(selectedThread.side))}>
                      {directionLabel(selectedThread.side)}
                    </span>
                    <Badge variant="outline" className="ml-auto text-[10px] text-muted-foreground">
                      {THREAD_SOURCE_LABEL[selectedThread.source]}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">{selectedThread.thesis || '—'}</p>
                  {selectedThread.invalidation_text ? (
                    <p className="text-[11px] text-warn">{t('失效条件')}:{selectedThread.invalidation_text}</p>
                  ) : null}
                  {selectedThread.watch_conditions.length > 0 ? (
                    <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                      {selectedThread.watch_conditions.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  ) : null}
                  <Separator />
                  <div className="num grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{t('入场')} {entryText(selectedThread)}</span>
                    <span>{t('止损')} {selectedThread.stop_price ? fmtPrice(selectedThread.stop_price) : '—'}</span>
                    <span>{t('数量')} {fmtQty(selectedThread.qty)}</span>
                    <span>{t('杠杆')} {selectedThread.leverage}x</span>
                  </div>
                </div>
              ) : (
                <div className="p-6 text-center text-[12px] text-muted-foreground">{t('在左边「策略线程」里点一条看详情')}</div>
              )
            ) : null}
            {topTab === 'agent' ? (
              <div className="min-h-0 flex-1">
                <ChatPanel compact />
              </div>
            ) : null}
          </Pane>
        </div>

        <div className="flex min-h-[220px] shrink-0 flex-col border-t">
          <Pane
            title={t('账户')}
            hint={`${backendLabel(overviewQ.data?.account?.backend)} · ${t('切执行通道就是切账户')}`}
            className="min-h-0 flex-1"
            contentClassName="min-h-0 flex-1 overflow-y-auto"
            actions={
              <>
              {overviewQ.data?.account?.backend === 'paper' ? (
                <Button size="xs" variant="outline" className="border-warn/50 text-warn" onClick={openExecutionSetup}>{t('接入币安 →')}</Button>
              ) : null}
              <Tabs value={bottomTab} onValueChange={(v) => setBottomTab(v as BottomTab)}>
                <TabsList>
                  <TabsTrigger value="positions">{t('持仓')}</TabsTrigger>
                  <TabsTrigger value="orders">{t('挂单')}</TabsTrigger>
                </TabsList>
              </Tabs>
              </>
            }
          >
            {bottomTab === 'positions' ? <PositionsTable positions={positions} threads={threads} openOrders={openOrders} /> : <OpenOrdersTable orders={openOrders} />}
          </Pane>
        </div>
      </Workspace>

      <ConfirmDialog
        open={!!closeTarget}
        title={closeTarget?.status === 'pending_entry' ? t('撤单') : t('平仓')}
        summary={closeTarget?.status === 'pending_entry' ? t('确认撤单') : t('确认平仓')}
        danger
        busy={closeThreadMut.isPending}
        onCancel={() => setCloseTarget(null)}
        onConfirm={() => {
          if (closeTarget) closeThreadMut.mutate(closeTarget.id);
        }}
      >
        <p>
          {closeTarget ? `${closeTarget.symbol} · ${directionLabel(closeTarget.side)} · ${THREAD_STATUS_LABEL[closeTarget.status]}` : ''}
        </p>
      </ConfirmDialog>
    </div>
  );
}
