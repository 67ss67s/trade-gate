// Strategy threads (design notes) — the agent's plan for one symbol, persisted, but
// with its STATUS re-derived from exchange facts on every poll (参考实现 lesson: never let our own status
// field become a second source of truth). Pure functions only; the runtime owns I/O.

import { createHash } from 'node:crypto';
import type { Direction, Judgment, OpenOrderView, PositionView, StrategyThread, ThreadSource, Workflow, Backend } from './types.js';
import type { OrderStatusView } from './execution.js';
import { allowedActions, edgeFor, nodeFor } from './graph.js';

export function newThread(input: {
  id: string;
  backend?: Backend | null;
  symbol: string;
  side: Direction;
  source: ThreadSource;
  timeframe: string;
  thesis: string;
  invalidation_text: string | null;
  watch_conditions: string[];
  entry: StrategyThread['entry'];
  stop_price: string | null;
  take_profits: string[];
  qty: string;
  margin_usdt: string | null;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  /** v3.5: the strategy library id the opening judgment named (null when the context had no strategies). */
  strategy_id?: string | null;
  now: number;
}): StrategyThread {
  return {
    id: input.id,
    backend: input.backend ?? null,
    strategy_id: input.strategy_id ?? null,
    symbol: input.symbol,
    side: input.side,
    status: 'pending_entry',
    source: input.source,
    timeframe: input.timeframe,
    thesis: input.thesis,
    invalidation_text: input.invalidation_text,
    watch_conditions: input.watch_conditions,
    entry: input.entry,
    stop_price: input.stop_price,
    take_profits: input.take_profits,
    qty: input.qty,
    margin_usdt: input.margin_usdt,
    leverage: input.leverage,
    margin_mode: input.margin_mode,
    entry_client_order_id: null,
    protection_client_order_ids: [],
    filled_avg_price: null,
    realized_pnl: null,
    close_reason: null,
    attention: null,
    entry_lookup_misses: 0,
    leg_seq: 0,
    episode_ids: [],
    intent_ids: [],
    created_at: input.now,
    updated_at: input.now,
    opened_at: null,
    closed_at: null,
    version: 1,
  };
}

export const OPEN_STATUSES: StrategyThread['status'][] = ['pending_entry', 'in_position'];
export const isOpen = (t: StrategyThread): boolean => OPEN_STATUSES.includes(t.status);

/** Facts gathered by the runtime for one reconciliation pass. */
export interface ThreadFacts {
  now: number;
  position: PositionView | null; // exchange position for the thread's symbol (one-way account)
  entry_order: OrderStatusView | null | 'unqueried'; // status of entry_client_order_id
  open_orders: OpenOrderView[]; // all open orders for the symbol
  mark: string | null;
}

export interface ReconcileResult {
  next: StrategyThread;
  changed: boolean;
  events: { kind: 'entry_filled' | 'closed' | 'attention' | 'attention_cleared' | 'canceled'; message: string }[];
}

/**
 * Re-derives status from facts. Rules (mirroring 参考实现's order-sensitive chain, simplified for one-way):
 * - pending_entry: entry order FILLED → in_position; CANCELED/EXPIRED/REJECTED with no position → canceled;
 *   entry order gone (null) and no position → canceled (exchange forgot it / someone canceled it).
 * - in_position: position gone → closed (realized pnl filled in by the runtime from receipts/income);
 *   protection legs missing → attention PROTECTION_MISSING (runtime tries to re-place).
 */
/** 入场调用返回后、交易所可见性/成交确认到达前的宽限(agent_mcp 每次调用 20–35 秒)。 */
export const ATTRIBUTION_GRACE_MS = 45_000;
function withinSubmitGrace(t: StrategyThread, now: number): boolean {
  return typeof t.entry_submitted_at === 'number' && now - t.entry_submitted_at >= 0 && now - t.entry_submitted_at < ATTRIBUTION_GRACE_MS;
}

