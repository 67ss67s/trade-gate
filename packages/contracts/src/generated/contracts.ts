/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: packages/contracts/{schema,transitions,tables}/*.json
 * Regenerate: `npm run generate` in packages/contracts (`npm run generate:check` verifies in CI).
 * Changing schema/transitions/tables is a main-line-only change — see docs/contracts/README.md §10.
 */

export type SchemaVersion = 1;
/**
 * main=主账户(用户,REST);sub=Agentic 子账户(agent,MCP)
 */
export type AccountRef = "main" | "sub";
export type Channel = "rest" | "mcp";
/**
 * unix 毫秒;上限为 JS 安全整数
 */
export type TimestampMs = number;
export type Consistency = "consistent" | "inconsistent" | "unavailable";
/**
 * sha256 小写 hex
 */
export type Hash256 = string;
export type Completeness = "complete" | "partial" | "missing";
export type ObservationSource = "rest" | "ws" | "mcp" | "cache";
export type ErrorKind =
  | "invalid_params"
  | "not_found"
  | "forbidden"
  | "halted"
  | "stale"
  | "unavailable"
  | "conflict"
  | "expired"
  | "invalid_transition"
  | "gate_rejected"
  | "exchange_rejected"
  | "unauthorized"
  | "rate_limited"
  | "transport_ambiguous"
  | "internal";
export type Asset = string;
export type Wallet = "spot" | "usdm_futures";
/**
 * 十进制字符串;不用 float,便于两种语言得到相同的 canonical JSON 与哈希
 */
export type Decimal = string;
/**
 * 交易所符号,如 BTCUSDT
 */
export type Symbol = string;
/**
 * v1:USDⓈ-M 永续可交易;spot 只读
 */
export type Product = "usdm_perp" | "spot";
export type PositionSide = "both" | "long" | "short";
export type UnsignedDecimal = string;
export type MarginType = "isolated" | "cross";
/**
 * Binance 允许的 clientOrderId 字符集与长度;本仓库生成的以 tg- 开头
 */
export type ClientOrderId = string;
export type Side = "buy" | "sell";
export type OrderType =
  | "market"
  | "limit"
  | "stop_market"
  | "stop_limit"
  | "take_profit_market"
  | "take_profit_limit"
  | "trailing_stop_market";
export type ExchangeOrderStatus = "new" | "partially_filled" | "filled" | "canceled" | "expired" | "rejected";
export type TimeInForce = "gtc" | "ioc" | "fok" | "gtx";
/**
 * 条件单触发价来源:mark=标记价,contract=最新成交价
 */
export type WorkingType = "mark_price" | "contract_price";
/**
 * 按 clientOrderId 前缀判定:tg- 为本机;其他(含 外部系统的 ts_)为外部
 */
export type OrderOrigin = "local" | "foreign" | "unknown";
export type PositionMode = "one_way" | "hedge";
/**
 * 小写 UUID(v4 为主)
 */
export type Uuid = string;
/**
 * 一个 intent 可能产生多条腿;每条腿各自有 ExecutionAttempt
 */
export type Leg = "entry" | "stop" | "take_profit" | "cancel" | "close" | "transfer";
/**
 * 崩溃边界:clientOrderId 在 before_submit 时已持久化;submitted 后不知结果即 unknown
 */
export type AttemptStage = "before_submit" | "submitted" | "result_persisted";
export type AttemptResult = "pending" | "acked" | "rejected" | "unknown" | "not_received";
/**
 * ActorContext.principal(设计 §6.1)
 */
export type Principal = "user" | "model" | "cron" | "scheduler" | "mcp_client";
export type Surface = "rpc" | "model" | "mcp" | "internal";
export type AuthorizationStatus = "active" | "consumed" | "expired" | "invalidated" | "revoked";
export type IntentKind = "open" | "close" | "cancel_order" | "protect" | "transfer";
/**
 * 设计 §5.1 状态图;终态 rejected/recorded/completed/canceled/expired;execution_unknown 非终态
 */
export type IntentStatus =
  | "proposed"
  | "rejected"
  | "awaiting_approval"
  | "authorized"
  | "recorded"
  | "dispatching"
  | "execution_unknown"
  | "executing"
  | "completed"
  | "canceled"
  | "expired";
export type EffectStatus = "pending" | "satisfied" | "failed";
export type PolicyMode = "run" | "stop_opening" | "flatten_only" | "halt_all";
export type Authority = "observe" | "draft" | "paper" | "live_capped";
export type DemoCapacityConstraint =
  | "thread_slots"
  | "margin_budget"
  | "available_margin"
  | "min_size_risk"
  | "rules_unknown"
  | "market_unavailable"
  | "watchlist"
  | "snapshot_unavailable";
