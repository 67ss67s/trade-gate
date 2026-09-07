// Demo runtime domain types — design notes (kept in sync by hand; the WebUI copies
// these verbatim). Amounts are decimal strings, timestamps unix ms.

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
 * Execution backend. `paper` = in-process simulator; `demo` = the Rust tswarm-demo-exec child;
 * `cli` = the official binance-cli (Agent OS channel); `agent_mcp` = an agent CLI driving Binance's
 * official MCP server (execution-agent.ts); `mcp` = the gateway itself calling that same MCP server
 * over its own OAuth token, through a human-confirmed tool map (execution-mcp.ts) — no model at all.
 */
export type Backend = 'paper' | 'demo' | 'cli' | 'agent_mcp';

export const ACTIONS: readonly Action[] = ['NO_TRADE', 'WATCH', 'PROPOSE', 'HOLD', 'ADD', 'REDUCE', 'EXIT', 'INVALIDATE'];

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
  entry_zone: [string, string] | null;
  stop_price: string;
  take_profit_price: string | null;
  take_profits: string[];
  rationale: string;
}

export interface Judgment {
  action: Action;
  direction: Direction | null;
  confidence: number;
  headline: string;
  thesis: string;
  reasons: string[];
  evidence_refs: string[];
  invalidation: string | null;
  invalidation_price: string | null;
  target_price: string | null;
  watch_conditions: string[];
  proposal: Proposal | null;
  /**
   * v3.5 strategy library: which strategy this judgment followed. Required on a PROPOSE whenever the context
   * listed active strategies (schema.ts validates it against that set); null/absent otherwise.
   */
  strategy_id?: string | null;
}

export type TriggerKind =
  | 'kline_close'
  | 'manual'
  | 'schedule'
  | 'monitor'
  | 'position_review'
  | 'scan'
  | 'info_update'
  | 'order_filled'
  | 'tp_hit'
  | 'sl_hit'
  | 'thread_review'
  | 'chat'
  // v3 code triggers (design notes): the model is only woken when one of these fires or a heartbeat is due.
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


export interface Sizing {
  equity: string;
  risk_pct: string;
  risk_usdt: string;
  stop_distance: string;
  raw_qty: string;
  step_size: string;
  note: string;
}

export type IntentStatus = 'pending_approval' | 'approved' | 'rejected' | 'submitted' | 'filled' | 'failed' | 'unknown';

export interface DemoIntent {
  id: string;
  episode_id: string;
  thread_id: string | null;
  principal: 'agent' | 'user';
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
  symbol: string;
  thread_id: string | null;
  trigger: Trigger;
  strategy_before: { state: StrategyState; version: number };
  evidence: Evidence[];
  context_text: string;
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
  /**
   * Judgment-graph position (design notes); absent on episodes written before v3.
   * `edge` = model edge id finally taken (null only if even the fail-closed action has no edge, which the graph forbids);
   * `illegal_action` = the FIRST action the model output when it was not an allowed edge at `node` (repaired or
   * fail-closed afterwards), null when the first output was legal; `guards` = guard ids evaluated on that edge.
   */
  graph?: { version: string; node: string; edge: string | null; guards: string[]; illegal_action?: string | null };
  /** v3.2: memory ids injected into this context (as 记忆 evidence) and the subset the judgment actually cited. */
  memory?: { injected: string[]; cited: string[] };
}

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
  from_state: StrategyState;
  to_state: StrategyState | null;
  has_intent: boolean;
  status: Episode['status'];
  // Always-visible card content (so the timeline needn't fetch every episode's detail).
  reasons: string[];
  reducer: Episode['reducer'];
  schema_errors: string[];
  error: string | null;
  intent: DemoIntent | null;
  /** Judgment-graph position (same as Episode.graph) so the timeline can badge node → edge without fetching detail. */
  graph: Episode['graph'] | null;
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
  symbol: string;
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
  equity: string;
  available: string;
  unrealized_pnl: string;
  positions: PositionView[];
  open_orders: OpenOrderView[];
  as_of: number;
  /** v3.8:读取成功但账户没钱(权益 0、无持仓)→ 'unfunded';其余 'ok'。读取失败不会产生 AccountView(runtime 保留上一份并记 account_read_error)。 */
  quality?: 'ok' | 'unfunded';
  note?: string | null;
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
  brain: string;
  /** Information officer's brain name (kind:model). */
  cheap_brain: string;
  backend: Backend;
  auto_approve: boolean;
}

