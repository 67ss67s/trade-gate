import { useEffect, useRef, useState } from 'react';
import type {
  AccountView,
  ActivityResponse,
  ApiError,
  ConfirmToken,
  WorkflowProposal,
  BacktestDetailResponse,
  BacktestEstimate,
  BacktestListResponse,
  BacktestStartResponse,
  BrainKind,
  BrainsResponse,
  BrainTestResult,
  ChatMessagesResponse,
  ChatSendResponse,
  BotRole,
  ChatSession,
  ChatSessionsResponse,
  DemoIntent,
  Episode,
  EpisodeSummary,
  BinanceMapResponse,
  BinanceMapTestResponse,
  ExecutionConnectResponse,
  ExecutionView,
  McpToolMap,
  GraphResponse,
  HistoryResponse,
  InfoEventsResponse,
  IndicatorsResponse,
  IndicatorSetsResponse,
  InfoRunNowResponse,
  InfoSourcesResponse,
  KlinesResponse,
  LogsResponse,
  LoopView,
  ManualOrderRequest,
  ManualOrderResponse,
  MarketState,
  MarketStateHistoryResponse,
  MemoryCreateRequest,
  MemoryDetailResponse,
  MemoryItem,
  MemoryListResponse,
  MemoryReflectResponse,
  MemorySearchResponse,
  MemoryStatus,
  Overview,
  RegimeResponse,
  ScanNowResponse,
  ServerEventMap,
  SettingsPayload,
  StrategyThread,
  NetCheckResult,
  StrategyWithRevisions,
  SymbolsResponse,
  ThreadDetailResponse,
  ThreadsResponse,
  KlinesHistoryResponse,
  Workflow,
  WorkflowPatchResponse,
  BacktestAttributeResponse,
  BacktestAttributionResponse,
  StrategiesResponse,
  StrategyActiveResponse,
  StrategyDetailResponse,
  StrategyMutationResponse,
  StrategyRetireResponse,
  StrategySpec,
  StrategyStatus,
  BotHandoffAckResponse,
  BotHandoffsResponse,
  BotsResponse,
  HandoffStatus,
  ScreenerApplyResponse,
  ScreenerDetailResponse,
  ScreenerHistoryResponse,
  ScreenerLatestResponse,
  ScreenerRunResponse,
  ScreenHorizon,
  PortfolioSnapshotResponse,
  PortfolioCapacityResponse,
  RiskAlertRow,
  RiskAlertAction,
  ProtectionStatusView,
  RiskAlertsResponse,
  ReviewerBatchResponse,
  ReviewerCardsResponse,
  LabExperimentsResponse,
  CaptainBriefResponse,
} from './types';

class ApiRequestError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = body as ApiError | null;
    throw new ApiRequestError(res.status, err?.error?.code ?? 'unknown', err?.error?.message ?? res.statusText);
  }
  return body as T;
}

function post<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) });
}