export type EventName =
  | "intent.created"
  | "intent.rejected"
  | "intent.awaiting_approval"
  | "intent.authorized"
  | "intent.recorded"
  | "intent.dispatching"
  | "intent.executing"
  | "intent.execution_unknown"
  | "intent.completed"
  | "intent.canceled"
  | "intent.expired"
  | "plan.materialized"
  | "authorization.granted"
  | "authorization.consumed"
  | "authorization.invalidated"
  | "authorization.expired"
  | "authorization.revoked"
  | "attempt.submitting"
  | "attempt.submitted"
  | "attempt.resolved"
  | "order.observed"
  | "fill.observed"
  | "effect.evaluated"
  | "protection.confirmed"
  | "protection.missing"
  | "protection.compensated"
  | "account.updated"
  | "account.stale"
  | "account.inconsistent"
  | "foreign_activity.detected"
  | "exchange.auth.expiring"
  | "exchange.auth.expired"
  | "exchange.auth.revoked"
  | "exchange.auth.refreshed"
  | "exchange.tools.drift"
  | "exchange.channel.degraded"
  | "exchange.channel.recovered"
  | "policy.changed"
  | "halt.changed"
  | "writer.fenced"
  | "corruption.detected"
  | "health";
export type IntentParams = OpenParams | CloseParams | CancelOrderParams | ProtectParams | TransferParams;
export type SizeSpec =
  | {
      mode: "hint";
      /**
       * 模型只给档位;qty 由代码按止损距离与风险预算反推
       */
      hint: "full" | "half" | "quarter";
    }
  | {
      mode: "qty";
      qty: UnsignedDecimal;
    }
  | {
      mode: "notional";
      notional: UnsignedDecimal;
    };
export type EntrySpec =
  | {
      type: "market";
      max_slippage_bps?: number;
    }
  | {
      type: "limit";
      price: UnsignedDecimal;
      time_in_force?: TimeInForce;
      post_only?: boolean;
    };
export type PlanEconomics = OrderEconomics | ProtectEconomics | CancelEconomics | TransferEconomics;
export type CancelEconomics = CancelEconomics1 & CancelEconomics2;
export type CancelEconomics1 = {
  [k: string]: unknown;
};
/**
 * gateway ↔ execd 的 UDS 契约:JSON-RPC 2.0,每帧一行(newline-delimited,UTF-8,单帧 ≤ 4 MiB)。execd 监听 ~/.trading-swarm/run/execd.sock(0600)。请求方法见 Method;execd → gateway 的通知只有 exec.event。错误码映射见 tables/error_codes.json。
 */
export type ExecutionServiceRpc = RpcRequest | RpcSuccess | RpcFailure | RpcNotification;
export type RpcId = string | number;
export type Method =
  | "exec.health"
  | "exec.intent.propose"
  | "exec.intent.get"
  | "exec.intent.list"
  | "exec.intent.authorize"
  | "exec.intent.reject"
  | "exec.account.snapshot"
  | "exec.exchange.status"
  | "exec.policy.get"
  | "exec.policy.set"
  | "exec.emergency_stop"
  | "exec.events.subscribe"
  | "exec.oauth.start"
  | "exec.oauth.status"
  | "exec.oauth.revoke"
  | "exec.credentials.public_key"
  | "exec.credentials.set"
  | "exec.credentials.status";
export type OauthState = "missing" | "fresh" | "expiring" | "expired" | "revoked";

/**
 * 账户真相(设计 §6.2 account.truth / Codex review #6):每个组件各自 observed_at、取数区间、completeness;经济组件哈希 = account_version;组件缺失或跨度过大 → inconsistent(gate 拒开仓);不可得 → unavailable。
 */