export interface LogLine {
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

export function summarize(ep: Episode): EpisodeSummary {
  return {
    id: ep.id,
    at: ep.at,
    symbol: ep.symbol,
    thread_id: ep.thread_id,
    trigger: ep.trigger,
    action: ep.judgment?.action ?? null,
    direction: ep.judgment?.direction ?? null,
    headline: ep.judgment?.headline ?? null,
    confidence: ep.judgment?.confidence ?? null,
    from_state: ep.strategy_before.state,
    to_state: ep.strategy_after?.state ?? null,
    has_intent: ep.intent !== null,
    status: ep.status,
    reasons: ep.judgment?.reasons ?? [],
    reducer: ep.reducer,
    schema_errors: ep.schema_errors,
    error: ep.error,
    intent: ep.intent,
    graph: ep.graph ?? null,
  };
}

// ---------------------------------------------------------------- v2 (design notes)

/** Which CLI the model runs behind (design §9: always a subprocess, the gateway holds no model keys). */
export type BrainKind = 'pi' | 'claude' | 'codex' | 'stub';

/** One selectable brain for the UI (`GET /api/brains`). */
export interface BrainOption {
  kind: BrainKind;
  label: string;
  /** CLI found on PATH (stub is always available). */
  available: boolean;
  /** Suggested model ids for this kind (free text is still accepted). pi uses `provider/model`. */
  models: string[];
  default_model: string | null;
  note: string;
  /** The configured launch command for this CLI (`Workflow.cli_commands`); null for the stub. */
  command: string | null;
  /** How that command would be started and whether it resolves at all. */
  resolved: CliResolvedView;
}

/** `via` 'direct' = spawned as-is; 'shell' = run through the user's login+interactive shell (aliases). */
export interface CliResolvedView {
  via: 'direct' | 'shell';
  ok: boolean;
  detail: string;
}

/** Per-CLI launch command (bare name, path, env-prefixed line, or an interactive-shell alias). */
export interface CliCommandsView {
  claude: string;
  codex: string;
  pi: string;
}

export interface BrainTestResult {
  ok: boolean;
  kind: BrainKind;
  model: string | null;
  name: string;
  latency_ms: number;
  text: string | null;
  error: string | null;
}

export interface Workflow {
  watchlist: string[];
  timeframe: string;
  info_every_ms: number;
  risk_pct: string;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  max_open_threads: number;
  max_opens_per_day: number;
  /** Stop opening new threads for the UTC day once realized+unrealized loss since 00:00 UTC exceeds this % of start-of-day equity. */
  daily_loss_stop_pct: string;
  auto_approve: boolean;
  brain: BrainKind;
  cheap_brain: BrainKind;
  /** Model id for `brain` (pi: `provider/model`, claude: alias or id, codex: model id); null = that CLI's default / env. */
  brain_model: string | null;
  /** Model id for `cheap_brain` (information officer); null = default. */
  cheap_brain_model: string | null;
  playbook_text: string;
  paused: boolean;
  /** Agent posts a one-line plain-language note into the chat after each judgment / thread event / info update. */
  narrate: boolean;
  /** v3.10.1:对话里 agent 批准/执行意图是否需要人在界面上点一次性 token(默认 false = agent 自批)。扫描自动路径与此无关(那是 auto_approve)。 */
  chat_requires_approval: boolean;
  /** 'triggered' = code triggers + heartbeat decide when the model is called; 'every_close' = every kline close (demo). */
  scan_mode: 'triggered' | 'every_close';
  /** In triggered mode: longest gap between two model calls for one symbol. */
  heartbeat_every_ms: number;
  /**
   * v3.9:只观察不交易的币(watchlist 的子集)。在这些币上判断模块进 scan:watch_only 节点,PROPOSE 不是合法边,
   * 只能 NO_TRADE / WATCH;从名单里去掉即可交易。一个界面里每个币一个「观察/交易」开关。
   */
  watch_only: string[];
  /** v7 失效确认:连续多少根已收盘 K 线越过失效价才算「失效确认=是」(默认 2;1 = 一根就算)。 */
  invalidation_confirm_bars: number;
  /** v7 失效缓冲:越过深度不足这么多 ATR 不算越过(默认 0.2;0 = 贴线就算)。 */
  invalidation_buffer_atr: number;
  /** A ≥ this % move within 5 minutes wakes the agent immediately (decimal string). */
  fast_move_pct: string;
  /** Open threads: review on every close of their timeframe (true) or only on events/triggers/heartbeat (false). */
  review_every_close: boolean;
  /** Which execution backend the runtime is on right now (v3.3); switching is refused while a thread is open. */
  execution: Backend;
  /** Which agent CLI drives the Binance MCP server when `execution === 'agent_mcp'`. */
  exec_agent_cli: AgentCliKind;
  /** Model id for that CLI; null = 'sonnet' for claude / the Codex CLI's own default. */
  exec_agent_model: string | null;
  /** Max model judgments (episodes) per local day; 0 = unlimited. Chat replies are never capped. */
  daily_judgment_cap: number;
  /**
   * 09-07 Strategy Lab 自动闭环:实验结果写回版本的 lab_stats;参数探针明显更好时自动建 draft 版本并交接;
   * draft→backtest→shadow 两步数据态晋升过闸自动走。paper 及以上永远人批。false = Lab 只出研究记录(旧行为)。
   */
  /** Radar screener (screener.ts, design notes). WIP: fields exist so the module compiles; the routine is wired separately. */
  screener_enabled: boolean;
  screener_short_every_ms: number;
  screener_swing_every_ms: number;
  screener_universe: 'watchlist+whitelist' | 'top_volume' | 'explicit';
  screener_symbols: string[];
  /** 「观察列表 + 白名单」范围里的白名单;可在筛选设置里改,空 = 只筛观察列表。 */
  screener_whitelist: string[];
  screener_max_symbols: number;
  screener_use_brain: boolean;
  screener_apply: 'propose' | 'auto';
  screener_expectancy: boolean;
  /** Mirror of WORKFLOW_BOUNDS.watchlist_max so consumers (screener proposal size) read one place. */
  watchlist_max: number;
  /**
   * How each CLI is actually launched on THIS machine. May be a bare name on PATH, a path, a line with
   * env prefixes (`HTTP_PROXY=… claude`), or a shell alias that only exists in the interactive shell
   * (`claudeproxy`) — see cli-launch.ts. Used by every spawn: brains, agent_mcp execution, MCP probe,
   * and the login terminal.
   */
  cli_commands: CliCommandsView;
  /**
   * v3.5: which strategies from the library the live loop may use (design notes).
   * Only status ≥ paper may actually be active live; backtest/shadow are allowed in backtests only.
   */
  active_strategies: string[];
  updated_at: number;
}

/** Which agent CLI drives the Binance MCP execution backend. */
export type AgentCliKind = 'claude' | 'codex';

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
  /** v3.9:`event_id` 是 InformationEvent.id(稳定),`url` 是原文链接(source_ref);旧快照读出来时按 info_refs 回填。 */
  news: { ref: string; event_id?: string | null; url?: string | null; title: string; source: string; /** v3.9:给人看的来源名(info.ts sourceLabel);旧快照读出时回填 */ source_label?: string; published_at: number; relevance: 'high' | 'medium' | 'low'; digest: string }[];
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
  /** v3.8:开仓时的执行通道;列表/复查/历史都按当前通道过滤(切通道 = 切账户上下文)。旧行迁移为 'paper'。 */
  backend?: Backend | null;
  /** v3.5: the strategy library id the opening judgment named (null for threads opened before the library). */
  strategy_id?: string | null;
  /** Average exit price when known (paper SL/TP hit price, or the close receipt); absent on older rows. */
  exit_price?: string | null;
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
  take_profits: string[];
  qty: string;
  margin_usdt: string | null;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  entry_client_order_id: string | null;
  protection_client_order_ids: string[];
  filled_avg_price: string | null;
  realized_pnl: string | null;
  close_reason: string | null;
  /** Machine-readable "needs a human" flag, e.g. PROTECTION_MISSING / ORDER_UNKNOWN / EXTERNAL_ACTIVITY; null when fine. */
  attention: string | null;
  /** Consecutive `getOrder === null` for the entry order (propagation delay is not a negative fact). */
  entry_lookup_misses: number;
  /** 入场调用进行中(CID 已持久化、请求可能还没到交易所):巡检在宽限内不查此 CID,不报 ORDER_UNKNOWN。调用返回即清空。 */
  entry_submitting_since?: number | null;
  /** 入场调用返回的时刻:之后 45 秒内同币同向出现的持仓先算「待归属」,不报 EXTERNAL_POSITION;查不到单也不报 ORDER_UNKNOWN。 */
  entry_submitted_at?: number | null;
  /** Monotonic per-thread leg counter used to mint unique clientOrderIds. */
  leg_seq: number;
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
  /** 'narration' = the agent's own one-liners about what it just did; 'chat' = the conversation. */
  kind: 'chat' | 'narration';
  /** v3.8:所属会话(旁白为 null)。 */
  session_id?: string | null;
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: boolean;
  /** 本会话允许 agent 直接批准/否决待批 intent(用户在会话头上开,默认关)。 */
  can_execute: boolean;
  /** v3.8:对着哪个角色说(楼层桌子进来的会话);null = 主会话,由 Gate Captain 路由。 */
  role: string | null;
  message_count: number;
  last_text: string | null;
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

// ---------------------------------------------------------------- v3 (design notes)

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
  | 'cap_reached'
  | 'execution_changed'
  | 'heartbeat_skipped'
  | 'screen_done'
  | 'screen_failed'
  | 'risk_alert'
  | 'risk_cleared'
  | 'brief';

/** One prominent line for the activity timeline (the logs page's top half). Raw LogLine stays for debugging. */
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

export type DailyRegimeKind = 'bull' | 'bear' | 'range' | 'volatile';

/** Code-computed daily-timeframe state (no model involved). */
export interface DailyRegime {
  regime: DailyRegimeKind;
  ema_stack: string;
  ret_20d_pct: number;
  ret_5d_pct: number;
  vol_pct_rank: number;
  atr_pct: number;
  dist_to_ema200_pct: number | null;
  text: string;
  as_of: number;
}

export type SessionName = 'us_open_window' | 'us_close_window' | 'us' | 'london' | 'asia' | 'weekend' | 'off';

export interface SessionInfo {
  name: SessionName;
  text: string;
  minutes_to_us_open: number | null;
  minutes_to_us_close: number | null;
  weekend: boolean;
}

export interface RegimeView {
  symbol: string;
  as_of: number;
  daily: DailyRegime | null;
  session: SessionInfo;
}

export interface TriggerHit {
  kind: TriggerKind;
  detail: string;
  /** 0-1, how strongly the rule fired (for ordering / evidence text only). */
  score: number;
}

export interface EquityPoint {
  at: number;
  equity: number;
  unrealized: number;
  /** v3.8:所属执行通道(曲线按通道画,不同通道的权益不接在一起)。 */
  backend?: Backend;
}

export interface HistoryThreadRow extends StrategyThread {
  hold_ms: number;
  pnl_num: number;
  exit_price: string | null;
  episode_count: number;
  r_multiple: number | null;
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
  by_symbol: { symbol: string; count: number; wins: number; pnl: string }[];
  by_source: { source: ThreadSource; count: number; pnl: string }[];
  by_close_reason: { reason: string; count: number; pnl: string }[];
}

export interface HistoryResponse {
  stats: HistoryStats;
  threads: HistoryThreadRow[];
  equity: EquityPoint[];
}

// ---------------------------------------------------------------- v3.2 memory (design notes, design §11 L3 "B7-lite")

export type MemoryKind = 'lesson' | 'preference' | 'fact' | 'calibration';
/** proposed → active (human approved) | rejected; active → superseded (a newer item replaced it) | forgotten (tombstone). */
export type MemoryStatus = 'proposed' | 'active' | 'rejected' | 'superseded' | 'forgotten';
export type MemoryProposer = 'agent' | 'user' | 'system';

export interface MemoryScope {
  /** null = applies to every symbol. */
  symbol: string | null;
  timeframe: string | null;
  /** Daily regime the lesson was learnt in (bull/bear/range/volatile) or null. */
  regime: string | null;
}

/**
 * One durable, human-approved memory. Rules (design §11): memory never overrides L1 live truth; the judgment may
 * cite a memory (it is registered as evidence `E#` labelled 记忆) but numbers inside a memory are never market
 * numbers; 30 days without use → decays out of recall; writes are proposals until approved.
 */
export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  /** ≤ 300 chars, plain language, one idea. */
  content: string;
  /** Episode / thread ids the memory was distilled from. */
  source_refs: string[];
  /** Free tags used for structured recall: trigger kinds, close reasons, 'win'/'loss', strategy names… */
  tags: string[];
  confidence: number;
  status: MemoryStatus;
  proposed_by: MemoryProposer;
  supersedes: string | null;
  superseded_by: string | null;
  created_at: number;
  decided_at: number | null;
  last_used_at: number | null;
  use_count: number;
  expires_at: number | null;
  /** sha256 of normalised content, exact-duplicate guard. */
  content_hash: string;
}