/** post() 的任意方法版(目前只有 PUT /api/binance/map 用得上)。 */
function send<T>(method: string, path: string, payload?: unknown): Promise<T> {
  return request<T>(path, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
}

export const api = {
  // ---- v1 --------------------------------------------------------------
  overview: () => request<Overview>('/api/overview'),
  episodes: (opts?: { limit?: number; before?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.before) qs.set('before', opts.before);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<EpisodeSummary[]>(`/api/episodes${suffix}`);
  },
  episode: (id: string) => request<Episode>(`/api/episodes/${encodeURIComponent(id)}`),
  strategy: () => request<StrategyWithRevisions>('/api/strategy'),
  intents: (limit = 50) => request<DemoIntent[]>(`/api/intents?limit=${limit}`),
  klines: (tf: string, limit = 300, symbol?: string, endTime?: number) =>
    request<KlinesResponse>(`/api/market/klines?tf=${tf}&limit=${limit}${symbol ? `&symbol=${symbol}` : ''}${endTime ? `&end_time=${endTime}` : ''}`),
  // 指标库(design notes):set 留空就是网关的默认九条;
  // 只要一次请求就能同时拿到叠加线、副窗序列和快照文字,叠加层不用为每个指标各发一次。
  indicators: (symbol: string, interval: string, opts?: { limit?: number; set?: string[]; endTime?: number }) => {
    const qs = new URLSearchParams({ symbol, interval });
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.set?.length) qs.set('set', opts.set.join(','));
    if (opts?.endTime) qs.set('end_time', String(opts.endTime));
    return request<IndicatorsResponse>(`/api/market/indicators?${qs.toString()}`);
  },
  indicatorSets: () => request<IndicatorSetsResponse>('/api/market/indicators/sets'),
  logs: (limit = 200) => request<LogsResponse>(`/api/logs?limit=${limit}`),
  runNow: () => post<{ episode_id: string }>('/api/run-now'),
  pause: () => post<LoopView>('/api/pause'),
  resume: (confirm?: 'RESUME') => post<LoopView>('/api/resume', confirm ? { confirm } : undefined),
  halt: () => post<LoopView>('/api/halt', { confirm: 'HALT' }),
  settings: (payload: SettingsPayload) => post<LoopView>('/api/settings', payload),
  // §9.19:批准两步——先取一次性 token(120 秒),再带 nonce 批;缺 nonce 428 confirm_required,过期/用过/内容变了 409 confirm_expired|confirm_unknown|confirm_mismatch
  intentConfirmToken: (id: string) => post<ConfirmToken>(`/api/intents/${encodeURIComponent(id)}/confirm-token`),
  approveIntent: (id: string, nonce: string) => post<DemoIntent>(`/api/intents/${encodeURIComponent(id)}/approve`, { nonce }),
  rejectIntent: (id: string) => post<DemoIntent>(`/api/intents/${encodeURIComponent(id)}/reject`),

  // ---- v2:工作流 / 信息员 / 扫描 -----------------------------------------
  workflow: () => request<Workflow>('/api/workflow'),
  // §9.19 设置提议(对话改设置只到提议,人在界面上两步确认)
  workflowProposals: () => request<{ proposals: WorkflowProposal[] }>('/api/workflow/proposals'),
  proposalConfirmToken: (id: string) => post<ConfirmToken<WorkflowProposal>>(`/api/workflow/proposals/${encodeURIComponent(id)}/confirm-token`),
  applyProposal: (id: string, nonce: string) => post<{ proposal: WorkflowProposal; workflow: Workflow; errors: string[] }>(`/api/workflow/proposals/${encodeURIComponent(id)}/apply`, { nonce }),
  rejectProposal: (id: string) => post<{ proposal: WorkflowProposal }>(`/api/workflow/proposals/${encodeURIComponent(id)}/reject`),
  patchWorkflow: (patch: Partial<Workflow>) => post<WorkflowPatchResponse>('/api/workflow', patch),
  marketState: () => request<MarketState>('/api/market-state'),
  marketStateHistory: (limit = 20) => request<MarketStateHistoryResponse>(`/api/market-state/history?limit=${limit}`),
  infoRunNow: () => post<InfoRunNowResponse>('/api/info/run-now'),
  infoEvents: (limit = 100) => request<InfoEventsResponse>(`/api/info/events?limit=${limit}`),
  /** 信息源与采集状态(只读;网关未提供时 404,页面标「网关未提供来源状态」) */
  infoSources: () => request<InfoSourcesResponse>('/api/info/sources'),
  scanNow: (symbol?: string) => post<ScanNowResponse>('/api/scan-now', symbol ? { symbol } : undefined),

  // ---- v2:策略线程 -------------------------------------------------------
  threads: (status: 'open' | 'all' = 'open') => request<ThreadsResponse>(`/api/threads?status=${status}`),
  thread: (id: string) => request<ThreadDetailResponse>(`/api/threads/${encodeURIComponent(id)}`),
  closeThread: (id: string) => post<StrategyThread>(`/api/threads/${encodeURIComponent(id)}/close`),
  reviewThread: (id: string) => post<{ episode_id: string }>(`/api/threads/${encodeURIComponent(id)}/review`),

  // ---- v2:下单面板 / 账户 -------------------------------------------------
  placeOrder: (payload: ManualOrderRequest) => post<ManualOrderResponse>('/api/orders', payload),
  openOrders: () => request<AccountView['open_orders']>('/api/orders/open'),
  positions: () => request<AccountView['positions']>('/api/positions'),
  /** 09-07:网络自检,n 次只读调用,同步等结果(agent_mcp 约 n×25 s)。 */
  netCheck: (n = 5) => post<{ result: NetCheckResult }>('/api/execution/net-check', { n }),
  /** 09-07:把无主持仓交给 agent 管(建线程);没交易所止损时 stop_price 必填。 */
  adoptPosition: (symbol: string, body: { stop_price?: string | null; take_profit?: string | null }) => post<{ thread: StrategyThread }>(`/api/positions/${encodeURIComponent(symbol)}/adopt`, body),
  symbols: () => request<SymbolsResponse>('/api/symbols'),

  // ---- v2:对话 -----------------------------------------------------------
  chatMessages: (limit = 100, kind: 'chat' | 'narration' | 'all' = 'all', session?: string) =>
    request<ChatMessagesResponse>(`/api/chat/messages?limit=${limit}&kind=${kind}${session ? `&session=${encodeURIComponent(session)}` : ''}`),
  sendChat: (text: string, session?: string) => post<ChatSendResponse>('/api/chat/messages', session ? { text, session } : { text }),
  resetChat: (session?: string) => post<void>('/api/chat/reset', session ? { session } : undefined),
  // ---- v3.8(§9.14)对话会话。default 不能删(409);can_execute 自 §9.19 起只是前端偏好(意图卡是否显示执行按钮),后端不据它放行任何东西。
  chatSessions: (archived = false) => request<ChatSessionsResponse>(`/api/chat/sessions${archived ? '?archived=1' : ''}`),
  createChatSession: (title?: string, role?: BotRole) => post<{ session: ChatSession }>('/api/chat/sessions', { ...(title ? { title } : {}), ...(role ? { role } : {}) }),
  updateChatSession: (id: string, patch: { title?: string; archived?: boolean; can_execute?: boolean }) => post<{ session: ChatSession }>(`/api/chat/sessions/${encodeURIComponent(id)}`, patch),
  deleteChatSession: (id: string) => request<void>(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ---- v3(design notes):复盘 / 活动流 / 行情状态 --------------
  history: (limit = 200) => request<HistoryResponse>(`/api/history?limit=${limit}`),
  activity: (limit = 200, before?: number) => request<ActivityResponse>(`/api/activity?limit=${limit}${before ? `&before=${before}` : ''}`),
  regime: (symbol: string) => request<RegimeResponse>(`/api/market/regime?symbol=${encodeURIComponent(symbol)}`),

  // ---- v3:大脑选择 / 判断图 --------------------------------------------------
  brains: (refresh?: boolean) => request<BrainsResponse>(`/api/brains${refresh ? '?refresh=1' : ''}`),
  testBrain: (kind: BrainKind, model: string | null) => post<BrainTestResult>('/api/brains/test', { kind, model }),
  graph: () => request<GraphResponse>('/api/graph'),

  // ---- v3.3:执行后端(操作台)------------------------------------------------
  // 网关可能还没接这几个路由(另一位 agent 并行实现中),调用方一律 retry:0 + 缺省兜底。
  execution: () => request<ExecutionView>('/api/execution'),
  // §9.20 止损保护验证:网关自己用最小仓跑一遍 开→挂止损→确认→撤→平;202 started / 409 busy
  executionProtection: () => request<{ protection: ProtectionStatusView }>('/api/execution/protection'),
  verifyProtection: (symbol?: string) => post<{ started: boolean; protection: ProtectionStatusView }>('/api/execution/verify-protection', { confirm: true, ...(symbol ? { symbol } : {}) }),
  /** §9.20 告警自带动作:按 method/path/body 原样调 */
  alertAction: (a: RiskAlertAction) => send<unknown>(a.method, a.path, a.method === 'GET' ? undefined : (a.body ?? {})),
  executionCheck: () => post<ExecutionView>('/api/execution/check'),
  executionConnect: () => post<ExecutionConnectResponse>('/api/execution/connect'),
  executionSetupCli: () => post<{ started: boolean; command: string; instructions: string; url: string; detail?: string }>('/api/execution/setup-cli'),

  // ---- v3.4:币安 MCP 直连的工具映射(§9.8)—— 推断 → 编辑 → 只读测试 → 确认 ------------
  binanceMap: () => request<BinanceMapResponse>('/api/binance/map'),
  binanceMapPropose: () => post<BinanceMapResponse>('/api/binance/map/propose'),
  binanceMapPut: (map: McpToolMap | Record<string, unknown>) => send<BinanceMapResponse>('PUT', '/api/binance/map', map),
  binanceMapConfirm: () => post<BinanceMapResponse>('/api/binance/map/confirm'),
  binanceMapTest: (symbol?: string) => post<BinanceMapTestResponse>('/api/binance/map/test', symbol ? { symbol } : undefined),

  // ---- v3.2:长期记忆(design notes)—— 提案 → 人工批准 → 召回进证据 --------
  memoryList: (status?: MemoryStatus[] | string, symbol?: string, limit = 300) => {
    const qs = new URLSearchParams();
    const statusParam = Array.isArray(status) ? status.join(',') : status;
    if (statusParam) qs.set('status', statusParam);
    if (symbol) qs.set('symbol', symbol);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<MemoryListResponse>(`/api/memory${suffix}`);
  },
  memorySearch: (q: string, symbol?: string) => {
    const qs = new URLSearchParams({ q });
    if (symbol) qs.set('symbol', symbol);
    return request<MemorySearchResponse>(`/api/memory/search?${qs.toString()}`);
  },
  memoryDetail: (id: string) => request<MemoryDetailResponse>(`/api/memory/${encodeURIComponent(id)}`),
  memoryCreate: (body: MemoryCreateRequest) => post<{ item: MemoryItem }>('/api/memory', body),
  memoryAction: (id: string, action: 'approve' | 'reject' | 'forget', reason?: string) =>
    post<{ item: MemoryItem }>(`/api/memory/${encodeURIComponent(id)}/${action}`, reason ? { reason } : undefined),
  memoryReflect: (limit?: number) => post<MemoryReflectResponse>('/api/memory/reflect', limit ? { limit } : undefined),

  // ---- v3.4:回放与盲测(design notes)------------------------
  // 花钱的只有 startBacktest;调它之前必须先 backtestEstimate() 并让用户在确认框里看到 ¥。
  klinesHistory: (symbol: string, interval: string, from: number, to: number) =>
    request<KlinesHistoryResponse>(`/api/market/klines/history?symbol=${encodeURIComponent(symbol)}&interval=${interval}&from=${from}&to=${to}`),
  backtestEstimate: (q: {
    symbol: string;
    timeframe: string;
    from: number;
    to: number;
    mode: string;
    max_judgments?: number;
    review_every_close?: boolean;
    /**
     * v3.5:策略选择。**故意不写进 query string** —— 网关的 query 解析器把每个参数原样当字符串
     * 交给 normalizeParams,而 strategy_ids 只认数组,收到字符串会直接 400 把估算打挂。
     * 所以估算这一步落回 workflow 的默认策略集(候选根数可能与真正开跑时略有出入);
     * POST /api/backtest 走 JSON,那边是准的。
     */
    strategy_ids?: string[];
  }) => {
    const qs = new URLSearchParams({ symbol: q.symbol, timeframe: q.timeframe, from: String(q.from), to: String(q.to), mode: q.mode });
    if (q.max_judgments) qs.set('max_judgments', String(q.max_judgments));
    if (q.review_every_close !== undefined) qs.set('review_every_close', String(q.review_every_close));
    return request<BacktestEstimate>(`/api/backtest/estimate?${qs.toString()}`);
  },
  backtests: (limit = 50) => request<BacktestListResponse>(`/api/backtest?limit=${limit}`),
  backtest: (id: string) => request<BacktestDetailResponse>(`/api/backtest/${encodeURIComponent(id)}`),
  startBacktest: (body: {
    symbol: string;
    timeframe: string;
    from: number;
    to: number;
    mode: string;
    max_judgments: number;
    review_every_close: boolean;
    /** v3.5:这次拿哪几条策略判断(最多 4 条);缺省 = workflow.active_strategies。 */
    strategy_ids?: string[];
    /** v3.5:跑完顺手做一遍便宜大脑归因(会花钱)。 */
    attribute?: boolean;
  }) => post<BacktestStartResponse>('/api/backtest', body),
  cancelBacktest: (id: string) => post<{ cancelled: boolean }>(`/api/backtest/${encodeURIComponent(id)}/cancel`),

  // ---- v3.5:策略库 + 回测归因(design notes)---------------
  // 红线:这里没有一条能直接改在跑的策略的数字。改参数 = proposeStrategyVersion 落一个 draft
  // 新版本,再一格一格 promoteStrategy;paper → live_capped 必须带 confirm:true。
  // runBacktestAttribution 调的是便宜大脑,**会花钱**,按钮上必须说清楚。
  strategies: (includeRetired = false) => request<StrategiesResponse>(`/api/strategies${includeRetired ? '?include_retired=1' : ''}`),
  strategyDetail: (id: string) => request<StrategyDetailResponse>(`/api/strategies/${encodeURIComponent(id)}`),
  setActiveStrategies: (ids: string[]) => post<StrategyActiveResponse>('/api/strategies/active', { ids }),
  proposeStrategyVersion: (
    id: string,
    body: { params?: Record<string, number>; rules?: Partial<StrategySpec['rules']>; name?: string; attribution_id?: string },
  ) => post<StrategyMutationResponse>(`/api/strategies/${encodeURIComponent(id)}/propose-version`, body),
  promoteStrategy: (id: string, to: StrategyStatus, confirm = false) =>
    post<StrategyMutationResponse>(`/api/strategies/${encodeURIComponent(id)}/promote`, confirm ? { to, confirm: true } : { to }),
  retireStrategy: (id: string) => post<StrategyRetireResponse>(`/api/strategies/${encodeURIComponent(id)}/retire`),
  backtestAttribution: (id: string) => request<BacktestAttributionResponse>(`/api/backtest/${encodeURIComponent(id)}/attribution`),
  runBacktestAttribution: (id: string) => post<BacktestAttributeResponse>(`/api/backtest/${encodeURIComponent(id)}/attribute`),

  // ---- v3.6:雷达 / 筛选器 + 机器人团队(网关 src/demo/screener.ts、bots.ts)-----------
  // runScreener 会花钱(可选的便宜大脑那一遍)且可能被 409 拒(该 horizon 正在跑 / 运行时暂停);
  // applyScreen 只改 workflow.watchlist 一个字段,调用前必须先给人看 before → after 的 diff。
  screenerLatest: (horizon: ScreenHorizon) => request<ScreenerLatestResponse>(`/api/screener/latest?horizon=${horizon}`),
  screenerHistory: (horizon: ScreenHorizon, limit = 20) =>
    request<ScreenerHistoryResponse>(`/api/screener/history?horizon=${horizon}&limit=${limit}`),
  screen: (id: string) => request<ScreenerDetailResponse>(`/api/screener/${encodeURIComponent(id)}`),
  runScreener: (horizon: ScreenHorizon) => post<ScreenerRunResponse>('/api/screener/run', { horizon }),
  /** watchlist = 用户勾选后的最终名单;不传就整包应用提案。 */
  applyScreen: (id: string, watchlist?: string[]) =>
    post<ScreenerApplyResponse>(`/api/screener/${encodeURIComponent(id)}/apply`, watchlist ? { watchlist } : {}),
  bots: () => request<BotsResponse>('/api/bots'),
  botHandoffs: (status?: HandoffStatus, limit = 20) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<BotHandoffsResponse>(`/api/bots/handoffs${suffix}`);
  },
  ackHandoff: (id: string) => post<BotHandoffAckResponse>(`/api/bots/handoffs/${encodeURIComponent(id)}/ack`),
  // ---- v3.7:Portfolio / Risk(gateway 65bb92a)。resolve 只对 recovery_ready 的 high/critical 生效,否则 409。
  portfolioSnapshot: () => request<PortfolioSnapshotResponse>('/api/portfolio/snapshot'),
  /** §9.18 组合容量:还能开几条、每币可做/要多少权益 */
  portfolioCapacity: () => request<PortfolioCapacityResponse>('/api/portfolio/capacity'),
  riskAlerts: (status: 'open' | 'resolved' | 'all' = 'open') => request<RiskAlertsResponse>(`/api/risk/alerts?status=${status}`),
  ackRiskAlert: (id: string) => post<{ alert: RiskAlertRow }>(`/api/risk/alerts/${encodeURIComponent(id)}/ack`),
  resolveRiskAlert: (id: string) => post<{ alert: RiskAlertRow }>(`/api/risk/alerts/${encodeURIComponent(id)}/resolve`),
  riskEvaluate: () => post<RiskAlertsResponse>('/api/risk/evaluate'),
  // ---- v3.8:Reviewer(gateway 7102cd3)。batch 会调便宜大脑(≤ 2 次/天),409 = 不该跑。
  reviewerCards: (limit = 20) => request<ReviewerCardsResponse>(`/api/reviewer/cards?limit=${limit}`),
  reviewerBatch: () => post<ReviewerBatchResponse>('/api/reviewer/batch'),
  // ---- v3.9:Strategy Lab / Gate Captain(gateway c19646d,零模型)。labRun 202 跑几十秒,同 manifest 24h 内返回上一次。
  labExperiments: (limit = 10) => request<LabExperimentsResponse>(`/api/lab/experiments?limit=${limit}`),
  labRun: () => post<{ run_id?: string; reason?: string }>('/api/lab/run'),
  captainBrief: () => request<CaptainBriefResponse>('/api/captain/brief'),
  captainBriefNow: () => post<CaptainBriefResponse>('/api/captain/brief'),
};