export interface AccountSnapshot {
  schema_version: SchemaVersion;
  account: AccountRef;
  channel: Channel;
  computed_at: TimestampMs;
  consistency: Consistency;
  consistency_reason?: string;
  account_version?: Hash256;
  /**
   * 各必需组件 observed_at 的最大差
   */
  span_ms?: number;
  components: {
    balances: BalancesComponent;
    positions: PositionsComponent;
    open_orders: OrdersComponent;
    position_mode: PositionModeComponent;
    recent_fills?: FillsComponent;
    order_history?: OrdersComponent;
    margin?: MarginComponent;
  };
  summary?: AccountSummary;
}
export interface BalancesComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: BalanceRow[];
}
export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  /**
   * 交易所错误码(如 Binance -2021),有则带
   */
  exchange_code?: number;
  http_status?: number;
}
export interface BalanceRow {
  asset: Asset;
  wallet: Wallet;
  wallet_balance: Decimal;
  available: Decimal;
  unrealized_pnl?: Decimal;
}
export interface PositionsComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: PositionRow[];
}
export interface PositionRow {
  symbol: Symbol;
  product: Product;
  position_side: PositionSide;
  qty: Decimal;
  entry_price: UnsignedDecimal;
  mark_price?: UnsignedDecimal;
  unrealized_pnl?: Decimal;
  leverage?: number;
  margin_type?: MarginType;
  isolated_margin?: Decimal;
  liquidation_price?: UnsignedDecimal;
  notional?: Decimal;
  exchange_update_time?: TimestampMs;
}
export interface OrdersComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: OrderRow[];
}
export interface OrderRow {
  exchange_order_id: string;
  client_order_id?: ClientOrderId;
  symbol: Symbol;
  product: Product;
  side: Side;
  position_side: PositionSide;
  order_type: OrderType;
  status: ExchangeOrderStatus;
  orig_qty: UnsignedDecimal;
  executed_qty: UnsignedDecimal;
  avg_price?: UnsignedDecimal;
  price?: UnsignedDecimal;
  stop_price?: UnsignedDecimal;
  reduce_only: boolean;
  close_position?: boolean;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  origin: OrderOrigin;
  exchange_update_time?: TimestampMs;
  exchange_create_time?: TimestampMs;
}
export interface PositionModeComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: {
    mode: PositionMode;
  };
}
export interface FillsComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: FillRow[];
}
export interface FillRow {
  trade_id: string;
  exchange_order_id: string;
  client_order_id?: ClientOrderId;
  symbol: Symbol;
  product: Product;
  side: Side;
  position_side?: PositionSide;
  qty: UnsignedDecimal;
  price: UnsignedDecimal;
  quote_qty?: UnsignedDecimal;
  commission?: Decimal;
  commission_asset?: Asset;
  realized_pnl?: Decimal;
  is_maker?: boolean;
  trade_time: TimestampMs;
}
export interface MarginComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: MarginInfo;
}
export interface MarginInfo {
  margin_ratio?: UnsignedDecimal;
  maintenance_margin?: UnsignedDecimal;
  margin_balance?: Decimal;
  available_balance?: Decimal;
}
export interface AccountSummary {
  quote_asset: Asset;
  wallet_balance: Decimal;
  margin_balance?: Decimal;
  available_balance: Decimal;
  unrealized_pnl: Decimal;
  today_realized_pnl?: Decimal;
  open_position_count: number;
  open_order_count: number;
}
/**
 * 一次对交易所的写调用(设计 §5.1)。clientOrderId 与完整订单指纹在调用前持久化(stage=before_submit);同 id 重发必须是交易所级幂等,否则不重发;结果 unknown 非终态,由 reconciler 按 clientOrderId 收敛。
 */
export interface ExecutionAttempt {
  schema_version: SchemaVersion;
  attempt_id: Uuid;
  intent_id: Uuid;
  plan_id: Uuid;
  plan_hash: Hash256;
  attempt_no: number;
  leg: Leg;
  /**
   * 同类腿的序号,如第 2 个止盈腿
   */
  leg_index: number;
  account: AccountRef;
  channel: Channel;
  client_order_id: ClientOrderId;
  /**
   * canonical_json(实际发送给交易所的参数,脱敏)——对账时与交易所回显逐字比对
   */
  order_fingerprint: string;
  writer_instance_id: string;
  lease_epoch: number;
  fencing_token: string;
  stage: AttemptStage;
  result: AttemptResult;
  created_at: TimestampMs;
  submitted_at?: TimestampMs;
  deadline_at: TimestampMs;
  result_at?: TimestampMs;
  exchange_order_id?: string;
  /**
   * 非订单类效果的交易所引用,如 transfer 的 tranId
   */
  exchange_ref?: string;
  error?: ErrorInfo;
  /**
   * MCP 通道:实际调用的工具名(来自钉版快照)
   */
  tool_name?: string;
  tools_hash?: Hash256;
}
/**
 * 对某个 plan_hash 的授权(设计 §5.1)。by=user 需要 confirm_echo(结构化确认:审批面逐字回填关键字段,execd 与 plan 派生的 confirm_fields 逐字比对);by=policy 只在 LiveCapped 且上限内出现(v1 feature-gate 关闭)。
 */
export interface Authorization {
  schema_version: SchemaVersion;
  authorization_id: Uuid;
  intent_id: Uuid;
  plan_id: Uuid;
  plan_hash: Hash256;
  by: "user" | "policy";
  principal?: Principal;
  surface?: Surface;
  /**
   * 谁批的:设备/会话/RPC 连接标识;by=policy 时为 policy 版本
   */
  actor_ref?: string;
  status: AuthorizationStatus;
  status_reason?: string;
  /**
   * 审批面回填的字段(见 docs/contracts/README.md「confirm_fields」);by=user 必填
   */
  confirm_echo?: {
    [k: string]: string;
  };
  granted_at: TimestampMs;
  expires_at: TimestampMs;
  consumed_at?: TimestampMs;
  consumed_by_attempt_id?: Uuid;
}
export interface GateRejection {
  /**
   * 闸名,如 policy.mode / freshness.account / risk.max_leverage
   */
  gate: string;
  /**
   * 被拒时的实际值(字符串化)
   */
  value?: string;
  /**
   * 阈值(字符串化)
   */
  limit?: string;
  message: string;
}
/**
 * Portfolio Manager 典型止损容量估算；不是执行授权。金额为十进制字符串，不能计算的字段显式 null。
 */
