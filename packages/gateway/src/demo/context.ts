// EpisodeBuilder + ContextBuilder (design notes–5.3, v2-agent-loop.md §5). One function
// turns live inputs into (a) an evidence registry E1..En with as_of/source/staleness and (b) the exact
// text the model sees. The same text is stored on the episode, so replay == what the model saw.

import { createHash } from 'node:crypto';
import type { AccountView, Evidence, MarketState, MarketView, StrategyThread, Trigger , DailyRegime, SessionInfo, TriggerHit } from './types.js';
import type { TfFeatures } from './market.js';
import { tfToMs } from './market.js';
import { reviewMetrics, scanChecklist } from './review-metrics.js';
import { allowedActions, nodeFor, type NodeId } from './graph.js';
import { renderStrategies, scanThresholdsOf, strategyEvidence, type StrategySpec } from './strategies.js';
import type { Kline } from './types.js';

export const PROMPT_VERSION = 'demo-playbook-v7.1'; // v7.1: scan:stale 节点的允许集写进任务行(stale 变体越图 PROPOSE 3/266) // v7: 失效价越过从「必须 EXIT」降为「可以 EXIT」(带确认口径),只有止损是硬离场

export interface EpisodeInputs {
  now: number;
  symbol: string;
  trigger: Trigger;
  mode: 'scan' | 'review';
  thread: StrategyThread | null; // the thread under review (mode=review) or null (scan)
  open_threads: StrategyThread[]; // all open threads (for portfolio awareness)
  account: AccountView;
  market: MarketView;
  features: TfFeatures[];
  oi_change_1h_pct: number | null;
  ticker24h: { priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string };
  market_state: MarketState | null;
  playbook_text: string;
  last_judgment_summary: string | null;
  halted: boolean;
  /** v3 code-computed context (optional so recorded v2 eval cases still build). */
  daily_regime?: DailyRegime | null;
  session?: SessionInfo | null;
  trigger_hits?: TriggerHit[];
  /**
   * v3.5 strategy library (design notes): the strategies the model may pick
   * from this episode, already resolved to their head versions by the caller (the library does the DB I/O,
   * buildContext stays pure). Empty / absent → only `playbook_text` is rendered, exactly like v4.
   */
  strategies?: StrategySpec[];
  /** Bars visible at `now`, by timeframe — the strategies' checklist hooks need raw klines, features are not enough. */
  klines?: Record<string, Kline[]>;
  /** v3.9:这个币被用户标成只观察(PROPOSE 不是合法边)。 */
  watch_only?: boolean;
  /** v7 失效确认口径(workflow;eval 不传 → 2 根 / 0.2 ATR)。 */
  invalidation_confirm_bars?: number;
  invalidation_buffer_atr?: number;
  /** Funding-rate history (fapi/v1/fundingRate) for the 30-day z-score; absent → that line says "不可得". */
  funding_history?: { at: number; rate: string }[];
}

export interface BuiltContext {
  evidence: Evidence[];
  system_text: string;
  user_text: string;
  context_text: string;
  context_hash: string;
  allowed_actions: string[];
  /** Judgment-graph node this context was built for (design notes). */
  node: NodeId;
  /** Strategy ids the judgment's `strategy_id` is validated against (empty = no strategy contract this episode). */
  strategy_ids: string[];
}

const STALE_MS = 3 * 60_000;
const MARKET_STATE_STALE_MS = 3 * 3_600_000;

function fmt(n: number, d = 0): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

