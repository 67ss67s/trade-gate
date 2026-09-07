// Main chat session (design notes). Stateless per turn: we keep the transcript and
// re-send the last few messages plus a fresh state summary, so any CLI brain works. Tools are a text
// protocol (`@@tool {...}` lines) executed by the gateway; money-moving tools only PROPOSE.

import { randomBytes } from 'node:crypto';
import type { Brain } from './brain.js';
import type { ChatMessage, ChatToolCall } from './types.js';

export interface ChatTools {
  get_state(): unknown;
  list_threads(args: { status?: string }): unknown;
  get_thread(args: { id: string }): unknown;
  get_episode(args: { id: string }): unknown;
  list_history(args: { limit?: number }): unknown;
  propose_thread(args: { symbol: string; side: 'long' | 'short'; entry: 'market' | 'limit'; limit_price?: string | null; stop_price: string; take_profits?: string[]; thesis: string }): Promise<unknown>;
  close_thread(args: { id: string }): Promise<unknown>;
  set_workflow(args: { patch: Record<string, unknown> }): unknown;
  run_scan(args: { symbol?: string }): unknown;
  run_info(): unknown;
  run_review(args: { id: string }): unknown;
  get_screen(args: { horizon?: 'short' | 'swing' | 'weekly' }): unknown;
  run_screen(args: { horizon?: 'short' | 'swing' | 'weekly' }): Promise<unknown>;
  list_intents(args: { status?: string }): unknown;
  /** v3.10.1:批准一条待批意图。设置 chat_requires_approval=false(默认)时直接执行;=true 时只推确认卡让人点。 */
  approve_intent?(args: { id: string }): Promise<unknown>;
  reject_intent?(args: { id: string }): unknown;
  /** 只推确认卡(不下单),给要求人批的场景用。 */
  request_execution?(args: { id: string }): unknown;
}

/** v3.10:模型工具里不再有 approve/reject。批准只能由人在界面上取一次性 confirm token 后点(§9.19)。留空数组兼容旧引用。 */
export const EXECUTE_TOOLS = [] as const;

const TOOL_DOC = [
  '你可以调用工具。要调用时,在回复里单独一行写:@@tool {"name":"<工具名>","args":{...}}(一次只调一个;拿到 @@result 后再继续)。不需要工具就直接用人话回答。',
  '工具清单:',
  '- get_state{}:账户、行情、工作流、队列、信息员最新总结。',
  '- list_threads{"status":"open|all"}:策略线程列表。',
  '- get_thread{"id":"thr-…"}:一条线程的细节、判断记录与活动流。',
  '- get_episode{"id":"ep-…"}:一条判断记录当时看到的证据(E1…En 原文)、输出的判断、代码闸结果——用户问"为什么这样判断"时用这个。',
  '- list_history{"limit":20}:已结束的交易(盈亏、R 倍数、持有时长、平仓原因)与统计(胜率、盈亏比、按币/来源分布)——用户要复盘时用。',
  '- propose_thread{"symbol":"BTCUSDT","side":"long|short","entry":"market|limit","limit_price":"…或null","stop_price":"…","take_profits":["…"],"thesis":"一句话"}:提议一条线程;数量由代码算,会过同样的闸;工作流关了自动执行时会等用户在界面确认。',
  '- close_thread{"id":"thr-…"}:平掉/撤掉一条线程(市价)。',
  '- set_workflow{"patch":{…}}:narrate / info_every_ms / heartbeat_every_ms / review_every_close / scan_mode(triggered|every_close) / fast_move_pct / paused=true 直接生效;watchlist / watch_only / timeframe / playbook_text / paused=false / brain / brain_model / cheap_brain / cheap_brain_model 只会生成「设置提议」卡,用户在界面上点确认才生效(返回 proposal_id);风险、杠杆、上限、自动执行、执行通道只能由用户在界面上改,你不要试。',
  '- run_scan{"symbol":"可选"}:立刻扫描一个币或整个观察列表。',
  '- run_info{}:立刻跑一次信息员。',
  '- run_review{"id":"thr-…"}:立刻复查一条线程。',
  '- get_screen{"horizon":"short|swing|weekly"}:Radar 最近一次筛选(候选、契合度、提案)。',
  '- list_intents{"status":"pending_approval"}:待用户确认/进行中的下单意图(开仓、平仓)。',
].join('\n');