export interface DemoPortfolioCapacity {
  schema_version: 1;
  snapshot_id: string;
  computed_at: number;
  basis: "typical_stop_estimate";
  snapshot_quality: "ok" | "stale" | "inconsistent" | "incomplete";
  equity: string | null;
  available: string | null;
  risk_pct: string;
  leverage: number;
  default_stop_distance_pct: string;
  slots_total: number;
  slots_used: number;
  slots_free: number;
  margin_budget: DemoCapacityMargin;
  binding_constraint: DemoCapacityConstraint;
  by_symbol: DemoSymbolCapacity[];
}
export interface DemoCapacityMargin {
  max_margin_ratio: number;
  limit_usdt: string | null;
  committed_usdt: string | null;
  reserved_usdt: string | null;
  free_usdt: string | null;
  required_for_free_slots_usdt: string | null;
  slots_supported: number | null;
  witness_symbols: string[];
}
export interface DemoSymbolCapacity {
  symbol: string;
  verdict: "ok" | "needs_equity" | "rules_unknown" | "unavailable";
  watch_only: boolean;
  occupied: boolean;
  price: string | null;
  rules_source: "exchange" | "paper" | null;
  rules_observed_at: number | null;
  stop_distance_pct: string | null;
  stop_source: "atr" | "default" | null;
  min_qty: string | null;
  min_viable_notional: string | null;
  min_size_risk: string | null;
  required_equity: string | null;
  equity_shortfall: string | null;
  margin_per_thread: string | null;
  risk_budget: string | null;
  budget_margin_per_thread: string | null;
}
/**
 * execd 发出的事件(UDS 通知 exec.event,同时落 exec.sqlite events 表,seq 单调,支持 since_seq 回放)。gateway 把它桥接到自己的事件总线与 events 表——'事件即审计'口径(设计 §4)。
 */
export interface ExecEvent {
  schema_version: SchemaVersion;
  seq: number;
  event: EventName;
  at: TimestampMs;
  account?: AccountRef;
  intent_id?: Uuid;
  plan_id?: Uuid;
  attempt_id?: Uuid;
  symbol?: Symbol;
  /**
   * 事件专属载荷(通常是对应记录本身或其差分)
   */
  payload: {};
}
/**
 * 交易所订单的观察值(设计 §5.1):不可变、按 observed_at 追加;订单状态从最新观察派生。同一 exchange_order_id 的观察序列必须满足 transitions/exchange_order_status.json 的单调性,否则标 ORDER_STATE_UNKNOWN。
 */
export interface ExchangeOrderObservation {
  schema_version: SchemaVersion;
  observation_id: Uuid;
  account: AccountRef;
  channel: Channel;
  source: ObservationSource;
  product: Product;
  symbol: Symbol;
  exchange_order_id: string;
  client_order_id?: ClientOrderId;
  status: ExchangeOrderStatus;
  side: Side;
  position_side: PositionSide;
  order_type: OrderType;
  orig_qty: UnsignedDecimal;
  executed_qty: UnsignedDecimal;
  avg_price?: UnsignedDecimal;
  price?: UnsignedDecimal;
  stop_price?: UnsignedDecimal;
  cum_quote?: UnsignedDecimal;
  reduce_only: boolean;
  close_position?: boolean;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  origin: OrderOrigin;
  attempt_id?: Uuid;
  exchange_update_time?: TimestampMs;
  exchange_create_time?: TimestampMs;
  observed_at: TimestampMs;
  raw_hash?: Hash256;
}
/**
 * 成交观察值(设计 §5.1),不可变;(account, exchange_order_id, trade_id) 唯一。
 */
export interface Fill {
  schema_version: SchemaVersion;
  fill_id: Uuid;
  account: AccountRef;
  channel: Channel;
  source: ObservationSource;
  product: Product;
  symbol: Symbol;
  exchange_order_id: string;
  trade_id: string;
  client_order_id?: ClientOrderId;
  attempt_id?: Uuid;
  side: Side;
  position_side?: PositionSide;
  qty: UnsignedDecimal;
  price: UnsignedDecimal;
  quote_qty?: UnsignedDecimal;
  commission?: Decimal;
  commission_asset?: Asset;
  realized_pnl?: Decimal;
  is_maker?: boolean;
  trade_time: TimestampMs;
  observed_at: TimestampMs;
}
/**
 * 动钱的唯一提议记录(设计 §5.1)。模型/UI/Exit DSL 只能提议;经济字段在 ExecutableOrderPlan 里物化并哈希;状态只按 transitions/intent_status.json 迁移。
 */
