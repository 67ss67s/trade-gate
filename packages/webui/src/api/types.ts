// 领域对象:与 packages/gateway/src/demo/types.ts 逐字对齐(那是网关的权威 TS 源,
// 比 design notes + design notes 的文字描述更精确——网关已经把
// thread.attention / workflow.daily_loss_stop_pct / proposal.entry_zone 这些字段实现出来了)。
// 不要在这里做任何"改进";如果契约变了,先改网关那边的 types.ts,再同步这里。
//
// v1(§ README.md §2)+ v2(§ v2-agent-loop.md §2)混在一个文件里,和网关一致。
// 金额/价格/数量一律十进制字符串;时间戳一律 unix 毫秒;字段 snake_case。

// ---------------------------------------------------------------------------
// v1 基础类型

export type StrategyState =
  | 'researching'
  | 'watching'
  | 'ready'
  | 'active'
  | 'managing'
  | 'closing'
  | 'closed'
  | 'invalidated';

export type Action = 'NO_TRADE' | 'WATCH' | 'PROPOSE' | 'HOLD' | 'ADD' | 'REDUCE' | 'EXIT' | 'INVALIDATE';

export type Direction = 'long' | 'short';

/**
 * 执行后端。v1 只有 paper/demo;v3.3 加了 cli(binance-cli 演示后端)与 agent_mcp
 * (每笔下单交给 claude/codex 子进程调币安 MCP)。老网关只会返回前两个,前端一律
 * 用 backendLabel() 兜底翻译,不做穷举 switch。
 */
export type Backend = 'paper' | 'demo' | 'cli' | 'agent_mcp';

export interface Strategy {
  id: string;
  symbol: string;
  timeframe: string;
  state: StrategyState;
  version: number;
  direction: Direction | null;
  thesis: string;
  entry_plan: string | null;
  invalidation: string | null;
  invalidation_price: string | null;
  target_price: string | null;
  watch_conditions: string[];
  risk_budget_pct: string;
  updated_at: number;
  created_at: number;
}

export interface StrategyRevision {
  strategy_id: string;
  version: number;
  at: number;
  episode_id: string;
  from_state: StrategyState;
  to_state: StrategyState;
  action: Action;
  reason: string;
  snapshot: Strategy;
}

export interface Evidence {
  ref: string;
  kind: string;
  label: string;
  value: string;
  observed_at: number;
  source: string;
  stale: boolean;
}

export interface Proposal {
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: string | null;
  entry_zone: [string, string] | null; // v2:限价挂在靠近现价的一端,记录整个区间
  stop_price: string;
  take_profit_price: string | null;
  take_profits: string[]; // v2:多 TP,第一个先挂,其余记录
  rationale: string;
}

// 模型输出契约(严格校验;失败 → 修一次 → 仍失败 fail-closed NO_TRADE)
export interface Judgment {
  action: Action;
  direction: Direction | null;
  confidence: number; // 0..1
  headline: string; // ≤ 40 字,一句人话
  thesis: string; // ≤ 200 字
  reasons: string[]; // 2-5 条,每条引用 evidence_refs
  evidence_refs: string[]; // ⊆ registry
  invalidation: string | null;
  invalidation_price: string | null;
  target_price: string | null;
  watch_conditions: string[];
  proposal: Proposal | null;
}

export type TriggerKind =
  | 'kline_close'
  | 'manual'
  | 'schedule'
  | 'monitor'
  | 'position_review'
  // v2:图循环新增的触发源
  | 'scan'
  | 'info_update'
  | 'order_filled'
  | 'tp_hit'
  | 'sl_hit'
  | 'thread_review'
  | 'chat'
  // v3:代码触发器(design notes)
  | 'fast_move'
  | 'breakout'
  | 'ema_cross'
  | 'vol_spike'
  | 'retest'
  | 'session'
  | 'funding'
  | 'heartbeat';

export interface Trigger {
  kind: TriggerKind;
  detail: string;
}

export interface GateResult {
  name: string;
  passed: boolean;
  reason: string;
}

export interface SizingAgent {
  multiplier: number;
  overshoot: boolean;
  split: number;
  reason: string;
  applied: boolean;
}

export interface Sizing {
  agent?: SizingAgent;
  equity: string;
  risk_pct: string;
  risk_usdt: string;
  stop_distance: string;
  raw_qty: string;
  step_size: string;
  note: string;
}

/** §9.19:人批 = 一次性确认 token(120 秒)。意图与设置提议共用同一形状 */
export interface ConfirmToken<T = unknown> {
  nonce: string;
  expires_at: number;
  fingerprint: string;
  intent?: { id: string; kind: string; symbol: string; direction: Direction; quantity: string; entry: string; limit_price: string | null; stop_price: string | null; take_profit_price: string | null; backend: Backend };
  proposal?: T;
}

/** §9.19:对话里 set_workflow 改 watchlist/watch_only/timeframe/playbook_text/paused=false/brain* 只到提议;pending 超 30 分钟自动 expired */
export interface WorkflowProposal {
  id: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'applied' | 'rejected' | 'expired';
  via: 'chat';
  session_id: string | null;
  patch: Record<string, unknown>;
  /** patch 各键的现值 / 预演值,diff 卡直接渲染这两个,别自己算 */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  errors: string[];
  resolved_at: number | null;
}

export type IntentStatus = 'pending_approval' | 'approved' | 'rejected' | 'submitted' | 'filled' | 'failed' | 'unknown';

// 演示执行记录(不是 AGENTS.md 里的动钱六件套)
export interface DemoIntent {
  id: string;
  episode_id: string;
  thread_id: string | null; // v2
  principal: 'agent' | 'user'; // v2
  at: number;
  kind: 'open' | 'close' | 'reduce';
  symbol: string;
  direction: Direction;
  quantity: string;
  entry: 'market' | 'limit';
  limit_price: string | null;
  stop_price: string | null;
  take_profit_price: string | null;
  sizing: Sizing;
  status: IntentStatus;
  client_order_id: string | null;
  backend: Backend;
  receipts: unknown[];
  error: string | null;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost_estimate: string;
}