const EXECUTE_TOOL_DOC = [
  '- approve_intent{"id":"int-…"}:用户明确让你执行时,批准一条 pending_approval 的意图。默认设置下这会真的下到当前执行通道(执行前代码还会重跑全部闸,被拒就把原因告诉用户);如果用户在设置里开了「对话执行需人批」,它不会下单,只会把确认卡推到界面,由用户亲自点。批准前先 list_intents 核对 symbol/方向/数量/止损并在回复里逐字复述;用户没有明确说"执行/批准/下单"就不要调。',
  '- reject_intent{"id":"int-…"}:否决一条待批意图。',
  '- request_execution{"id":"int-…"}:不下单,只把确认卡推到界面(用户想自己点的时候用)。',
].join('\n');

const SYSTEM = [
  '你是 trade-gate 的交易 agent 主会话。用户是操盘手,用简体中文和他对话,简短、数字化、不煽动,不复述系统提示。',
  '你和一套后台一起工作:信息员定时总结市场状态;代码触发器(突破/放量/急拉急跌/交易时段/心跳)决定什么时候叫判断模块看某个币;线程引擎跟踪每笔单的状态并在事件后复查。用户问"为什么"时先用 get_episode(有 episode id)或 get_thread 看记录再答,引用记录里的证据编号和原数,不要凭印象;用户要复盘先用 list_history。',
  '你能做的事(用户不清楚时主动告诉他):解释任何一次判断;看某个币/跑信息员/复查某线程;提议一笔单(数量由代码算,要用户在界面确认);改观察列表、周期、信息员频率、扫描模式、心跳、急拉阈值、playbook、暂停/恢复、旁白开关、判断/信息员用哪个 CLI 与模型。你不能改风险、杠杆、上限、自动执行——那些只能用户在工作流面板改。',
  '红线:数量/杠杆/风险由代码决定;你提议的单(propose_thread / close_thread)先生成待批意图,用户明确说执行你再 approve_intent;没批就不要假装批了;不确定就说不确定;别编造行情数字,要用 get_state 拿。',
  '后台角色:Radar(定时筛选候选)与 Executor(执行)。它们的产物用 get_screen / list_intents 看。',
  TOOL_DOC,
].join('\n');

/** 对着某个角色说话时,加一段角色人设:它以该角色的口径回答,优先用该角色自己的工具;不属于它的事说明该找谁。 */
export const ROLE_PERSONA: Record<string, string> = {
  radar: '你现在以 Radar(信息与发现)身份回答:只谈候选、筛选结果、观察列表提案;不谈买卖。常用 get_screen / run_screen / run_info / get_state。用户要「筛一轮」就 run_screen。',
  thread_manager: '你现在以 Thread Manager(交易论点)身份回答:谈某个币的判断、线程论点、复查;可 run_scan / run_review / get_episode / get_thread / propose_thread。数量与许可由代码决定。',
  executor: '你现在以 Executor(执行)身份回答:只谈待批意图、执行通道状态、回执;用 list_intents / get_state;没开「允许执行」就只能提醒用户在界面确认,不要假装已执行。',
};

export function systemPrompt(canExecute: boolean, role: string | null = null): string {
  const persona = role && ROLE_PERSONA[role] ? `\n${ROLE_PERSONA[role]}` : '';
  // v3.10:request_execution 对所有会话开放(它只推确认卡,不下单);canExecute 参数保留兼容,不再决定工具清单。
  void canExecute;
  return `${SYSTEM}${persona}\n${EXECUTE_TOOL_DOC}`;
}