export interface Intent {
  schema_version: SchemaVersion;
  intent_id: Uuid;
  account: AccountRef;
  principal: Principal;
  surface: Surface;
  session_id?: string;
  run_id?: string;
  /**
   * 来源说明,如 recipe:w4-judgment / ui:trade-page / exit-dsl:thread-42
   */
  origin?: string;
  /**
   * 提议方幂等键;execd 按 (principal, idempotency_key) 去重,同键不同内容 = corruption
   */
  idempotency_key?: string;
  params: IntentParams;
  status: IntentStatus;
  status_reason?: string;
  /**
   * 每次闸拒都追加,不覆盖
   */
  gate_rejections: GateRejection[];
  current_plan_id?: Uuid;
  authorization_id?: Uuid;
  /**
   * 提议有效期;到期未进入 authorized 即 expired
   */
  ttl_seconds: number;
  created_at: TimestampMs;
  updated_at: TimestampMs;
  expires_at?: TimestampMs;
  terminal_at?: TimestampMs;
}
export interface OpenParams {
  kind: "open";
  product: Product;
  symbol: Symbol;
  side: Side;
  position_side?: PositionSide;
  size: SizeSpec;
  entry: EntrySpec;
  stop: StopRef;
  /**
   * @maxItems 4
   */
  take_profits?:
    | []
    | [TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec, TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec, TakeProfitSpec, TakeProfitSpec];
  leverage?: number;
  margin_type?: MarginType;
  thesis?: string;
  /**
   * 必须 ⊆ 本轮/上一轮 evidence registry(设计 §7.3);用户手动单可为空数组
   */
  evidence_refs: string[];
  invalidation?: string;
}
export interface StopRef {
  price: UnsignedDecimal;
  trigger: WorkingType;
}
export interface TakeProfitSpec {
  price: UnsignedDecimal;
  pct: UnsignedDecimal;
  trigger?: WorkingType;
}
export interface CloseParams {
  kind: "close";
  product: Product;
  symbol: Symbol;
  position_side?: PositionSide;
  pct: UnsignedDecimal;
  order: EntrySpec;
  reason?: string;
  evidence_refs?: string[];
}
export interface CancelOrderParams {
  kind: "cancel_order";
  product: Product;
  symbol: Symbol;
  order_ref: OrderRef;
  reason?: string;
}
export interface OrderRef {
  exchange_order_id?: string;
  client_order_id?: ClientOrderId;
}
export interface ProtectParams {
  kind: "protect";
  product: Product;
  symbol: Symbol;
  position_side?: PositionSide;
  stop?: StopRef;
  /**
   * @maxItems 4
   */
  take_profits?:
    | []
    | [TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec, TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec, TakeProfitSpec, TakeProfitSpec];
  /**
   * true=撤掉本机已有保护腿后重挂;false=只补缺
   */
  replace: boolean;
  reason?: string;
}
/**
 * 只允许 principal=user 且 surface=rpc;agent 没有任何划转工具(设计 §3.5)。提币不在 v1 契约内(§16 Q7,延后 + IP 白名单)。
 */
export interface TransferParams {
  kind: "transfer";
  asset: Asset;
  amount: UnsignedDecimal;
  from_account: AccountRef;
  from_wallet: Wallet;
  to_account: AccountRef;
  to_wallet: Wallet;
  reason?: string;
}
/**
 * 审批前物化的可执行计划(设计 §5.1)。审批绑定的是 plan_hash = sha256(canonical_json(economic));basis 不进哈希。重闸只能拒绝,不能改 economic;经济字段实质变化 → 新 plan(version+1)+ 作废旧授权。
 */
export interface ExecutableOrderPlan {
  schema_version: SchemaVersion;
  plan_id: Uuid;
  intent_id: Uuid;
  version: number;
  plan_hash: Hash256;
  account: AccountRef;
  channel: Channel;
  economic: PlanEconomics;
  basis: PlanBasis;
  /**
   * 授权有效期:市价 30s / 限价 120s(设计 §10.3)
   */
  authorization_ttl_seconds: number;
  created_at: TimestampMs;
  expires_at: TimestampMs;
}
/**
 * open / close 两类 intent 的计划;close 时 reduce_only=true 且 protection 为空
 */