export interface Episode {
  sizing?: Sizing;
  sizing_evidence?: Record<string, unknown>;
  id: string;
  at: number;
  as_of: number;
  symbol: string; // v2
  thread_id: string | null; // v2
  trigger: Trigger;
  strategy_before: { state: StrategyState; version: number };
  evidence: Evidence[];
  context_text: string; // 模型看到的全文
  context_hash: string;
  prompt_version: string;
  model: string;
  judgment: Judgment | null;
  judgment_raw: string | null;
  schema_errors: string[];
  reducer: { from: StrategyState; to: StrategyState; accepted: boolean; reason: string } | null;
  gates: GateResult[];
  intent: DemoIntent | null;
  usage: Usage | null;
  status: 'running' | 'done' | 'failed';
  error: string | null;
  strategy_after: { state: StrategyState; version: number } | null;
  /** v3:判断图上的位置(有则显示,无则忽略)。illegal_action 非空 = 模型第一次输出了该节点不允许的动作(之后被修正或 fail-closed,edge 是最终走的边)。 */
  graph?: { version: string; node: string; edge: string | null; guards: string[]; illegal_action?: string | null };
}

// 列表/时间线用的精简形状——GET /api/episodes 和 episode.finished SSE 都是这个形状,
// 时间线卡片折叠态要显示的字段(reasons/reducer/schema_errors/error/intent)全带着,
// 不用逐条再拉一次 /api/episodes/:id。大字段(evidence 全量 / context_text / 完整
// judgment JSON)只有点开卡片才会去拉 GET /api/episodes/:id。
export interface EpisodeSummary {
  id: string;
  at: number;
  symbol: string;
  thread_id: string | null;
  trigger: Trigger;
  action: Action | null;
  direction: Direction | null;
  headline: string | null;
  confidence: number | null;
  reasons: string[];
  from_state: StrategyState;
  to_state: StrategyState | null;
  reducer: { from: StrategyState; to: StrategyState; accepted: boolean; reason: string } | null;
  schema_errors: string[];
  error: string | null;
  has_intent: boolean;
  intent: DemoIntent | null;
  /** 与 Episode.graph 相同,列表态就能显示「节点 → 边」徽章;老记录为 null。 */
  graph: Episode['graph'] | null;
  status: Episode['status'];
}

export interface PositionView {
  symbol: string;
  side: Direction;
  qty: string;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  leverage: number;
}

export interface OpenOrderView {
  symbol: string; // v2:多币种以后,挂单要带 symbol 才能按线程/币种归属
  client_order_id: string;
  type: string;
  side: string;
  qty: string;
  price: string | null;
  stop_price: string | null;
  reduce_only: boolean;
  status: string;
}

export interface AccountView {
  backend: Backend;
  /** v3.11(§9.15):'unfunded' = 真读到的 0(币安子账户未入金),note 带入金链接;读失败不会产生 AccountView */
  quality?: 'ok' | 'unfunded';
  note?: string | null;
  equity: string;
  available: string;
  unrealized_pnl: string;
  positions: PositionView[];
  open_orders: OpenOrderView[];
  as_of: number;
}

export interface MarketView {
  symbol: string;
  last: string;
  mark: string;
  funding_rate: string;
  next_funding_at: number;
  open_interest: string;
  as_of: number;
  klines_tf: string;
}

export interface LoopView {
  running: boolean;
  paused: boolean;
  halted: boolean;
  every_ms: number;
  next_at: number | null;
  last_episode_id: string | null;
  brain: string; // brain name, e.g. claude:sonnet
  cheap_brain: string; // 信息员大脑名
  backend: Backend;
  auto_approve: boolean;
}

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  data?: unknown;
}

export interface Kline {
  open_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  close_time: number;
}

// ---------------------------------------------------------------------------
// v2(design notes)—— 信息员 / 扫描 / 策略线程 / 对话 / 工作流

export type BrainKind = 'pi' | 'claude' | 'codex' | 'stub';

/** GET /api/brains → { brains: BrainOption[], current: { brain, cheap_brain } } */
export interface BrainOption {
  kind: BrainKind;
  label: string;
  available: boolean; // 配置的启动命令能起得来(直接在 PATH 上,或登录 shell 认识这个词)
  models: string[]; // 推荐模型 id(仍可自由填写);pi 写成 provider/model
  default_model: string | null;
  note: string;
  /** 这个 CLI 的启动命令(Workflow.cli_commands);stub 为 null。老网关没有这个字段。 */
  command?: string | null;
  /** 这条命令怎么起、起不起得来。老网关没有这个字段。 */
  resolved?: CliResolved;
}

/** via: direct = 直接执行;shell = 经登录 shell(别名 / 环境变量前缀才用得上)。 */
export interface CliResolved {
  via: 'direct' | 'shell';
  ok: boolean;
  detail: string;
}

/** 每个 CLI 在这台机器上的启动命令。 */
export interface CliCommands {
  claude: string;
  codex: string;
  pi: string;
}

export interface BrainsResponse {
  brains: BrainOption[];
  current: { brain: string; cheap_brain: string };
  /** 老网关没有这个字段;以 GET /api/workflow 的 cli_commands 为准。 */
  cli_commands?: CliCommands;
}

/** POST /api/brains/test body { kind, model } → BrainTestResult(一次最短往返,可能要 5–60 秒) */
export interface BrainTestResult {
  ok: boolean;
  kind: BrainKind;
  model: string | null;
  name: string;
  latency_ms: number;
  text: string | null;
  error: string | null;
}

/** GET /api/graph → { graph: JudgmentGraph, mermaid: string }(design notes) */
export interface JudgmentGraph {
  version: string;
  nodes: Record<string, { allowed_actions: Action[]; description: string }>;
  model_edges: { id: string; from: string; action: Action; effect: string; guards: string[]; description: string }[];
  event_edges: { id: string; event: TriggerKind; from: ThreadStatus | 'none'; to: string; description: string }[];
  guards: Record<string, { gate_name: string; description: string }>;
}

export interface GraphResponse {
  graph: JudgmentGraph;
  mermaid: string;
}