export interface MemoryEvent {
  id: number;
  memory_id: string;
  at: number;
  kind: 'proposed' | 'approved' | 'rejected' | 'forgotten' | 'superseded' | 'used' | 'expired' | 'dedup_hit';
  detail: string | null;
}

/** Structured recall request (what the runtime asks before building a context). */
export interface MemoryRecallQuery {
  symbol: string | null;
  timeframe?: string | null;
  regime?: string | null;
  tags?: string[];
  /** Free text (chat `recall`) — FTS5 trigram match on content + tags. */
  text?: string | null;
  limit?: number;
  /** Total content characters allowed in the result (≈ 300 tokens by default). */
  char_budget?: number;
  now?: number;
}

export interface MemoryRecallHit {
  item: MemoryItem;
  score: number;
  why: string[];
}

// ---------------------------------------------------------------- v3.3 execution backend + cost control

export type McpConnectionStatusKind = 'connected' | 'needs_auth' | 'unavailable' | 'unknown';

export interface ExecutionOption {
  kind: Backend;
  label: string;
  /** Selectable right now (factory registered and, for agent_mcp, the chosen CLI on PATH). */
  available: boolean;
  note: string;
  /** 09-07:推荐通道(官方 binance-cli):UI 排最前、打「推荐」标;不可用时把 setup 顶到最上面让用户先看到。 */
  recommended?: boolean;
  /** 不可用时的接入步骤(多行);可用时 null。 */
  setup?: string | null;
}