export interface OrderEconomics {
  kind: "order";
  product: Product;
  symbol: Symbol;
  side: Side;
  position_side: PositionSide;
  position_mode: PositionMode;
  order_type: OrderType;
  qty: UnsignedDecimal;
  price?: UnsignedDecimal;
  time_in_force?: TimeInForce;
  reduce_only: boolean;
  close_position: boolean;
  leverage?: number;
  margin_type?: MarginType;
  trigger_price?: UnsignedDecimal;
  working_type?: WorkingType;
  protection: Protection;
  /**
   * 首笔成交后保护腿必须在此秒数内确认在交易所,否则补偿平仓(设计 §5.4,默认 20)
   */
  max_naked_seconds: number;
}
export interface Protection {
  stop?: ProtectionLeg;
  /**
   * @maxItems 4
   */
  take_profits:
    | []
    | [ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg, ProtectionLeg];
}
/**
 * 交易所原生保护腿;永远 reduce-only(执行层强制,不作为字段)
 */
export interface ProtectionLeg {
  order_type: "stop_market" | "stop_limit" | "take_profit_market" | "take_profit_limit";
  trigger_price: UnsignedDecimal;
  price?: UnsignedDecimal;
  qty?: UnsignedDecimal;
  working_type: WorkingType;
  close_position: boolean;
}
export interface ProtectEconomics {
  kind: "protect";
  product: Product;
  symbol: Symbol;
  position_side: PositionSide;
  /**
   * @minItems 1
   * @maxItems 5
   */
  legs:
    | [ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg, ProtectionLeg, ProtectionLeg];
  /**
   * 先撤再挂的本机保护单 exchange_order_id 列表(replace=false 时为空)
   */
  replace_order_ids: string[];
}
export interface CancelEconomics2 {
  kind: "cancel";
  product: Product;
  symbol: Symbol;
  exchange_order_id?: string;
  client_order_id?: ClientOrderId;
}
export interface TransferEconomics {
  kind: "transfer";
  asset: Asset;
  amount: UnsignedDecimal;
  from_account: AccountRef;
  from_wallet: Wallet;
  to_account: AccountRef;
  to_wallet: Wallet;
}
/**
 * 物化依据,给 UI/审计看;不进 plan_hash
 */
export interface PlanBasis {
  filters?: SymbolFilters;
  sizing?: SizingBasis;
  account_version?: Hash256;
  market_ref?: MarketRef;
  position_mode_observed?: PositionMode;
  policy_version?: number;
  notes: string[];
}
export interface SymbolFilters {
  tick_size: UnsignedDecimal;
  step_size: UnsignedDecimal;
  min_qty: UnsignedDecimal;
  max_qty?: UnsignedDecimal;
  min_notional: UnsignedDecimal;
  price_precision?: number;
  qty_precision?: number;
  observed_at: TimestampMs;
}
export interface SizingBasis {
  method: "risk_pct_by_stop_distance" | "explicit_qty" | "explicit_notional" | "pct_of_position";
  equity?: UnsignedDecimal;
  risk_pct?: UnsignedDecimal;
  stop_distance?: UnsignedDecimal;
  reference_price?: UnsignedDecimal;
  position_qty_before?: Decimal;
  raw_qty: UnsignedDecimal;
  rounding: "down";
}
export interface MarketRef {
  mark_price?: UnsignedDecimal;
  last_price?: UnsignedDecimal;
  observed_at: TimestampMs;
}
/**
 * execd 持有的 policy 子集(设计 §10):模式、authority、上限。gateway 的 gate v2 与 execd 的重闸读同一份;改动需 policy.set + confirm 回填。金丝雀期默认值取 Codex 保守值(§17.2),向导里显式输入。
 */
export interface ExecPolicy {
  schema_version: SchemaVersion;
  version: number;
  updated_at: TimestampMs;
  mode: PolicyMode;
  authority: Authority;
  emergency_stop: boolean;
  /**
   * feature gate;v1 保持 false,延后到 §16 Q6(Binance 对 standing authorization 的书面口径)解决
   */
  live_capped_enabled: boolean;
  symbol_allowlist: Symbol[];
  product_allowlist: Product[];
  caps: Caps;
  main_account: MainAccountPolicy;
  canary: CanaryPolicy;
}
export interface Caps {
  max_leverage: number;
  risk_pct_per_trade: UnsignedDecimal;
  max_order_notional: UnsignedDecimal;
  max_position_notional: UnsignedDecimal;
  /**
   * 金丝雀期默认 2,之后 6
   */
  max_daily_opens: number;
  daily_loss_stop_pct: UnsignedDecimal;
  /**
   * 默认 3600
   */
  symbol_cooldown_seconds: number;
  /**
   * 默认 20
   */
  max_naked_seconds: number;
  /**
   * 默认 15000
   */
  account_truth_max_age_ms: number;
  /**
   * 默认 5000
   */
  market_max_age_ms: number;
  /**
   * 默认 30
   */
  authorization_ttl_market_seconds: number;
  /**
   * 默认 120
   */
  authorization_ttl_limit_seconds: number;
  /**
   * 下单价 vs 现价偏离上限
   */
  max_price_deviation_bps: number;
  /**
   * 默认 2000:超过禁新增风险
   */
  ntp_drift_block_ms: number;
  /**
   * 默认 10000:超过 HALT
   */
  ntp_drift_halt_ms: number;
}
export interface MainAccountPolicy {
  manual_trading_enabled: boolean;
  /**
   * main↔sub 划转(A1 验证可行后才开)
   */
  transfers_enabled: boolean;
  /**
   * v1 恒 false(§16 Q7 默认不勾提币;提币走 Binance UI 深链)
   */
  withdraw_enabled: false;
}
export interface CanaryPolicy {
  enabled: boolean;
  max_loss_quote?: UnsignedDecimal;
  max_notional_quote?: UnsignedDecimal;
  max_leverage?: number;
  funded_balance_quote?: UnsignedDecimal;
}
/**
 * intent 的经济完成定义(设计 §5.1):开仓=目标数量成交且剩余已撤且保护腿已确认在交易所;平仓=数量核实;保护=腿存在;撤单=订单终态;划转=交易所回执可查。由 reconciler 按读派生并落库,intent 只在 status=satisfied 时才 completed。
 */