export { ApiRequestError };

type EventHandlers = Partial<{ [K in keyof ServerEventMap]: (data: ServerEventMap[K]) => void }>;

const EVENT_NAMES: (keyof ServerEventMap)[] = [
  'loop.state',
  'episode.started',
  'episode.finished',
  'strategy.changed',
  'intent.changed',
  'account.updated',
  'market.tick',
  'log',
  'market_state.updated',
  'thread.changed',
  'chat.message',
  'queue.state',
  'workflow.changed',
  'activity',
  'memory.changed',
  'execution.changed',
  'backtest.progress',
  'backtest.changed',
  // v3.6
  'screener.changed',
  'bots.changed',
  // v3.7
  'portfolio.changed',
  'risk.changed',
];

/**
 * 订阅 GET /api/events(SSE)。按 event 名分别注册 handler。
 * 自己管连接生命周期(不依赖浏览器 EventSource 的原生重连),1s 起指数退避到 30s 封顶,
 * 一连上就把退避计数清零。
 */
export function useLiveEvents(handlers: EventHandlers, connected: (ok: boolean) => void = () => {}): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryMs = 1000;
    let retryTimer: number | undefined;
    let stopped = false;
    const listeners: [keyof ServerEventMap, (ev: MessageEvent) => void][] = [];

    const connect = () => {
      if (stopped) return;
      es = new EventSource('/api/events');
      listeners.length = 0;
      for (const name of EVENT_NAMES) {
        const listener = (ev: MessageEvent) => {
          const handler = handlersRef.current[name];
          if (!handler) return;
          try {
            const data = JSON.parse(ev.data);
            (handler as (d: unknown) => void)(data);
          } catch (err) {
            console.error(`[sse] 解析 ${name} 事件失败`, err);
          }
        };
        es.addEventListener(name, listener as EventListener);
        listeners.push([name, listener]);
      }
      es.addEventListener('open', () => {
        retryMs = 1000;
        connectedRef.current(true);
      });
      es.addEventListener('error', () => {
        connectedRef.current(false);
        es?.close();
        es = null;
        if (stopped) return;
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(30_000, retryMs * 2);
      });
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (es) {
        for (const [name, listener] of listeners) es.removeEventListener(name, listener as EventListener);
        es.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** 简单的 fetch-once hook,给静态/一次性加载的数据用。 */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fn()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}