export interface Workflow {
  watchlist: string[]; // 默认 ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT']
  /** §9.16(14e57a3):watchlist 的子集 = 只观察不交易(判断只能 NO_TRADE/WATCH) */
  watch_only: string[];
  /** §9.16:观察名单上限 1–24(默认 8);每多一个币 = 多一份心跳/收盘判断的模型费 */
  watchlist_max: number;
  timeframe: string; // 扫描/复查用的 K 线周期,默认 '15m'
  info_every_ms: number; // 信息员周期,默认 30 分钟
  risk_pct: string; // 单笔风险 % 权益,默认 '0.5'
  leverage: number; // 默认 3
  margin_mode: 'cross' | 'isolated'; // 默认 cross
  max_open_threads: number; // 默认 3
  max_opens_per_day: number; // 默认 4
  /** 达到当日权益的这个百分比亏损后停止新开仓,默认 '3'(网关侧字段,docs 未列出但已实现)。 */
  daily_loss_stop_pct: string;
  auto_approve: boolean; // agent 的 PROPOSE 是否免确认
  /** §9.19 v3.10.1:对话执行需我确认。默认 false = agent 在对话里 approve_intent 直接批(仍过全部代码闸);true = 只推确认卡走两步 token。只能人改,与 auto_approve 无关。老网关没有 */
  chat_requires_approval?: boolean;
  brain: BrainKind; // 判断/对话用哪家 CLI
  cheap_brain: BrainKind; // 信息员用哪家 CLI
  brain_model: string | null; // 判断/对话模型 id(pi: provider/model;claude: sonnet/opus/haiku 或完整 id;codex: 模型 id);null = 该 CLI 默认
  cheap_brain_model: string | null; // 信息员模型 id;null = 默认
  playbook_text: string; // 可编辑的 playbook 段落
  paused: boolean;
  /** agent 旁白开关(判断结束 / 成交 / 平仓 / 信息员更新时在对话里说一句)。 */
  narrate: boolean;
  // ---- v3(design notes):代码出触发器,模型做判断 ----
  /** triggered = 触发器命中或到心跳才叫模型;every_close = 每根收盘都问(演示用)。 */
  scan_mode: 'triggered' | 'every_close';
  /** 触发器模式下,每个币最久多久问一次模型(5 分钟–4 小时)。 */
  heartbeat_every_ms: number;
  /** 5 分钟内涨跌超过此百分比立刻唤醒(十进制字符串,0.2–5)。 */
  fast_move_pct: string;
  /** 有持仓/挂单的线程是否每根收盘都复查。 */
  review_every_close: boolean;
  // ---- v3.10(gateway 9354d7e,prompt v7):失效确认——失效价越过不再必须离场,只有止损是硬线
  /** 失效价要被连续几根已收盘 K 线越过才算「失效确认」(整数 1–5,默认 2);模型不能改 */
  invalidation_confirm_bars: number;
  /** 越过深度不足这么多 ATR 不算(0–1,默认 0.2);模型不能改 */
  invalidation_buffer_atr: number;
  // ---- v3.3:执行后端 + 每日判断上限(操作台面板 / 费用表)----
  /** 每天最多调多少次判断模型,0 = 不限;到上限后当天不再调模型(聊天不受限)。 */
  daily_judgment_cap: number;
  /** 下单走哪个执行后端;老网关没有这个字段时为 undefined。 */
  execution?: Backend;
  /** execution=agent_mcp 时用哪个 CLI 子进程调币安 MCP。 */
  exec_agent_cli?: 'claude' | 'codex';
  /** execution=agent_mcp 时子进程用的模型;null = 该 CLI 默认。 */
  exec_agent_model?: string | null;
  /**
   * 每个 CLI 在这台机器上怎么启动:裸命令名、路径、带环境变量前缀的一行,或只有交互式 shell 里
   * 才存在的别名(如 claudeproxy)。网关的每一次子进程调用都用它。老网关没有这个字段。
   */
  cli_commands?: CliCommands;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// v3.3:执行后端(操作台)—— GET /api/execution、POST /api/execution/check|connect

export type ExecutionBackend = Backend;

export interface ExecutionOption {
  kind: ExecutionBackend;
  label: string;
  available: boolean;
  note: string;
  /** 09-07:推荐通道(官方 binance-cli);老网关没有 */
  recommended?: boolean;
  /** 不可用时的接入步骤(多行);老网关没有 */
  setup?: string | null;
}

export interface ExecutionAgentView {
  cli: 'claude' | 'codex';
  /** CLI 真正会用的模型(claude 留空时网关按 sonnet 跑),不是「用户填了什么」。 */
  model: string | null;
  /** 老网关没有这个字段:一句话解释这个默认值(如「默认 sonnet,便宜」)。 */
  model_note?: string | null;
  server_name: string;
  url: string;
  /** 这台机器上真正会被执行的启动命令(老网关没有这个字段)。 */
  command?: string;
  resolved?: CliResolved;
}

export type ExecutionConnectionStatus = 'connected' | 'needs_auth' | 'unavailable' | 'unknown';

export interface ExecutionConnection {
  status: ExecutionConnectionStatus;
  checked_at: number | null;
  detail: string;
}

export interface NetCheckResult {
  backend: string;
  started_at: number;
  finished_at: number;
  runs: { ms: number; ok: boolean; transport_error: boolean; error: string | null }[];
  ok: number;
  transport_errors: number;
  other_errors: number;
  avg_ms: number | null;
  verdict: string;
}

export interface TransportHealth {
  window_ms: number;
  runs: number;
  transport_errors: number;
  last_error: string | null;
  last_at: number | null;
}

export interface ProtectionStatusView {
  status: 'not_needed' | 'verified' | 'unverified' | 'verifying' | 'failed';
  verified_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  steps: { name: string; ok: boolean; detail: string | null }[];
  cost_note: string;
  source: 'env' | 'record' | null;
}

export interface ExecutionView {
  backend: ExecutionBackend;
  /** §9.20;老网关没有 */
  protection?: ProtectionStatusView | null;
  /** 09-07:执行通道传输健康(连接被掐/超时次数,30 分钟窗口);老网关没有;null = 后端不统计 */
  transport?: TransportHealth | null;
  options: ExecutionOption[];
  agent: ExecutionAgentView;
  connection: ExecutionConnection;
  can_switch: boolean;
  switch_blocker: string | null;
  /** v3.11:上次账户读取失败(读成功后清空);非空 → 「执行通道账户不可读」 */
  account_read_error?: { at: number; message: string } | null;
  /** v3.11:false → 「币安子账户未入金」;null = 未知 */
  account_funded?: boolean | null;
}

/**
 * POST /api/execution/connect。
 * - started=true = 网关已经弹了一个终端窗口跑交互式 `claude "/mcp"`,用户在里面选
 *   binance-mcp-server → Authenticate;
 * - started=false = 弹不出来(非 macOS 等),把 instructions 显示给用户自己去终端跑。
 */
export interface ExecutionConnectResponse {
  started: boolean;
  instructions: string;
  url?: string;
}

export interface UsageToday {
  judgments: number;
  input_tokens: number;
  output_tokens: number;
  est_cny: number | null;
  cap: number;
  capped: boolean;
}

export interface InformationEvent {
  id: string;
  kind: 'news' | 'market_snapshot' | 'sentiment';
  source: string;
  source_ref: string;
  occurred_at: number;
  observed_at: number;
  ingested_at: number;
  dedupe_key: string;
  title: string;
  digest: string;
  assets: string[];
}

export type Regime = 'trend_up' | 'trend_down' | 'range' | 'volatile' | 'unclear';

export interface MarketState {
  id: string;
  as_of: number;
  model: string;
  regime: Regime;
  bias: 'long' | 'short' | 'neutral';
  summary: string;
  key_points: string[];
  majors: {
    symbol: string;
    last: string;
    change_24h_pct: string;
    funding_rate: string;
    oi_change_1h_pct: string | null;
    long_short_ratio: string | null;
    taker_buy_sell_ratio: string | null;
  }[];
  sentiment: { fng: number | null; fng_label: string | null };
  top_movers: { symbol: string; change_24h_pct: string; quote_volume: string }[];
  /** 4916e8a:event_id = InformationEvent.id;url = 原文链接(非 http 或非 news 事件为 null);ref 只是引用编号 */
  /** e737564:source_label 给人看(如 PANews),旧快照网关读出时按 source 回填,未知源 = source */
  news: { ref: string; event_id?: string | null; url?: string | null; title: string; source: string; source_label?: string; published_at: number; relevance: 'high' | 'medium' | 'low'; digest: string }[];
  candidates: { symbol: string; direction: Direction; why: string }[];
  risk_events: string[];
  info_refs: string[];
  usage: Usage | null;
  error: string | null;
}

export type ThreadStatus = 'pending_entry' | 'in_position' | 'closed' | 'canceled' | 'invalidated';
export type ThreadSource = 'agent' | 'manual' | 'chat';

export interface StrategyThread {
  id: string;
  symbol: string;
  side: Direction;
  status: ThreadStatus;
  source: ThreadSource;
  timeframe: string;
  thesis: string;
  invalidation_text: string | null;
  watch_conditions: string[];
  entry: { type: 'market' | 'limit'; price: string | null; zone: [string, string] | null };
  stop_price: string | null;
  take_profits: string[]; // 多 TP:第一个先挂,其余记录
  qty: string;
  margin_usdt: string | null;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  entry_client_order_id: string | null;
  protection_client_order_ids: string[];
  filled_avg_price: string | null;
  realized_pnl: string | null;
  close_reason: string | null;
  /** 机器可读的"需要人看一眼"标记,如 PROTECTION_MISSING / ORDER_UNKNOWN / EXTERNAL_ACTIVITY;正常为 null。 */
  attention: string | null;
  episode_ids: string[];
  intent_ids: string[];
  created_at: number;
  updated_at: number;
  opened_at: number | null;
  closed_at: number | null;
  version: number;
}

export interface ChatToolCall {
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
}

export interface ChatMessage {
  id: string;
  at: number;
  role: 'user' | 'agent' | 'tool' | 'system';
  text: string;
  tool_calls: ChatToolCall[];
  episode_id: string | null;
  /** v3:chat = 对话;narration = agent 旁白(动态)。旧数据可能没有,前端按 `旁白 · ` 前缀兜底。 */
  kind?: 'chat' | 'narration';
  /** v3.8:属于哪个会话;旁白没有 */
  session_id?: string | null;
}

export type EpisodeStep = 'fetching' | 'context' | 'thinking' | 'validating' | 'gating' | 'executing' | 'done';

export interface QueueView {
  pending: number;
  running: { kind: string; symbol: string | null; step?: EpisodeStep | null; episode_id?: string | null } | null;
}

export interface ManualOrderRequest {
  symbol: string;
  side: Direction;
  action: 'open' | 'close';
  type: 'market' | 'limit';
  price?: string | null;
  margin_usdt?: string | null;
  leverage?: number | null;
  qty?: string | null;
  tp?: string | null;
  sl?: string | null;
  margin_mode?: 'cross' | 'isolated' | null;
}

export interface SymbolInfo {
  symbol: string;
  status: string;
  price_precision: number;
  qty_precision: number;
  step_size: string;
  tick_size: string;
  min_qty: string;
  min_notional: string;
}

// ---------------------------------------------------------------------------
// 下面这些是纯前端的"响应信封"形状:v1/v2 文档只描述了字段列表或散在端点描述里,
// 没有逐字给出 wrapper 的样子。网关那边尚未接线 v2 HTTP 路由(2026-09-03 现状),
// 这里按 v2-agent-loop.md §3 的端点表 + 网关 types.ts 已有的领域对象自己拼的合理形状,
// 已经在 mock/server.mjs 里对应实现。如果网关落地时形状不一样,回来改这个文件
// (对齐面板会用注释标出"这是我们定的,不是网关确认的")。

export interface Overview {
  loop: LoopView;
  strategy: Strategy;
  /** 账户读失败(agent_mcp 未就绪等)时网关给 null,不是 unfunded */
  account: AccountView | null;
  market: MarketView;
  recent_episodes: EpisodeSummary[];
  // v2 增量(README v2 §3):workflow / market_state(最新) / threads(非终态) /
  // markets(watchlist 逐个 MarketView) / queue。
  workflow: Workflow;
  market_state: MarketState | null;
  threads: StrategyThread[];
  markets: Record<string, MarketView>;
  queue: QueueView;
  /** v3.3:今日模型用量与花费(老网关没有这个字段,前端按缺省处理)。 */
  usage_today?: UsageToday;
}

export type StrategyWithRevisions = Strategy & { revisions: StrategyRevision[] };

export interface KlinesResponse {
  symbol?: string;
  tf: string;
  klines: Kline[];
}

/**
 * GET /api/market/indicators(design notes)。
 *
 * 每条 series 的点都带 `t`(该根 K 线的开盘时间,**毫秒**,不是 lightweight-charts 要的秒),
 * 其余字段随指标而异:标量指标是 `v`,布林是 mid/upper/lower/width_pct,唐奇安是 upper/lower/mid,
 * 超级趋势是 value + dir(1/-1),MACD 是 macd/signal/hist,ADX 是 adx/plus_di/minus_di,KD 是 k/d。
 * 网关只发"已经算出来的"点(预热期的 NaN 直接不发),所以各条 series 的长度可以不一样,
 * 前端必须按 t 对齐,不能按下标对齐。
 */
export type IndicatorPoint = { t: number } & Record<string, number | boolean>;

/** 指标快照:最后一根已收盘 K 线上的所有指标值。字段全是可选的——网关侧预热不够时给 null。 */
export interface IndicatorSnapshot {
  tf: string;
  bars: number;
  last_open_time: number;
  last_close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: { macd: number; signal: number; hist: number } | null;
  bb: { mid: number; upper: number; lower: number; width_pct: number } | null;
  atr14: number | null;
  atr_pct: number | null;
  atr_pct_rank_90: number | null;
  bb_width_rank_90: number | null;
  adx14: { adx: number; plus_di: number; minus_di: number } | null;
  vwap_day: number | null;
  dist_to_vwap_atr: number | null;
  squeeze: { on: boolean; bars_on: number } | null;
  supertrend: { value: number; dir: 1 | -1 } | null;
  trend: 'up' | 'down' | 'flat';
  trend_strength: 'none' | 'weak' | 'moderate' | 'strong';
  /** 其余 20 多个指标(stoch / cci / mfi / aroon / ichimoku …)按名取,形状见 design notes。 */
  [key: string]: unknown;
}

export interface IndicatorsResponse {
  symbol: string;
  interval: string;
  bars: number;
  klines_from: number;
  klines_to: number;
  sets: string[];
  /** 请求里写错的 set 名会原样回来,而不是被静默丢掉。 */
  unknown_sets: string[];
  /** sets 里该画在主图价格轴上的那些(其余的要单独一个副窗)。 */
  overlay: string[];
  series: Record<string, IndicatorPoint[]>;
  snapshot: IndicatorSnapshot | null;
  /** describeIndicators() 的一行中文摘要,可直接展示。 */
  text: string;
  volume_profile: { poc: number; vah: number; val: number } | null;
}

/** GET /api/market/indicators/sets:让 UI 不用把指标名写死。 */
export interface IndicatorSetsResponse {
  sets: string[];
  overlay: string[];
  defaults: string[];
}

export interface LogsResponse {
  logs: LogEntry[];
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface SettingsPayload {
  auto_approve?: boolean;
  every_ms?: number;
}

// POST /api/workflow 是"应用后返回"(网关 applyWorkflowPatch 会把越界值 clamp 到合法
// 区间,不是硬拒绝),所以带 errors 让 UI 显示"这些字段被自动纠正了",而不是 4xx。
// 我们定的形状:GET 返回裸 Workflow,POST 返回 { workflow, errors }。
export interface WorkflowPatchResponse {
  workflow: Workflow;
  errors: string[];
}

export interface InfoRunNowResponse {
  job_id: string;
}

export interface InfoEventsResponse {
  events: InformationEvent[];
}

export interface MarketStateHistoryResponse {
  history: MarketState[];
}

/**
 * 信息源采集状态(v3-ui-contract §9.17,gateway a1c2eca+09438cd):固定五源、只读、无增删改。
 * name = MarketState.news[].source;进程重启后信息员没跑过时四个可空字段全是 null(状态在进程内)。
 */
export interface InfoSource {
  name: string;
  label: string;
  url: string;
  lang: 'en' | 'zh';
  /** 媒体 6,美联储 72 */
  max_age_hours: number;
  last_fetch_at: number | null;
  last_status: 'ok' | 'error' | null;
  /** 只有 error 时有值 */
  last_error: string | null;
  /** 抓到的原始条数(时效窗内、去重前);失败时 null;周末英文媒体常常 ok 但 0 条,不是失败 */
  item_count: number | null;
  /** e737564:跨源去重 + 总量 25 之后真正进入本轮登记的条数;没跑过或失败 → null */
  used_count: number | null;
}

export interface InfoSourcesResponse {
  sources: InfoSource[];
}

export interface ScanNowRequest {
  symbol?: string;
}

export interface ScanNowResponse {
  job_ids: string[];
}

export interface ThreadsResponse {
  threads: StrategyThread[];
}

export interface ThreadDetailResponse {
  thread: StrategyThread;
  episodes: EpisodeSummary[];
  intents: DemoIntent[];
}

export interface ManualOrderResponse {
  thread: StrategyThread;
  intent: DemoIntent;
}

export interface OpenOrdersResponse {
  open_orders: OpenOrderView[];
  as_of: number;
}

export interface PositionsResponse {
  positions: PositionView[];
  as_of: number;
}

export interface SymbolsResponse {
  symbols: SymbolInfo[];
}

export interface ChatMessagesResponse {
  messages: ChatMessage[];
  /** v3.8:传了 session 参数时回显 */
  session?: string;
}

/** v3.8(v3-ui-contract §9.14):对话会话。default 不能删只能清空;can_execute 默认关,只有用户在会话头上开 */
export interface ChatSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: boolean;
  can_execute: boolean;
  message_count: number;
  last_text: string | null;
}

export interface ChatSessionsResponse {
  sessions: ChatSession[];
}

export interface ChatSendResponse {
  accepted: boolean;
}

// ---------------------------------------------------------------------------
// v3(design notes):活动流 / 交易历史 / 行情状态

export type ActivityKind =
  | 'proposal'
  | 'proposal_blocked'
  | 'approval_needed'
  | 'approved'
  | 'rejected'
  | 'thread_opened'
  | 'entry_filled'
  | 'protection_placed'
  | 'tp_hit'
  | 'sl_hit'
  | 'thread_closed'
  | 'thread_canceled'
  | 'thread_invalidated'
  | 'attention'
  | 'attention_cleared'
  | 'manual_order'
  | 'chat_action'
  | 'trigger'
  | 'info_update'
  | 'brain_error'
  | 'halt'
  | 'resume'
  | 'paused'
  | 'resumed'
  | 'workflow_changed'
  // v3.6:雷达筛选(网关 src/demo/screener.ts)
  | 'screen_done'
  | 'screen_failed';

export interface ActivityItem {
  id: string;
  at: number;
  kind: ActivityKind;
  level: 'info' | 'success' | 'warn' | 'danger';
  symbol: string | null;
  thread_id: string | null;
  episode_id: string | null;
  title: string;
  detail: string | null;
  data: Record<string, unknown>;
}

export interface ActivityResponse {
  activity: ActivityItem[];
}

export interface HistoryStatsBucket {
  count: number;
  wins?: number;
  pnl: string;
}

export interface HistoryStats {
  count: number;
  wins: number;
  losses: number;
  flat: number;
  win_rate: number;
  total_pnl: string;
  avg_pnl: string;
  avg_hold_ms: number;
  profit_factor: number | null;
  best: { thread_id: string; symbol: string; pnl: string } | null;
  worst: { thread_id: string; symbol: string; pnl: string } | null;
  by_symbol: ({ symbol: string } & HistoryStatsBucket)[];
  by_source: ({ source: ThreadSource } & HistoryStatsBucket)[];
  by_close_reason: ({ reason: string } & HistoryStatsBucket)[];
}

export type HistoryThread = StrategyThread & {
  hold_ms: number;
  pnl_num: number;
  exit_price: string | null;
  episode_count: number;
  r_multiple: number | null;
};

export interface EquityPoint {
  at: number;
  equity: number;
  unrealized: number;
  /** fc86c0b:所属执行通道;GET /api/history 默认只回当前通道 */
  backend?: Backend;
}

export interface HistoryResponse {
  stats: HistoryStats;
  threads: HistoryThread[];
  equity: EquityPoint[];
}

export type DailyRegime = 'bull' | 'bear' | 'range' | 'volatile';
export type SessionName = 'us_open_window' | 'us' | 'london' | 'asia' | 'weekend' | 'off';

export interface RegimeResponse {
  symbol: string;
  as_of: number;
  daily: {
    regime: DailyRegime;
    ema_stack: string;
    ret_20d_pct: number;
    vol_pct_rank: number;
    atr_pct: number;
    text: string;
  };
  session: {
    name: SessionName;
    text: string;
    minutes_to_us_open: number | null;
  };
}

// SSE event → payload 类型映射,给 client.ts 的订阅器用
export interface ServerEventMap {
  'loop.state': LoopView;
  'episode.started': { id: string; trigger: Trigger };
  'episode.progress': { step: EpisodeStep; episode_id: string | null; at: number };
  'episode.finished': EpisodeSummary;
  'strategy.changed': Strategy;
  'intent.changed': DemoIntent;
  'account.updated': AccountView;
  'market.tick': MarketView;
  log: LogEntry;
  // v2
  'market_state.updated': MarketState;
  'thread.changed': StrategyThread;
  'chat.message': ChatMessage;
  'queue.state': QueueView;
  'workflow.changed': Workflow;
  /** §9.19 设置提议状态变化 */
  'workflow.proposal': { id: string; status: WorkflowProposal['status']; keys: string[] };
  // v3
  activity: ActivityItem;
  // v3.3:执行后端 / MCP 连接状态变了(切后端、检查连接、OAuth 回调),前端失效 ['execution']
  'execution.changed': Partial<ExecutionView>;
}

// ---------------------------------------------------------------------------
// v3.4 回放与盲测(design notes;design notes)
//
// 盲测 = 逐根 K 线重放历史,每次判断只喂当时可见的数据(close_time ≤ 该根收盘)给线上同一套
// buildContext + 契约 + 代码闸。判断要花钱(GLM-5.3 ≈ ¥0.006/次),所以前端**必须**先 estimate、
// 弹确认框把 ¥ 念一遍,再 POST /api/backtest。

export type BacktestMode = 'triggers' | 'every_close';
export type BacktestStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BacktestParams {
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  mode: BacktestMode;
  max_judgments: number;
  review_every_close: boolean;
  brain: BrainKind;
  brain_model: string | null;
  horizon_bars: number;
  risk_pct: number;
  max_opens_per_day: number;
}

export interface BacktestProgress {
  done: number;
  total: number;
  last_action: string | null;
  at: number;
}

export interface BacktestCost {
  input_tokens: number;
  output_tokens: number;
  /** 订阅制大脑(claude/codex)没有单价 → null,前端显示「订阅额度,不计费」。 */
  cny: number | null;
}

export interface BacktestTrade {
  step_idx: number;
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: number | null;
  proposed_at: number;
  fill_at: number | null;
  fill_price: number | null;
  stop: number;
  tp: number | null;
  exit_at: number | null;
  exit_price: number | null;
  status: 'stop' | 'tp' | 'review_exit' | 'expired' | 'unfilled' | 'open';
  close_reason: string;
  r: number | null;
  mae_r: number | null;
  mfe_r: number | null;
  bars_held: number | null;
  reduced_fraction: number;
  reduced_r: number | null;
}

export interface BacktestSummary {
  judgments: number;
  scans: number;
  reviews: number;
  actions: Record<string, number>;
  trades: number;
  wins: number;
  losses: number;
  flat: number;
  win_rate: number | null;
  avg_r: number | null;
  sum_r: number;
  max_drawdown_r: number;
  avg_hold_bars: number | null;
  cost: BacktestCost;
  model: string;
  missed_move: { samples: number; avg_atr: number; max_atr: number } | null;
  bars: number;
  candidates: number;
  capped: boolean;
  trade_rows: BacktestTrade[];
}

export interface BacktestRun {
  id: string;
  created_at: number;
  symbol: string;
  timeframe: string;
  from_ms: number;
  to_ms: number;
  mode: BacktestMode;
  status: BacktestStatus;
  params: BacktestParams;
  brain: string;
  prompt_version: string;
  progress: BacktestProgress | null;
  summary: BacktestSummary | null;
  error: string | null;
}

export interface BacktestStepOutcome {
  kind: 'opened' | 'blocked' | 'closed' | 'reduced' | 'none';
  detail: string;
  trade_step_idx?: number;
  r?: number | null;
  missed_move_atr?: number | null;
}

export interface BacktestStep {
  run_id: string;
  idx: number;
  /** 判断发生在这根 K 线的收盘时刻。 */
  at_ms: number;
  kind: 'scan' | 'review';
  trigger: string | null;
  /** 盲测边界:上下文里没有任何 close_time 大于它的 K 线。 */
  visible_upto_ms: number;
  judgment: Judgment | null;
  action: string | null;
  direction: Direction | null;
  confidence: number | null;
  gates: GateResult[];
  outcome: BacktestStepOutcome | null;
  cost: BacktestCost | null;
  error: string | null;
}

/** GET /api/backtest/estimate?symbol&timeframe&from&to&mode&max_judgments */
export interface BacktestEstimate {
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  mode: BacktestMode;
  bars: number;
  candidates: number;
  per_judgment_cny: number | null;
  est_cny: number | null;
  max_cny: number | null;
  model: string;
  note: string;
}

/** GET /api/backtest */
export interface BacktestListResponse {
  runs: BacktestRun[];
  running: string | null;
}

/** GET /api/backtest/:id */
export interface BacktestDetailResponse {
  run: BacktestRun;
  steps: BacktestStep[];
  trades: BacktestTrade[];
}

/** POST /api/backtest → 202 { run, error }(已有回测在跑时 409 + error 文案) */
export interface BacktestStartResponse {
  run: BacktestRun;
  error: string | null;
}

/** GET /api/market/klines/history?symbol&interval&from&to(单页 ≤ 1500 根,磁盘缓存) */
export interface KlinesHistoryResponse {
  symbol: string;
  interval: string;
  /** 实际返回的最早时刻——请求超过 max_bars 时会被网关往回截。 */
  from: number;
  to: number;
  /** 前端原本要的 from(未截断)。 */
  requested_from: number;
  klines: Kline[];
  /** false = 撞到单次上限,还能继续往前要。 */
  complete: boolean;
  max_bars: number;
}

/**
 * SSE 补两个事件(接口合并进上面的 ServerEventMap,不动原声明):
 * `backtest.progress` 走进度条,`backtest.changed` 失效 ['backtest'] 与 ['backtest', id]。
 */
export interface ServerEventMap {
  'backtest.progress': { run_id: string; done: number; total: number; last_action: string | null; at: number };
  'backtest.changed': BacktestRun;
}

// ---------------------------------------------------------------------------
// v3.5 策略库 + 回测归因(design notes)
//
// 一条策略是**不可变的版本化对象**:触发(哪些事件才唤醒它)+ 清单(代码必须能算出来的证据)+
// 规则(模型只能在这些边里选)+ 参数(带范围,改一个就是新版本 + 新 hash)+ 评测统计。
// 红线:界面上没有「直接改一个在跑的策略的数字」这条路——改参数 = 生成一个 draft 新版本;
// 上线 = 一格一格晋升,而且 paper → live_capped 必须人工输入确认。归因只提议,永不自动落地。

/** 晋升只能沿 draft → backtest → shadow → paper → live_capped 一格一格走;retired 随时可去,不可回。 */
export type StrategyStatus = 'draft' | 'backtest' | 'shadow' | 'paper' | 'live_capped' | 'retired';

export type StrategyFamily = 'trend_continuation' | 'mtf' | 'volatility' | 'derivatives' | 'mean_reversion';

/** 一个可调参数:值 + 允许区间;新值必须落在 [min,max] 内,否则网关拒。 */
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
  /** 单次回测的噪声提示(一两笔亏损说明不了问题),有就原样显示。 */
  noise_note: string | null;
}

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
    kinds: string[];
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
  created_at: number;
  parent_version?: number | null;
}