export interface PositionEffect {
  schema_version: SchemaVersion;
  effect_id: Uuid;
  intent_id: Uuid;
  plan_id: Uuid;
  kind: IntentKind;
  account: AccountRef;
  symbol?: Symbol;
  status: EffectStatus;
  target_qty?: UnsignedDecimal;
  filled_qty: UnsignedDecimal;
  remaining_qty: UnsignedDecimal;
  /**
   * 未成交部分是否已确认撤销(或本就无剩余)
   */
  remaining_canceled: boolean;
  avg_fill_price?: UnsignedDecimal;
  first_fill_at?: TimestampMs;
  protection_required: boolean;
  protection_confirmed: boolean;
  protection_confirmed_at?: TimestampMs;
  protection_order_ids: string[];
  /**
   * 首笔成交到保护腿确认(或到现在)的秒数
   */
  naked_seconds?: number;
  compensation_close_attempt_id?: Uuid;
  position_qty_after?: Decimal;
  exchange_ref?: string;
  failure_reason?: string;
  evaluated_at: TimestampMs;
}
export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: Method;
  params: {};
}
export interface RpcSuccess {
  jsonrpc: "2.0";
  id: RpcId;
  result: {};
}
export interface RpcFailure {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: RpcError;
}
export interface RpcError {
  code: number;
  message: string;
  data: RpcErrorData;
}
export interface RpcErrorData {
  kind: ErrorKind;
  retryable: boolean;
  details?: {};
}
export interface RpcNotification {
  jsonrpc: "2.0";
  method: "exec.event";
  params: ExecEvent;
}
export interface ChannelHealth {
  state: "ok" | "degraded" | "down" | "unconfigured";
  detail?: string;
  last_ok_at?: TimestampMs;
}
export interface HealthParams {}
export interface HealthResult {
  ok: boolean;
  version: string;
  writer_instance_id: string;
  lease_epoch: number;
  started_at: TimestampMs;
  now: TimestampMs;
  db_ok: boolean;
  mode: PolicyMode;
  halted: boolean;
  open_intents: number;
  unknown_attempts: number;
  channels: {
    main: ChannelHealth;
    sub: ChannelHealth;
  };
}
export interface IntentProposeParams {
  account: AccountRef;
  principal: Principal;
  surface: Surface;
  session_id?: string;
  run_id?: string;
  origin?: string;
  idempotency_key?: string;
  params: IntentParams;
  ttl_seconds?: number;
}
export interface IntentProposeResult {
  intent: Intent;
  plan?: ExecutableOrderPlan;
  gate_rejections: GateRejection[];
}
export interface IntentGetParams {
  intent_id: Uuid;
}
export interface IntentBundle {
  intent: Intent;
  plan?: ExecutableOrderPlan;
  authorization?: Authorization;
  attempts: ExecutionAttempt[];
  orders: ExchangeOrderObservation[];
  fills: Fill[];
  effect?: PositionEffect;
}
export interface IntentListParams {
  status?: IntentStatus[];
  account?: AccountRef;
  kind?: IntentKind;
  since?: TimestampMs;
  limit?: number;
}
export interface IntentListResult {
  intents: Intent[];
}
/**
 * 只接受 principal=user;plan_hash 或 confirm_echo 与当前 plan 不符 → conflict
 */