export function reconcileThread(t: StrategyThread, f: ThreadFacts): ReconcileResult {
  const events: ReconcileResult['events'] = [];
  const next: StrategyThread = { ...t };
  const bump = (): void => {
    next.version = t.version + 1;
    next.updated_at = f.now;
  };
  const posMatches = f.position !== null && f.position.side === t.side;

  if (t.status === 'pending_entry') {
    const order = f.entry_order === 'unqueried' ? null : f.entry_order;
    const filled = order !== null && (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED');
    if (filled && posMatches) {
      next.status = 'in_position';
      next.opened_at = f.now;
      next.filled_avg_price = order.avg_price ?? f.position!.entry_price;
      if (order.status === 'PARTIALLY_FILLED' && Number(order.executed_qty) > 0) next.qty = order.executed_qty;
      next.attention = order.status === 'PARTIALLY_FILLED' ? 'ENTRY_REMAINDER' : null;
      bump();
      events.push({ kind: 'entry_filled', message: `入场${order.status === 'PARTIALLY_FILLED' ? '部分' : ''}成交 @ ${next.filled_avg_price}` });
      return { next, changed: true, events };
    }
    if (!filled && f.position !== null && t.entry_client_order_id) {
      // Our own fill often shows up in the account read before the order query confirms it (20–35 s per
      // agent_mcp call): same side + fresh submit = pending attribution, not a foreign position. Wait.
      if (posMatches && withinSubmitGrace(t, f.now)) return { next, changed: false, events };
      // A position exists on this symbol but our entry did not fill: someone else's. Fail closed.
      if (t.attention !== 'EXTERNAL_POSITION') {
        next.attention = 'EXTERNAL_POSITION';
        bump();
        events.push({ kind: 'attention', message: '同币种出现不属于本线程的持仓,入场单保持但不会挂保护单;请人工处理' });
        return { next, changed: true, events };
      }
      return { next, changed: false, events };
    }
    if (f.entry_order !== 'unqueried' && t.entry_client_order_id) {
      const st = order?.status ?? 'GONE';
      if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(st) && !posMatches) {
        next.status = 'canceled';
        next.closed_at = f.now;
        next.close_reason = t.close_reason ?? `入场单 ${st}`;
        next.attention = null;
        bump();
        events.push({ kind: 'canceled', message: next.close_reason });
        return { next, changed: true, events };
      }
      if (st === 'GONE') {
        // Just submitted: the exchange may not show the CID yet. Not a miss, not an alarm.
        if (withinSubmitGrace(t, f.now)) return { next, changed: false, events };
        // null is not a negative fact (propagation delay, query blind spot): never auto-cancel on it.
        // Count misses, raise ORDER_UNKNOWN, and leave the decision to a human or a later lookup.
        const misses = (t.entry_lookup_misses ?? 0) + 1;
        next.entry_lookup_misses = misses;
        if (t.attention !== 'ORDER_UNKNOWN') {
          next.attention = 'ORDER_UNKNOWN';
          bump();
          events.push({ kind: 'attention', message: '入场单在交易所查不到,持续核对(不重发,不自动撤)' });
          return { next, changed: true, events };
        }
        bump();
        return { next, changed: true, events };
      }
      if (t.attention === 'ORDER_UNKNOWN' && order) {
        next.attention = null;
        next.entry_lookup_misses = 0;
        bump();
        events.push({ kind: 'attention_cleared', message: '入场单已查到' });
        return { next, changed: true, events };
      }
    }
    return { next, changed: false, events };
  }

  if (t.status === 'in_position') {
    if (!posMatches) {
      next.status = 'closed';
      next.closed_at = f.now;
      next.close_reason = next.close_reason ?? '持仓已在交易所侧平掉(止损/止盈触发或手动)';
      next.attention = null;
      bump();
      events.push({ kind: 'closed', message: next.close_reason });
      return { next, changed: true, events };
    }
    const want = Number(t.stop_price ?? '0');
    const hasStop = f.open_orders.some(
      (o) =>
        o.reduce_only &&
        (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
        o.side === (t.side === 'long' ? 'SELL' : 'BUY') &&
        (t.protection_client_order_ids.includes(o.client_order_id) || (want > 0 && o.stop_price !== null && Math.abs(Number(o.stop_price) - want) / want < 0.005)),
    );
    const wantStop = t.stop_price !== null;
    if (t.attention === 'HALT_INCOMPLETE' || t.attention === 'ENTRY_REMAINDER' || t.attention === 'CLOSE_FAILED') return { next, changed: false, events }; // runtime owns these
    const attention = wantStop && !hasStop ? 'PROTECTION_MISSING' : null;
    if (attention !== t.attention) {
      next.attention = attention;
      bump();
      events.push(attention ? { kind: 'attention', message: '止损单不在交易所上,需要补挂' } : { kind: 'attention_cleared', message: '止损单已恢复' });
      return { next, changed: true, events };
    }
  }
  return { next, changed: false, events };
}

/** Which actions a review judgment may take for a thread in its current status (read from the judgment graph). */
export function allowedReviewActions(t: StrategyThread): Judgment['action'][] {
  return allowedActions(nodeFor(t, false));
}

export interface ReviewDecision {
  accepted: boolean;
  reason: string;
  effect: 'none' | 'cancel_entry' | 'reduce_half' | 'close';
  patch: Partial<StrategyThread>;
  /** Graph edge taken (null = illegal edge attempt, rejected). */
  edge: string | null;
}

/** Applies the model's review action by looking the edge up in the judgment graph; the effect comes from the graph, the wording from here. */
export function reduceReview(t: StrategyThread, j: Judgment): ReviewDecision {
  const node = nodeFor(t, false);
  const edge = edgeFor(node, j.action);
  const patch: Partial<StrategyThread> = {
    thesis: j.thesis || t.thesis,
    invalidation_text: j.invalidation ?? t.invalidation_text,
    watch_conditions: j.watch_conditions.length ? j.watch_conditions : t.watch_conditions,
  };
  if (!edge) return { accepted: false, reason: `线程状态 ${t.status} 不接受 ${j.action}`, effect: 'none', patch: {}, edge: null };
  switch (edge.effect) {
    case 'none':
      return { accepted: true, reason: t.status === 'pending_entry' ? '继续等入场' : '论点仍成立,继续持有', effect: 'none', patch, edge: edge.id };
    case 'cancel_entry':
      return { accepted: true, reason: '论点失效,撤入场单', effect: 'cancel_entry', patch: { ...patch, close_reason: '论点失效(复查)' }, edge: edge.id };
    case 'close':
      return j.action === 'INVALIDATE'
        ? { accepted: true, reason: '论点失效,平仓', effect: 'close', patch: { ...patch, close_reason: '论点失效(复查)' }, edge: edge.id }
        : { accepted: true, reason: '复查决定离场', effect: 'close', patch: { ...patch, close_reason: '复查离场' }, edge: edge.id };
    case 'reduce_half':
      return { accepted: true, reason: '复查决定减半', effect: 'reduce_half', patch, edge: edge.id };
    default:
      return { accepted: false, reason: `图上的边 ${edge.id} 效果 ${edge.effect} 不属于复查`, effect: 'none', patch: {}, edge: edge.id };
  }
}

/** Opening gates that depend on the thread set + workflow (the per-proposal gates live in gates.ts). */
export function openingBlockers(threads: StrategyThread[], workflow: Workflow, symbol: string, opensToday: number, dailyLossHit: boolean): string[] {
  const open = threads.filter(isOpen);
  const out: string[] = [];
  if (open.some((t) => t.symbol === symbol)) out.push(`${symbol} 已有线程`);
  if (open.length >= workflow.max_open_threads) out.push(`同时线程数已到上限 ${workflow.max_open_threads}`);
  if (opensToday >= workflow.max_opens_per_day) out.push(`今日开仓已到上限 ${workflow.max_opens_per_day}`);
  if (dailyLossHit) out.push(`今日亏损已触及 ${workflow.daily_loss_stop_pct}% 日亏停`);
  return out;
}

/** Stable, collision-resistant prefix for a thread's client order ids: `tgd-<sha1(thread id)[0..12]>`. */
export function threadClientPrefix(threadId: string): string {
  return `tgd-${createHash('sha1').update(threadId).digest('hex').slice(0, 12)}`;
}

/** Mints the next unique client order id for a leg (`e` entry, `s` stop, `t` tp, `x` close, `r` reduce) and bumps `leg_seq`. */
export function nextLegCid(t: StrategyThread, leg: 'e' | 's' | 't' | 'x' | 'r'): { cid: string; next: StrategyThread } {
  const seq = (t.leg_seq ?? 0) + 1;
  return { cid: `${threadClientPrefix(t.id)}-${leg}${seq}`, next: { ...t, leg_seq: seq } };
}