/** GET /api/strategies 与 /api/strategies/:id 返回的是加了这几个展示字段的 spec。 */
export interface StrategyView extends StrategySpec {
  family_label: string;
  status_label: string;
  /** 下一格状态;null = 已经在最高状态或已退役。 */
  next_status: StrategyStatus | null;
  /** null = 可以晋升;非 null = 为什么还不能(直接显示这句中文)。 */
  promote_blocked: string | null;
  /** 是否挂在 workflow.active_strategies 里(实盘启用)。 */
  active: boolean;
}

/** GET /api/strategies?include_retired=1 */
export interface StrategiesResponse {
  strategies: StrategyView[];
  active: string[];
  statuses: StrategyStatus[];
  status_labels: Record<StrategyStatus, string>;
  family_labels: Record<StrategyFamily, string>;
}

/** GET /api/strategies/:id */
export interface StrategyDetailResponse {
  strategy: StrategyView;
  versions: StrategySpec[];
  attributions: AttributionPoint[];
}

/** POST /api/strategies/active { ids } —— 只有 ≥ paper 的能进实盘,否则 400。 */
export interface StrategyActiveResponse {
  active: string[];
  workflow: Workflow;
}

/** POST /api/strategies/:id/propose-version → 201;/promote → 200(闸不过是 409);/retire → 200 */
export interface StrategyMutationResponse {
  strategy: StrategyView;
}