/** v3.11:通道保护腿自验证状态(§9.20)。用户在界面上点「用最小仓验证」,网关自己跑金丝雀并落库,不需要环境变量/重启。 */
export interface ProtectionStatusView {
  status: 'not_needed' | 'verified' | 'unverified' | 'verifying' | 'failed';
  verified_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  /** 最近一次验证的分步结果(名称/是否通过/说明) */
  steps: { name: string; ok: boolean; detail: string }[];
  /** 给按钮旁的提示:大概花多少钱、多久 */
  cost_note: string;
  /** 验证记录来自哪里:env(开发者覆盖)/ record(落库的金丝雀)/ null */
  source: 'env' | 'record' | null;
}

/**
 * 09-07:执行通道最近一段时间的传输健康——连接被掐/超时/无响应这类「回执丢了但交易所可能已执行」的次数。
 * 通道无关:任何后端都可以报;null = 该后端不统计。用于告诉用户「是你的网络在掐连接,不是交易所拒单」。
 */
export interface TransportHealth {
  window_ms: number;
  runs: number;
  transport_errors: number;
  last_error: string | null;
  last_at: number | null;
}

/** 09-07:网络自检——连续 N 次只读账户调用,统计几次连接被掐/超时、平均耗时,给用户判断代理/网络该不该调。 */
export interface NetCheckResult {
  backend: Backend;
  started_at: number;
  finished_at: number;
  runs: { ms: number; ok: boolean; transport_error: boolean; error: string | null }[];
  ok: number;
  transport_errors: number;
  other_errors: number;
  avg_ms: number | null;
  /** 一句话结论 + 建议 */
  verdict: string;
}

export interface ExecutionView {
  backend: Backend;
  /** v3.11 */
  protection: ProtectionStatusView;
  /** 09-07:传输健康;null = 后端不统计 */
  transport: TransportHealth | null;
  options: ExecutionOption[];
  /** `model` is what the CLI will actually be run with (claude falls back to sonnet, the cheap one). */
  agent: { cli: AgentCliKind; model: string | null; model_note: string | null; server_name: string; url: string; command: string; resolved: CliResolvedView };
  connection: { status: McpConnectionStatusKind; checked_at: number | null; detail: string };
  /** v3.8:最近一次账户读取失败(读成功后清空)。UI 据此显示「执行通道账户不可读」而不是权益 0。 */
  account_read_error: { at: number; message: string } | null;
  /** v3.8:当前通道账户是否入金(读成功且权益 0、无持仓 → false;没读到过 → null)。 */
  account_funded: boolean | null;
  can_switch: boolean;
  switch_blocker: string | null;
}

/** Today's model spend (local day), for GET /api/overview. `est_cny` is null when no priced model was used. */
export interface UsageToday {
  judgments: number;
  input_tokens: number;
  output_tokens: number;
  est_cny: number | null;
  cap: number;
  capped: boolean;
}