export interface IntentAuthorizeParams {
  intent_id: Uuid;
  plan_hash: Hash256;
  principal: Principal;
  surface: Surface;
  actor_ref?: string;
  confirm_echo: {
    [k: string]: string;
  };
}
export interface IntentAuthorizeResult {
  intent: Intent;
  authorization: Authorization;
}
export interface IntentRejectParams {
  intent_id: Uuid;
  reason: string;
  principal: Principal;
  surface: Surface;
}
export interface IntentRejectResult {
  intent: Intent;
}
export interface AccountSnapshotParams {
  account: AccountRef;
  max_age_ms?: number;
  force_refresh?: boolean;
}
export interface AccountSnapshotResult {
  snapshot: AccountSnapshot;
}
export interface OauthStatus {
  state: OauthState;
  expires_at?: TimestampMs;
  has_refresh: boolean;
  scopes?: string[];
  client_id?: string;
  obtained_at?: TimestampMs;
}
export interface MainKeyPermissions {
  reading?: boolean;
  spot_margin_trading?: boolean;
  futures?: boolean;
  universal_transfer?: boolean;
  withdrawals?: boolean;
  ip_restricted?: boolean;
}
export interface MainChannelStatus {
  configured: boolean;
  /**
   * sha256(api_key) 前 16 hex,只用于识别不是密钥
   */
  key_fingerprint?: string;
  permissions?: MainKeyPermissions;
  user_stream: "connected" | "stale" | "disconnected" | "unconfigured";
  time_offset_ms?: number;
  rest_gate: "ready" | "wait" | "banned" | "unconfigured";
  last_verified_at?: TimestampMs;
}
export interface SubChannelStatus {
  configured: boolean;
  oauth: OauthStatus;
  mcp_session: "active" | "none" | "lost";
  tools_hash?: Hash256;
  tools_pinned_hash?: Hash256;
  tools_count?: number;
  /**
   * tools_hash != tools_pinned_hash → 写路径 HALT
   */
  drift: boolean;
  /**
   * Agentic 子账户稳定标识(A1 实测 MCP 是否暴露)
   */
  subaccount_ref?: string;
}
export interface ExchangeStatusParams {}
export interface ExchangeStatusResult {
  main: MainChannelStatus;
  sub: SubChannelStatus;
  writer: {
    instance_id: string;
    lease_epoch: number;
    since: TimestampMs;
  };
}
export interface PolicyGetParams {}
export interface PolicyGetResult {
  policy: ExecPolicy;
}
export interface PolicySetParams {
  policy: ExecPolicy;
  /**
   * 逐字回填新 policy 的 mode/authority(设计 §10.4)
   */
  confirm: {
    mode: string;
    authority: string;
  };
  principal: Principal;
  surface: Surface;
}
export interface PolicySetResult {
  policy: ExecPolicy;
}
/**
 * 只能收紧;放松要走 policy.set + confirm
 */
export interface EmergencyStopParams {
  mode: "stop_opening" | "flatten_only" | "halt_all";
  reason: string;
  principal: Principal;
  surface: Surface;
}
export interface EmergencyStopResult {
  policy: ExecPolicy;
}
export interface EventsSubscribeParams {
  since_seq?: number;
}
export interface EventsSubscribeResult {
  ok: boolean;
  current_seq: number;
}
export interface OauthStartParams {
  scopes?: string[];
  open_browser?: boolean;
}
/**
 * 回调由 execd 自己在回环端口接收;code/verifier 不经过 gateway
 */
export interface OauthStartResult {
  authorize_url: string;
  state: string;
  expires_at: TimestampMs;
}
export interface OauthStatusParams {}
export interface OauthStatusResult {
  oauth: OauthStatus;
}
export interface OauthRevokeParams {
  principal: Principal;
  surface: Surface;
}
export interface OauthRevokeResult {
  ok: boolean;
}
/**
 * 浏览器用 execd 的 P-256 公钥做 ECDH → HKDF-SHA256(salt 空, info 'trading-swarm/credentials/v1') → AES-256-GCM;gateway 只转发密文,TS 进程永远拿不到明文(AGENTS.md 规矩 1)
 */
export interface SealedSecret {
  alg: "ecdh-p256-hkdf-sha256-aes256gcm";
  /**
   * base64,65 字节未压缩点
   */
  ephemeral_public_key: string;
  /**
   * base64,12 字节
   */
  iv: string;
  /**
   * base64;明文是 UTF-8 JSON {api_key, api_secret}
   */
  ciphertext: string;
}
export interface CredentialsPublicKeyParams {}
export interface CredentialsPublicKeyResult {
  alg: "ecdh-p256-hkdf-sha256-aes256gcm";
  public_key: string;
  expires_at: TimestampMs;
}
export interface CredentialsSetParams {
  kind: "main_api_key";
  sealed: SealedSecret;
  principal: Principal;
  surface: Surface;
}
export interface CredentialsSetResult {
  ok: boolean;
  key_fingerprint?: string;
  permissions?: MainKeyPermissions;
}
export interface CredentialsStatusParams {}
export interface CredentialsStatusResult {
  main_api_key: {
    present: boolean;
    key_fingerprint?: string;
    permissions?: MainKeyPermissions;
    last_verified_at?: TimestampMs;
  };
  oauth: OauthStatus;
}