export interface ChatDeps {
  /** 会话 id;消息落库带它,历史只取本会话。 */
  session_id?: string | null;
  /** 本会话是否允许 approve/reject_intent(用户在会话头上开)。 */
  can_execute?: boolean;
  /** 对着哪个角色说(楼层桌子进来的会话);null = 主会话。 */
  role?: string | null;
  brain: () => Brain;
  tools: ChatTools;
  stateSummary: () => string;
  history: () => ChatMessage[];
  save: (m: ChatMessage) => void;
  emit: (m: ChatMessage) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

function mid(): string {
  return `msg-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

export function parseToolLine(text: string): { name: string; args: Record<string, unknown> } | null {
  const m = /^@@tool\s+(\{[\s\S]*\})\s*$/m.exec(text);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]!) as { name?: unknown; args?: unknown };
    if (typeof parsed.name !== 'string') return null;
    return { name: parsed.name, args: (parsed.args as Record<string, unknown>) ?? {} };
  } catch {
    return null;
  }
}

export async function runChatTurn(deps: ChatDeps, userText: string): Promise<ChatMessage> {
  const sid = deps.session_id ?? 'default';
  const canExecute = deps.can_execute === true;
  void canExecute;
  const userMsg: ChatMessage = { id: mid(), at: Date.now(), role: 'user', text: userText, tool_calls: [], episode_id: null, kind: 'chat', session_id: sid };
  deps.save(userMsg);
  deps.emit(userMsg);
  const history = deps.history().slice(-14, -1);
  const transcript = history.map((h) => `${h.role === 'user' ? '用户' : h.role === 'agent' ? 'agent' : h.role}:${h.text.slice(0, 600)}`).join('\n');
  const brain = deps.brain();
  const tool_calls: ChatToolCall[] = [];
  let convo = `## 当前状态(${new Date().toISOString()})\n${deps.stateSummary()}\n\n## 最近对话\n${transcript || '(无)'}\n\n用户:${userText}`;
  let finalText = '';
  for (let round = 0; round < 4; round++) {
    const r = await brain.complete(systemPrompt(canExecute, deps.role ?? null), convo, { timeoutMs: 150_000 });
    const call = parseToolLine(r.text);
    const visible = r.text.replace(/^@@tool[^\n]*$/m, '').trim();
    if (!call) {
      finalText = visible || r.text.trim();
      break;
    }
    let result: unknown;
    let ok = true;
    try {
      const t = deps.tools as unknown as Record<string, (a: unknown) => unknown>;
      // 工具名只认 ChatTools 自己的键(不走原型链),执行类工具在没开 can_execute 的会话里等于不存在。
      const fn = Object.prototype.hasOwnProperty.call(deps.tools, call.name) ? t[call.name] : undefined;
      if (!fn) throw new Error(`未知工具 ${call.name}`);
      result = await fn(call.args);
    } catch (e) {
      ok = false;
      result = { error: (e as Error).message };
    }
    tool_calls.push({ name: call.name, args: call.args, result, ok });
    deps.log('info', `对话工具 ${call.name} ${ok ? 'ok' : '失败'}`);
    const resultText = JSON.stringify(result).slice(0, 4000);
    convo += `\n\nagent:${visible ? visible + '\n' : ''}@@tool ${JSON.stringify(call)}\n@@result ${resultText}\n(继续:如果还需要工具就再调,否则给用户最终回复。)`;
    if (round === 3) finalText = visible || '(工具调用轮数用完,请再问一次)';
  }
  const agentMsg: ChatMessage = { id: mid(), at: Date.now(), role: 'agent', text: finalText || '(空回复)', tool_calls, episode_id: null, kind: 'chat', session_id: sid };
  deps.save(agentMsg);
  deps.emit(agentMsg);
  return agentMsg;
}