export interface StrategyRetireResponse {
  strategy: StrategyView;
  active: string[];
}

export type AttributionKind = 'rule_wording' | 'param' | 'checklist_item';

export interface AttributionProposal {
  kind: AttributionKind;
  strategy_id: string | null;
  /** kind='param' 时:参数名与提议值(必须落在该参数的 [min,max] 内)。 */
  param?: string | null;
  value?: number | null;
  /** kind='rule_wording' / 'checklist_item' 时:提议的新措辞 / 新清单项。 */
  text: string;
}

/** 一个「问题点位」:证据当时显示了什么、规则当时说了什么、实际发生了什么、提议怎么改。 */
export interface AttributionPoint {
  id: string;
  run_id: string;
  at: number;
  strategy_id: string | null;
  symbol: string | null;
  kind: AttributionKind;
  title: string;
  evidence_said: string;
  rule_said: string;
  actual: string;
  proposal: AttributionProposal;
  /** 人点了「采纳为新版本」后落在哪个版本上;null = 还没采纳。 */
  applied_version: number | null;
}

/** GET /api/backtest/:id/attribution */
export interface BacktestAttributionResponse {
  points: AttributionPoint[];
}

/** POST /api/backtest/:id/attribute —— 调便宜大脑,**会花钱**;回测没跑完是 409。 */
export interface BacktestAttributeResponse {
  points: AttributionPoint[];
  error: string | null;
  /** true = 之前已经跑过,这次直接给旧结果,没再花钱。 */
  cached: boolean;
}