export function buildContext(inp: EpisodeInputs): BuiltContext {
  const ev: Evidence[] = [];
  const add = (kind: string, label: string, value: string, observed_at: number, source: string, stale?: boolean): string => {
    const ref = `E${ev.length + 1}`;
    ev.push({ ref, kind, label, value, observed_at, source, stale: stale ?? inp.now - observed_at > STALE_MS });
    return ref;
  };

  const m = inp.market;
  add('market', '最新价 / 标记价', `last ${m.last}, mark ${m.mark}`, m.as_of, 'fapi premiumIndex+ticker');
  // Empty string = "this number does not exist for this timestamp" (blind backtests: funding before the
  // history endpoint's reach, open interest at all). We drop the evidence line rather than register a
  // fabricated 0 the model could quote — live always has both, so live is unaffected.
  if (m.funding_rate !== '') add('market', '资金费率', `${(Number(m.funding_rate) * 100).toFixed(4)}% (下次 ${new Date(m.next_funding_at).toISOString().slice(11, 16)} UTC)`, m.as_of, 'fapi premiumIndex');
  if (m.open_interest !== '')
    add(
      'market',
      '持仓量 OI',
      `${Number(m.open_interest).toFixed(0)} ${baseAsset(inp.symbol)}${inp.oi_change_1h_pct === null ? '' : `, 较 1h 前 ${inp.oi_change_1h_pct >= 0 ? '+' : ''}${inp.oi_change_1h_pct.toFixed(2)}%`}`,
      m.as_of,
      'fapi openInterest(+hist)',
    );
  const t = inp.ticker24h;
  add('market', '24h 变动 / 高低', `${t.priceChangePercent}%, H ${t.highPrice} L ${t.lowPrice}, 成交额 ${(Number(t.quoteVolume) / 1e6).toFixed(0)}M USDT`, m.as_of, 'fapi ticker/24hr');

  for (const f of inp.features) {
    const trend = f.ema20 > f.ema50 ? 'EMA20>EMA50(偏多)' : 'EMA20<EMA50(偏空)';
    const pos = f.last_close > f.ema20 ? '价在 EMA20 上' : '价在 EMA20 下';
    const d = f.last_close > 100 ? 0 : f.last_close > 1 ? 2 : 5;
    add(
      'structure',
      `${f.tf} 结构`,
      `收 ${fmt(f.last_close, d)}; ${trend}, ${pos}; EMA20 ${fmt(f.ema20, d)} EMA50 ${fmt(f.ema50, d)}; ATR14 ${fmt(f.atr14, d)} (${fmt((f.atr14 / f.last_close) * 100, 2)}%); 20根高 ${fmt(f.swing_high_20, d)}(距 ${fmt(f.dist_to_high20_pct, 2)}%) 低 ${fmt(f.swing_low_20, d)}(距 ${fmt(f.dist_to_low20_pct, 2)}%); 50根高 ${fmt(f.swing_high_50, d)} 低 ${fmt(f.swing_low_50, d)}; 最近一根 ${f.change_pct_last >= 0 ? '+' : ''}${fmt(f.change_pct_last, 2)}%, 近5根 ${f.change_pct_5 >= 0 ? '+' : ''}${fmt(f.change_pct_5, 2)}%; 量比 ${fmt(f.vol_ratio_20, 2)}`,
      f.last_open_time,
      `fapi klines ${f.tf}`,
      false,
    );
  }
  if (inp.features[0]) add('structure', `${inp.features[0].tf} 最近 4 根`, inp.features[0].last_bars, inp.features[0].last_open_time, `fapi klines ${inp.features[0].tf}`, false);

  // v4 boundary metrics (design notes 「v4:边界规则化」): the two decisions the model was
  // flipping on (NO_TRADE↔WATCH, HOLD↔EXIT) get one code-computed checklist each, so system rules 7/8 can be
  // stated as "read this line" and every derived number the model may quote has a registered source.
  if (inp.mode === 'scan') {
    // Thresholds come from the active breakout strategy when there is one (its params are the versioned
    // knobs: chase distance, retest volume, breakout window); raw klines let the checklist see the window.
    const bo = (inp.strategies ?? []).find((st) => st.id === 'breakout_retest') ?? (inp.strategies ?? [])[0];
    const chk = scanChecklist(inp.features, inp.klines?.[inp.features[0]?.tf ?? ''] ?? undefined, bo ? scanThresholdsOf(bo) : undefined);
    if (chk && inp.features[0]) add('checklist', '扫描清单(代码计算)', chk.text, inp.features[0].last_open_time, 'scanChecklist()', false);
  } else if (inp.thread && (inp.thread.status === 'pending_entry' || inp.thread.status === 'in_position')) {
    const th = inp.thread;
    const status: 'pending_entry' | 'in_position' = th.status === 'in_position' ? 'in_position' : 'pending_entry';
    const rm = reviewMetrics({
      now: inp.now,
      side: th.side,
      status,
      mark: m.mark,
      entry: th.filled_avg_price ?? th.entry.price,
      entry_zone: th.entry.zone,
      stop: th.stop_price,
      take_profits: th.take_profits,
      invalidation_text: th.invalidation_text,
      opened_at: th.opened_at,
      created_at: th.created_at,
      tf_ms: tfToMs(th.timeframe),
      features: inp.features,
      klines: inp.klines?.[th.timeframe],
      invalidation_confirm_bars: inp.invalidation_confirm_bars,
      invalidation_buffer_atr: inp.invalidation_buffer_atr,
    });
    if (rm) add('position', status === 'in_position' ? '持仓度量(代码计算)' : '挂单度量(代码计算)', rm.text, m.as_of, 'reviewMetrics()');
  }

  // v3.5 strategy library: each active strategy may add its own code-computed checklist line (the ones that
  // reuse 扫描清单 add nothing). Same contract as every other evidence line: registered, sourced, citable.
  const activeStrategies = inp.strategies ?? [];
  for (const st of activeStrategies) {
    for (const line of strategyEvidence(st, {
      now: inp.now,
      symbol: inp.symbol,
      timeframe: inp.features[0]?.tf ?? '15m',
      features: inp.features,
      klines: inp.klines,
      market: inp.market,
      oi_change_1h_pct: inp.oi_change_1h_pct,
      funding_history: inp.funding_history,
      daily_regime: inp.daily_regime ?? null,
      trigger_hits: inp.trigger_hits,
    })) {
      add('checklist', `${st.id}·${line.label}`, line.value, line.observed_at, line.source, false);
    }
  }

  // v3: the higher-timeframe picture and the calendar are computed by code and handed over as evidence
  // (design notes) — the model should cite them, not infer them from a few bars.
  if (inp.daily_regime) add('regime', '日线状态(代码计算)', inp.daily_regime.text, inp.daily_regime.as_of, 'fapi klines 1d → dailyRegime()', false);
  if (inp.session) add('calendar', '交易时段', `${inp.session.text}${inp.session.minutes_to_us_open !== null && inp.session.minutes_to_us_open > 0 && inp.session.minutes_to_us_open <= 120 ? `;距美股开盘 ${inp.session.minutes_to_us_open} 分钟` : ''}`, inp.now, 'sessionInfo()', false);
  if (inp.trigger_hits && inp.trigger_hits.length) add('trigger', '本次触发器', inp.trigger_hits.map((h) => `${h.kind}:${h.detail}`).join(';'), inp.now, 'detectTriggers()', false);

  // Market state from the information officer (as evidence, so reasons can cite it).
  const ms = inp.market_state;
  if (ms) {
    const stale = inp.now - ms.as_of > MARKET_STATE_STALE_MS;
    add('info', '信息员·市场状态', `${ms.regime} / 偏 ${ms.bias};${ms.summary}`, ms.as_of, `信息员 ${ms.model}`, stale);
    const asset = baseAsset(inp.symbol);
    const major = ms.majors.find((x) => x.symbol === inp.symbol);
    if (major) add('info', `信息员·${inp.symbol} 数据`, `24h ${major.change_24h_pct}%, 资金费率 ${major.funding_rate}, OI 1h ${major.oi_change_1h_pct ?? 'n/a'}%, 多空账户比 ${major.long_short_ratio ?? 'n/a'}, 主动买卖比 ${major.taker_buy_sell_ratio ?? 'n/a'}, 恐惧贪婪 ${ms.sentiment.fng ?? 'n/a'}`, ms.as_of, '信息员数值段', stale);
    const relevantNews = ms.news.filter((n) => n.relevance !== 'low' || n.title.toUpperCase().includes(asset)).slice(0, 3);
    for (const n of relevantNews) add('info', `新闻·${n.source}`, `<untrusted_data>${n.title} —— ${n.digest}</untrusted_data>`, n.published_at, n.source, inp.now - n.published_at > 6 * 3_600_000);
    if (ms.risk_events.length) add('info', '信息员·风险事件', ms.risk_events.join(';'), ms.as_of, '信息员', stale);
    const cand = ms.candidates.find((c) => c.symbol === inp.symbol);
    if (cand) add('info', '信息员·候选', `${cand.direction === 'long' ? '做多' : '做空'}候选:${cand.why}(只是线索,需按 playbook 重新判断)`, ms.as_of, '信息员', stale);
  }

  const a = inp.account;
  const pos = a.positions.find((p) => p.symbol === inp.symbol);
  const posText = pos ? `${pos.side === 'long' ? '多' : '空'} ${pos.qty} @ ${pos.entry_price}, 标记 ${pos.mark_price}, 浮盈亏 ${pos.unrealized_pnl} USDT` : '本币无持仓';
  const others = inp.open_threads.filter((x) => x.symbol !== inp.symbol).map((x) => `${x.symbol} ${x.side === 'long' ? '多' : '空'}(${x.status === 'in_position' ? '持仓中' : '待入场'})`);
  const accountSource = a.backend === 'demo' ? 'Binance demo-fapi' : a.backend === 'agent_mcp' ? 'Binance Agentic 子账户(MCP)' : a.backend === 'cli' ? 'binance-cli(demo)' : '本地纸面账户';
  add('account', '账户', `${a.quality === 'unfunded' ? '执行通道账户未入金(读取成功,权益 0):不能开新仓;' : ''}权益 ${a.equity} USDT, 可用 ${a.available}, 未实现 ${a.unrealized_pnl}; ${inp.symbol}: ${posText}; 其他线程: ${others.join('、') || '无'}`, a.as_of, accountSource);

  // The allowed edge set comes from the judgment graph — the same table the reducer and the eval read.
  // 行情快照(最新价/标记价那条 E)过期 → scan:stale 节点,PROPOSE 不在允许集里(graph v2)。
  const marketStale = ev.some((e) => e.kind === 'market' && e.label === '最新价 / 标记价' && e.stale);
  const node = nodeFor(inp.mode === 'review' ? inp.thread : null, inp.halted, marketStale, inp.watch_only === true);
  const allowed: string[] = allowedActions(node);

  const system = [
    '你是 Trading Swarm 的判断模块。你不是聊天助手,不做寒暄。你只在被事件唤醒时读一次新鲜状态,维护一个交易论点(thesis),并输出一个有限的判断。',
    '硬红线:',
    '1. 数量、杠杆、风险预算由代码决定,你只给方向、入场方式(市价或限价区间)、止损价、止盈价(可给 1-2 个)和理由。',
    '2. 只能引用下面登记过的证据编号(E1、E2…);每条 reason 末尾必须用 [E3] 这种形式标注依据,没有依据的话不要写这条理由。',
    '2b. reasons / thesis 里出现的每个数字都必须是证据里逐字出现的原数(可以说"距 20 根高点 0.33%",不能自己算"止损距离 250");你自己算出来的价位只允许写在 proposal 的字段里。',
    '3. 没有足够优势就输出 NO_TRADE 或 WATCH,这是正常且重要的结果,不要为了"有动作"而交易。',
    '4. 标了 STALE 的证据不能作为 PROPOSE 的依据;信息员的候选只是线索,不是理由。',
    '4b. 标了「记忆」的证据是过去批准的教训/偏好/事实,只能用来调整倾向与信心,不能覆盖现场行情与账户数据;记忆里的价格、盈亏数字不是行情数字,不要当作当前价位引用。',
    '5. 止损价必须在入场价的另一侧:做多止损 < 入场价,做空止损 > 入场价;距离在入场价的 0.3% 到 5% 之间。限价入场时 limit_price 放在 entry_zone 靠近现价的一端。',
    '6. 只输出一个 JSON 对象,不要 markdown,不要解释文字。所有文字字段用简体中文,面向没有看过代码的交易员。',
    '7. 扫描先按「可用策略」(没有策略块时按 playbook)判断是否符合 PROPOSE 条件。清单里的「收破突破位」比较前 20 根(不含当根)的高/低点;「回踩确认=是」时应按当前启用策略考虑 PROPOSE,符合条件才给出 proposal,不符合则在 reasons 里写清缺少的条件。未满足 PROPOSE 条件时,WATCH/NO_TRADE 分界以「扫描清单(代码计算)」为准,不要自己重算:watch_eligible=是(1h/4h 同向、价距对应突破位在追单上限以内、回踩尚未确认)才可以 WATCH;watch_eligible=否 则 NO_TRADE。回踩已确认时不要退回 WATCH。理由必须引用这条清单证据的编号。',
    '8. 持仓复查以「持仓度量(代码计算)」为准,规则是不对称的:触及风险底线必须离场,结构证据可以支持提前离场,不设必须先亏到某个 R 才准离场的门槛。\n   ① 必须 EXIT:度量写明最近一根已收盘 K 线「已越过止损一侧」。此时无条件离场,不能用等待反弹的理由 HOLD 或 REDUCE。止损是唯一的硬离场线。\n   ② 可以 EXIT(由你判断):a)「失效确认=是」(失效价被连续越过达到确认口径),或 b)「论点趋势翻转=是」(当前 15m 或 1h 的 EMA20-vs-EMA50 方向与持仓方向相反),或 c)「结构转弱=是」且浮盈 ≤ 0R。失效价只越过一根、深度不足确认口径时不是①,也不必走:看结构是否仍完好(1h/4h 同向、价在 EMA20 有利侧)再定;记忆里若有用户关于失效确认的偏好(如要几根、要多深),优先按偏好判。理由必须同时引用这条度量证据和一条支持离场的结构证据的编号。\n   ③ HOLD:论点未破且未触发①时默认持有;若②或④成立,可以依据证据选择相应降风险动作。\n   ④ 可以 REDUCE:未触发①、浮盈 ≥ +1R 且「结构转弱=是」时可以减半。\n   ⑤ INVALIDATE 只用于挂单未成交的线程;持仓中要走用 EXIT。以上复查理由必须引用这条度量证据的编号。',
    '8b. 系统处于紧急停止(节点 scan:halted)时唯一合法的 action 是 NO_TRADE:不要输出 WATCH、PROPOSE 或任何别的动作,即便行情看起来有机会;输出别的动作会被判为越权并作废。',
    ...(activeStrategies.length
      ? [
          '9. 只能用「可用策略」里的那几条;PROPOSE 必须填 strategy_id,规则未允许的形态不要 PROPOSE。',
        ]
      : []),
    '',
    '输出契约(严格):',
    '{"action":"NO_TRADE|WATCH|PROPOSE|HOLD|REDUCE|EXIT|INVALIDATE","direction":"long|short|null","confidence":0.0-1.0,"headline":"≤40字一句话","thesis":"≤200字的论点","reasons":["… [E1]","… [E4]"],"evidence_refs":["E1","E4"],"invalidation":"失效条件(人话)或null","invalidation_price":"十进制字符串或null","target_price":"十进制字符串或null","watch_conditions":["下次要看什么"],"strategy_id":"策略 id 或 null","proposal":null 或 {"direction":"long|short","entry":"market|limit","limit_price":"…或null","entry_zone":["低","高"] 或 null,"stop_price":"必填","take_profits":["第一止盈","第二止盈(可选)"],"rationale":"一句话"}}',
    '',
    ...(activeStrategies.length ? ['可用策略:', renderStrategies(activeStrategies), ''] : []),
    activeStrategies.length ? '补充说明(用户写的,不覆盖策略):' : `Playbook(${PROMPT_VERSION}):`,
    inp.playbook_text,
  ].join('\n');

  const lines: string[] = [];
  const trig = inp.trigger.kind === 'kline_close' || inp.trigger.kind === 'scan' ? 'K 线收盘扫描' : inp.trigger.kind === 'manual' ? '手动触发' : inp.trigger.kind === 'thread_review' || inp.trigger.kind === 'position_review' ? '线程复查' : inp.trigger.kind === 'order_filled' ? '入场成交后复查' : inp.trigger.kind === 'info_update' ? '信息员更新后复查' : inp.trigger.kind === 'chat' ? '对话中触发' : inp.trigger.kind;
  lines.push(`## 触发\n${trig}:${inp.trigger.detail}(标的 ${inp.symbol})`);
  lines.push(`\n## 证据登记(编号即 evidence_refs)`);
  for (const e of ev) lines.push(`${e.ref} [${e.label}] ${e.value}${e.stale ? ' (STALE)' : ''}`);
  if (inp.mode === 'review' && inp.thread) {
    const th = inp.thread;
    lines.push(`\n## 复查的线程`);
    lines.push(`${th.symbol} ${th.side === 'long' ? '做多' : '做空'},状态 ${th.status === 'pending_entry' ? '待入场(挂单中)' : '持仓中'},来源 ${th.source};论点:${th.thesis};入场:${th.entry.type === 'market' ? '市价' : `限价 ${th.entry.price}${th.entry.zone ? `(区间 ${th.entry.zone[0]}–${th.entry.zone[1]})` : ''}`}${th.filled_avg_price ? `,成交 @ ${th.filled_avg_price}` : ''};止损 ${th.stop_price ?? '无'};止盈 ${th.take_profits.join(' / ') || '无'};失效条件:${th.invalidation_text ?? '(无)'};上次要看的:${th.watch_conditions.join('、') || '(无)'};建立于 ${new Date(th.created_at).toISOString().slice(5, 16).replace('T', ' ')} UTC`);
  } else {
    lines.push(`\n## 当前状态\n${inp.symbol} 无线程。${inp.open_threads.length ? `其他线程 ${inp.open_threads.length} 条。` : ''}`);
  }
  if (inp.last_judgment_summary) lines.push(`上次对本币的判断:${inp.last_judgment_summary}`);
  lines.push(`\n## 任务`);
  const task =
    inp.mode === 'review'
      ? inp.thread?.status === 'pending_entry'
        ? '挂单还没成交。结构没坏就 HOLD 继续等;结构坏了或价格已远离入场区就 INVALIDATE(会撤单)。'
        : '你有持仓,请按规则 8 复查论点是否仍成立:HOLD / REDUCE(减半)/ EXIT(全平)。'
      : '你没有本币的线程,请判断是否有符合 playbook 的机会;有就 PROPOSE 并给 proposal;没有就 NO_TRADE 或 WATCH 并写清 watch_conditions。';
  lines.push(`现在时间 ${new Date(inp.now).toISOString()}。允许的 action:${allowed.join(' / ') || '(紧急停止中,无)'}。${task}${inp.halted ? ' 系统处于紧急停止:这次唯一合法的 action 是 NO_TRADE(规则 8b),WATCH 也不行。' : inp.watch_only && inp.mode === 'scan' ? ' 这个币被用户标为「只观察」:不能 PROPOSE,只能 NO_TRADE 或 WATCH,照常写清值不值得开放交易。' : node === 'scan:stale' ? ' 行情快照已过期(节点 scan:stale):这次不能 PROPOSE,只能 NO_TRADE 或 WATCH;形态再好也先写进 watch_conditions,等新快照再判。输出 PROPOSE 会被判为越权并作废。' : ''}`);
  lines.push('只输出 JSON。');
  const user = lines.join('\n');
  const context_text = `[system]\n${system}\n\n[user]\n${user}`;
  return { evidence: ev, system_text: system, user_text: user, context_text, context_hash: createHash('sha256').update(context_text).digest('hex'), allowed_actions: allowed, node, strategy_ids: activeStrategies.map((s) => s.id) };
}