/** 按 strategy_id 拆开的成交统计;key `unattributed` 收模型没标注策略的那些成交。 */
export interface StrategyBreakdown {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  expectancy_r: number | null;
  sum_r: number;
  /** MAE 中位数,单位 R(负数);没有成交报过就是 null。 */
  mae_r_p50: number | null;
  /** 这条策略被点名的判断次数(不管有没有 PROPOSE)。 */
  proposals: number;
}

/**
 * v3.5 给回测契约补的字段(接口合并进上面的原声明,不动原声明):
 * 汇总多了「这次用哪几条策略」与按策略拆的战绩,估算多了按策略拆的候选数,
 * 成交/步骤各多一个 strategy_id(模型判断时点的名,可能为 null)。
 */
export interface BacktestSummary {
  /** 这次回测用的策略(id@version + hash,所以一份汇总永远说得清它测的是哪份内容)。 */
  strategies: { id: string; version: number; content_hash: string; status: string }[];
  by_strategy: Record<string, StrategyBreakdown>;
}

export interface BacktestEstimate {
  /** 每条策略自己的触发集合会唤醒多少根候选 K 线。 */
  candidates_by_strategy: Record<string, number>;
}

export interface BacktestParams {
  /** 这次回测拿哪几条策略去判断;缺省 = workflow.active_strategies。回测**允许**点名 backtest/shadow 状态的策略。 */
  strategy_ids: string[];
  /** 走完之后顺手跑一遍便宜大脑归因。 */
  attribute: boolean;
}

export interface BacktestTrade {
  /** 开这笔的那次判断点的策略名;null = 回测没带策略 / 模型没标。 */
  strategy_id: string | null;
}

export interface BacktestStep {
  /** 这次判断点名的策略(实践中只有 PROPOSE 会有)。 */
  strategy_id: string | null;
}

// ---------------------------------------------------------------------------
// v3.6 雷达 / 筛选器(逐字对齐网关 packages/gateway/src/demo/screener.ts 与 bots.ts;
// 契约变了先改网关那边,再同步这里)。
//
// 一次筛选 = 一行 ScreenRow(状态机 running → done/failed)+ 若干张 WatchCandidate
// (每张里嵌一整张 OpportunityCard)。提案只改 workflow.watchlist 一个字段,
// 而且默认是 propose:界面必须先给出 before → after 的 diff 再让人确认。

export type ScreenHorizon = 'short' | 'swing' | 'weekly';
export type ScreenUniverse = 'watchlist+whitelist' | 'top_volume' | 'explicit';
export type ScreenApplyMode = 'propose' | 'auto';
export type ScreenStatus = 'running' | 'done' | 'failed';

export interface FitCondition {
  key: string;
  label: string;
  pass: boolean;
  /** 差一点点就过(阈值放宽 ~25% 就成立);算半分。 */
  near: boolean;
  detail: string;
}

export interface FitExpectancy {
  days: number;
  setups: number;
  per_week: number;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
}

export interface StrategyFit {
  strategy_id: string;
  name: string;
  version: number;
  status: string;
  /** 0..1:通过的条件数 +(差一点的 × 0.5)÷ 条件总数。纯代码。 */
  fit_score: number;
  passed: number;
  near: number;
  total: number;
  direction: Direction | null;
  conditions: FitCondition[];
  reasons: string[];
  expectancy: FitExpectancy | null;
  expectancy_note: string | null;
}

export interface OpportunityCard {
  symbol: string;
  horizon: ScreenHorizon;
  timeframe: string;
  confirm_timeframe: string;
  as_of: number;
  bars: number;
  last_close: number | null;
  trend: {
    base_dir: Direction | null;
    confirm_dir: Direction | null;
    agree: Direction | null;
    adx_base: number | null;
    adx_confirm: number | null;
    note: string;
  };
  atr_pct: number | null;
  atr_pct_rank_90: number | null;
  bb_width_rank_90: number | null;
  squeeze_on: boolean | null;
  squeeze_bars: number | null;
  breakout: {
    level_long: number | null;
    level_short: number | null;
    dist_long_atr: number | null;
    dist_short_atr: number | null;
    bars_since_up: number;
    bars_since_down: number;
    vol_ratio: number | null;
  };
  funding: { rate_pct: number | null; z_30d: number | null; samples: number };
  reversion: { text: string; best_prob: number | null; best_k: number | null; best_horizon: number | null } | null;
  daily_regime: string | null;
  volume: { quote_24h: number | null; rank: number | null; of: number };
  strategies: StrategyFit[];
  best: { strategy_id: string; fit_score: number } | null;
  note: string | null;
}

export interface WatchCandidate {
  screen_id: string;
  horizon: ScreenHorizon;
  symbol: string;
  strategy_id: string;
  fit_score: number;
  rank: number;
  /** 一行行的理由;以「模型:」开头的那条是**不可信的模型自由文本**,界面上必须标出来。 */
  reasons: string[];
  card: OpportunityCard;
  ttl_at: number;
  created_at: number;
}

export interface WatchlistProposal {
  /** 建议观察的币,已按名次截到 K 个。 */
  symbols: string[];
  /** 每个币建议启用哪几条策略(仅供参考:应用时不写 active_strategies)。 */
  active_strategies: Record<string, string[]>;
  k: number;
  note: string;
}

export interface BrainLine {
  symbol: string;
  strategy_id: string;
  why: string;
}

export interface ScreenBrainPass {
  used: boolean;
  model: string | null;
  cost_cny: number | null;
  error: string | null;
  ranked: BrainLine[];
  dropped_lines: number;
}

export interface ScreenRow {
  id: string;
  horizon: ScreenHorizon;
  started_at: number;
  finished_at: number | null;
  status: ScreenStatus;
  universe: ScreenUniverse;
  symbols: string[];
  errors: { symbol: string; error: string }[];
  run_id: string | null;
  handoff_id: string | null;
  proposal: WatchlistProposal | null;
  brain: ScreenBrainPass | null;
  cost_cny: number;
  error: string | null;
}

export interface ScreenSchedule {
  horizon: ScreenHorizon;
  label: string;
  every_ms: number;
  last_at: number | null;
  next_at: number | null;
  running: boolean;
  enabled: boolean;
}

/** GET /api/screener/latest?horizon= */
export interface ScreenerLatestResponse {
  horizon: ScreenHorizon;
  screen: ScreenRow | null;
  candidates: WatchCandidate[];
  schedule: ScreenSchedule[];
  watchlist: string[];
  watchlist_max: number;
  horizons: { id: ScreenHorizon; label: string }[];
}

/** GET /api/screener/history?horizon=&limit= */
export interface ScreenerHistoryResponse {
  screens: ScreenRow[];
}

/** GET /api/screener/:id */
export interface ScreenerDetailResponse {
  screen: ScreenRow;
  candidates: WatchCandidate[];
}

/** POST /api/screener/run → 202 */
export interface ScreenerRunResponse {
  screen_id: string;
  horizon: ScreenHorizon;
}

/** POST /api/screener/:id/apply —— 只动 workflow.watchlist 一个字段。 */
export interface ScreenerApplyResponse {
  workflow: Workflow;
  before: string[];
  after: string[];
}

/**
 * v3.6 的 workflow 新字段。老网关没有这些字段时全是 undefined,界面按默认值兜底
 * (和 v3.3 的 execution?/cli_commands? 同一套写法)。周线周期固定 7d,不是字段。
 */
export interface Workflow {
  screener_enabled?: boolean;
  screener_short_every_ms?: number;
  screener_swing_every_ms?: number;
  screener_universe?: ScreenUniverse;
  screener_symbols?: string[];
  /** 「观察列表 + 白名单」里的白名单,可编辑;老网关没有这个字段。 */
  screener_whitelist?: string[];
  /** 1–300。 */
  screener_max_symbols?: number;
  screener_use_brain?: boolean;
  screener_apply?: ScreenApplyMode;
  screener_expectancy?: boolean;
}

/** v3.6 SSE(合并进上面的 ServerEventMap,不动原声明)。 */
export interface ServerEventMap {
  'screener.changed': { screen_id: string; horizon: ScreenHorizon; status: ScreenStatus; done?: number; total?: number };
}
