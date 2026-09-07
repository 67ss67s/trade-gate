// Workflow settings (design notes): the one object the user edits from the UI.
// Bounds are enforced here so neither the UI nor the chat tool can push the loop somewhere silly.

import { CLI_COMMAND_MAX_CHARS, CLI_NAMES, defaultCliCommands, type CliName } from './cli-launch.js';
import { DEFAULT_ACTIVE_STRATEGIES } from './strategies.js';
import { DEFAULT_SCREEN_SYMBOLS } from './bar-metrics.js';
import type { AgentCliKind, Backend, BrainKind, CliCommandsView, Workflow } from './types.js';

export const DEFAULT_PLAYBOOK = [
  '突破-回踩(单一策略,v3):',
  '- 适用:交易方向与 1h 趋势一致(EMA20 与 EMA50 同向),且 4h 不是明显反向趋势(4h 反向时只允许限价挂回踩位、信心 ≤ 0.5);价格刚突破 20 根高/低点,或回踩 EMA20 站稳。',
  '- 入场两种形态:①回踩已确认(最近一根收在突破位之上/之下,量比 ≥ 1.0)→ 市价;②突破刚发生、回踩还没来 → PROPOSE 一个限价 entry_zone 挂在突破位到 EMA20 之间,等它回来(不成交下一根会复查要不要撤)。不要因为"还没回踩"就只 WATCH——挂限价就是等回踩的方式。',
  '- 不追:距离 20 根高/低点已超过 1.5 个 ATR 的位置不追;资金费率绝对值 > 0.05% 且与方向同侧时降低信心。',
  '- NO_TRADE 条件:1h 与 4h 明显反向(4h 价格在 EMA20/EMA50 的另一侧且距离 > 1 ATR);价格夹在 EMA20 与 EMA50 之间震荡;ATR% < 0.4%(没波动);信息员标了高相关的风险事件在 2 小时内。',
  '- 日线状态(代码算的证据):bear 时不做多突破(只允许做空或 NO_TRADE),bull 时不做空突破;range 时突破要求量比 ≥ 1.5;volatile 时止损至少 1.2 ATR。',
  '- 交易时段:美股开盘窗口(开盘后 15 分钟内)不追单,等第一根 15m 收盘再判断;周末流动性差,只做回踩确认过的入场。',
  '- 急拉急跌触发(fast_move):先判断是不是新闻驱动(看信息员证据),没有新闻的急拉急跌大概率均值回归,不追;有新闻且与 1h 趋势同向才考虑回踩入场。',
  '- 失效:收盘跌回突破位另一侧,或触及止损。',
  '- 止损放在最近 swing 低/高之外(至少 0.8 ATR),第一止盈至少 1.5 倍止损距离,可给第二止盈。',
  '- 有持仓时:论点未变 → HOLD;触及失效条件 → EXIT;浮盈超过 1 倍止损距离且结构转弱 → REDUCE;演示版不允许 ADD。',
  '- 挂单等待中:结构没坏 → HOLD;结构坏了或价格已远离入场区 → INVALIDATE(撤单)。',
].join('\n');

export const DEFAULT_WORKFLOW: Workflow = {
  watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
  watch_only: [],
  timeframe: '15m',
  info_every_ms: 30 * 60_000,
  risk_pct: '0.5',
  leverage: 3,
  margin_mode: 'cross',
  max_open_threads: 3,
  max_opens_per_day: 4,
  daily_loss_stop_pct: '3',
  auto_approve: true,
  brain: 'stub',
  cheap_brain: 'stub',
  brain_model: null,
  cheap_brain_model: null,
  playbook_text: DEFAULT_PLAYBOOK,
  paused: false,
  narrate: true,
  chat_requires_approval: false,
  scan_mode: 'triggered',
  heartbeat_every_ms: 30 * 60_000,
  invalidation_confirm_bars: 2,
  invalidation_buffer_atr: 0.2,
  fast_move_pct: '0.8',
  review_every_close: false,
  // Overwritten at boot by main.ts with the backend it actually constructed (see DemoRuntime.bootExecution).
  execution: 'paper',
  exec_agent_cli: 'claude',
  // Explicit, not "the CLI default": sonnet is the cheap one, and every write op is one CLI run.
  exec_agent_model: 'sonnet',
  daily_judgment_cap: 300,
  screener_enabled: true,
  screener_short_every_ms: 12 * 3_600_000,
  screener_swing_every_ms: 72 * 3_600_000,
  screener_universe: 'watchlist+whitelist',
  screener_symbols: [],
  screener_whitelist: [...DEFAULT_SCREEN_SYMBOLS],
  screener_max_symbols: 60,
  screener_use_brain: true,
  screener_apply: 'propose',
  screener_expectancy: false,
  watchlist_max: 60, // 可调,见 WORKFLOW_BOUNDS.watchlist_max;每多一个币 = 多一份心跳/收盘判断的钱(09-06 放开:原 8/上限 24)
  // Boot default per CLI: TG_DEMO_CLI_CLAUDE / _CODEX / _PI, else the bare name (cli-launch.ts).
  cli_commands: defaultCliCommands(),
  active_strategies: [...DEFAULT_ACTIVE_STRATEGIES],
  updated_at: 0,
};

export const WORKFLOW_BOUNDS = {
  watchlist_max: [1, 300] as const,
  timeframes: ['1m', '3m', '5m', '15m', '30m', '1h', '4h'],
  info_every_ms: [2 * 60_000, 6 * 3_600_000] as const,
  risk_pct: [0.1, 2] as const,
  leverage: [1, 10] as const,
  max_open_threads: [1, 6] as const,
  max_opens_per_day: [1, 12] as const,
  daily_loss_stop_pct: [0.5, 20] as const,
  playbook_max_chars: 4000,
  heartbeat_every_ms: [5 * 60_000, 4 * 3_600_000] as const,
  invalidation_confirm_bars: [1, 5] as const,
  invalidation_buffer_atr: [0, 1] as const,
  fast_move_pct: [0.2, 5] as const,
  /** 0 = unlimited; the upper bound is a guard against a fat-fingered 30000. */
  daily_judgment_cap: [0, 5000] as const,
  cli_command_max_chars: CLI_COMMAND_MAX_CHARS,
  active_strategies_max: 4,
};

/** Strategy ids are file-name-ish on purpose: they end up in prompts, tags and route paths. */
export const STRATEGY_ID_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Rough model calls per hour for the UI / logs (design notes). */
export function estimateCallsPerHour(w: Workflow): { min: number; max: number } {
  const tfMin = Math.max(1, tfMinutes(w.timeframe));
  const n = w.watchlist.length;
  if (w.scan_mode === 'every_close') {
    const per = n * (60 / tfMin);
    return { min: Math.round(per), max: Math.round(per) };
  }
  const heartbeat = n * (60 / Math.max(5, w.heartbeat_every_ms / 60_000));
  return { min: Math.round(heartbeat), max: Math.round(heartbeat + n * 4) };
}

function tfMinutes(tf: string): number {
  const m = /^(\d+)([mh])$/.exec(tf);
  if (!m) return 15;
  return Number(m[1]) * (m[2] === 'h' ? 60 : 1);
}

export const BRAINS: BrainKind[] = ['pi', 'claude', 'codex', 'stub'];
/** Execution backends the workflow may name. */
export const BACKENDS: Backend[] = ['paper', 'demo', 'cli', 'agent_mcp'];
export const AGENT_CLIS: AgentCliKind[] = ['claude', 'codex'];
/** Model ids are passed to a CLI as an argument: keep them to a conservative charset. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export function applyWorkflowPatch(current: Workflow, patch: Record<string, unknown>): { next: Workflow; errors: string[] } {
  const errors: string[] = [];
  const next: Workflow = { ...current };
  const clampNum = (v: unknown, [lo, hi]: readonly [number, number], field: string): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      errors.push(`${field} 必须是数字`);
      return null;
    }
    return Math.min(hi, Math.max(lo, n));
  };
  if ('watchlist' in patch) {
    const raw = patch['watchlist'];
    if (!Array.isArray(raw)) errors.push('watchlist 必须是数组');
    else {
      const list = [...new Set(raw.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z0-9]{2,20}USDT$/.test(s)))];
      if (list.length === 0) errors.push('watchlist 至少一个 USDT 永续,如 BTCUSDT');
      else next.watchlist = list.slice(0, next.watchlist_max);
    }
  }
  if ('timeframe' in patch) {
    const tf = String(patch['timeframe']);
    if (!WORKFLOW_BOUNDS.timeframes.includes(tf)) errors.push(`timeframe 只能是 ${WORKFLOW_BOUNDS.timeframes.join('/')}`);
    else next.timeframe = tf;
  }
  if ('info_every_ms' in patch) {
    const v = clampNum(patch['info_every_ms'], WORKFLOW_BOUNDS.info_every_ms, 'info_every_ms');
    if (v !== null) next.info_every_ms = Math.round(v);
  }
  if ('risk_pct' in patch) {
    const v = clampNum(patch['risk_pct'], WORKFLOW_BOUNDS.risk_pct, 'risk_pct');
    if (v !== null) next.risk_pct = String(Math.round(v * 100) / 100);
  }
  if ('leverage' in patch) {
    const v = clampNum(patch['leverage'], WORKFLOW_BOUNDS.leverage, 'leverage');
    if (v !== null) next.leverage = Math.round(v);
  }
  if ('margin_mode' in patch) {
    if (patch['margin_mode'] !== 'cross' && patch['margin_mode'] !== 'isolated') errors.push('margin_mode 只能是 cross/isolated');
    else next.margin_mode = patch['margin_mode'];
  }
  if ('max_open_threads' in patch) {
    const v = clampNum(patch['max_open_threads'], WORKFLOW_BOUNDS.max_open_threads, 'max_open_threads');
    if (v !== null) next.max_open_threads = Math.round(v);
  }
  if ('max_opens_per_day' in patch) {
    const v = clampNum(patch['max_opens_per_day'], WORKFLOW_BOUNDS.max_opens_per_day, 'max_opens_per_day');
    if (v !== null) next.max_opens_per_day = Math.round(v);
  }
  if ('daily_loss_stop_pct' in patch) {
    const v = clampNum(patch['daily_loss_stop_pct'], WORKFLOW_BOUNDS.daily_loss_stop_pct, 'daily_loss_stop_pct');
    if (v !== null) next.daily_loss_stop_pct = String(Math.round(v * 10) / 10);
  }
  if ('auto_approve' in patch) {
    if (typeof patch['auto_approve'] !== 'boolean') errors.push('auto_approve 必须是布尔');
    else next.auto_approve = patch['auto_approve'];
  }
  for (const f of ['brain', 'cheap_brain'] as const) {
    if (f in patch) {
      const b = patch[f];
      if (typeof b !== 'string' || !BRAINS.includes(b as BrainKind)) errors.push(`${f} 只能是 ${BRAINS.join('/')}`);
      else next[f] = b as BrainKind;
    }
  }
  for (const f of ['brain_model', 'cheap_brain_model'] as const) {
    if (f in patch) {
      const m = patch[f];
      if (m === null || m === '' || m === undefined) next[f] = null;
      else if (typeof m !== 'string' || !MODEL_ID_RE.test(m.trim())) errors.push(`${f} 只能是模型 id(字母数字 . _ : / -,≤ 80 字符),如 zai/glm-5.3 或 sonnet`);
      else next[f] = m.trim();
    }
  }
  if ('playbook_text' in patch) {
    const t = patch['playbook_text'];
    if (typeof t !== 'string') errors.push('playbook_text 必须是字符串');
    else next.playbook_text = t.slice(0, WORKFLOW_BOUNDS.playbook_max_chars);
  }
  // ---- v7 失效确认(用户在界面改;agent 只能看,记忆里的偏好当证据)
  if ('invalidation_confirm_bars' in patch) {
    const n = Number(patch['invalidation_confirm_bars']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.invalidation_confirm_bars[0] || n > WORKFLOW_BOUNDS.invalidation_confirm_bars[1]) errors.push('invalidation_confirm_bars 需在 1–5');
    else next.invalidation_confirm_bars = n;
  }
  if ('invalidation_buffer_atr' in patch) {
    const v = clampNum(patch['invalidation_buffer_atr'], WORKFLOW_BOUNDS.invalidation_buffer_atr, 'invalidation_buffer_atr');
    if (v !== null) next.invalidation_buffer_atr = Math.round(v * 100) / 100;
  }
  // ---- screener (Radar) fields
  for (const f of ['screener_enabled', 'screener_use_brain', 'screener_expectancy'] as const) {
    if (f in patch) {
      if (typeof patch[f] !== 'boolean') errors.push(`${f} 必须是布尔`);
      else next[f] = patch[f] as boolean;
    }
  }
  for (const f of ['screener_short_every_ms', 'screener_swing_every_ms'] as const) {
    if (f in patch) {
      const n = Number(patch[f]);
      if (!Number.isFinite(n) || n < 3_600_000 || n > 30 * 24 * 3_600_000) errors.push(`${f} 需在 1 小时到 30 天之间(毫秒)`);
      else next[f] = Math.round(n);
    }
  }
  if ('screener_max_symbols' in patch) {
    const n = Number(patch['screener_max_symbols']);
    if (!Number.isInteger(n) || n < 1 || n > 300) errors.push('screener_max_symbols 需在 1–300');
    else next.screener_max_symbols = n;
  }
  if ('screener_universe' in patch) {
    const u = patch['screener_universe'];
    if (u !== 'watchlist+whitelist' && u !== 'top_volume' && u !== 'explicit') errors.push('screener_universe 只能是 watchlist+whitelist / top_volume / explicit');
    else next.screener_universe = u;
  }
  if ('screener_apply' in patch) {
    const a = patch['screener_apply'];
    if (a !== 'propose' && a !== 'auto') errors.push('screener_apply 只能是 propose / auto');
    else next.screener_apply = a;
  }
  if ('screener_symbols' in patch) {
    const raw = patch['screener_symbols'];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) errors.push('screener_symbols 必须是字符串数组');
    else next.screener_symbols = [...new Set(raw.map((x) => (x as string).trim().toUpperCase()).filter(Boolean))].slice(0, 300);
  }
  if ('screener_whitelist' in patch) {
    const raw = patch['screener_whitelist'];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) errors.push('screener_whitelist 必须是字符串数组');
    else next.screener_whitelist = [...new Set(raw.map((x) => (x as string).trim().toUpperCase()).filter(Boolean))].slice(0, 300);
  }
  if ('watchlist_max' in patch) {
    const n = Number(patch['watchlist_max']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.watchlist_max[0] || n > WORKFLOW_BOUNDS.watchlist_max[1]) errors.push(`watchlist_max 需在 ${WORKFLOW_BOUNDS.watchlist_max[0]}–${WORKFLOW_BOUNDS.watchlist_max[1]}`);
    else {
      next.watchlist_max = n;
      if (next.watchlist.length > n) next.watchlist = next.watchlist.slice(0, n);
    }
  }
  if ('watch_only' in patch) {
    const raw = patch['watch_only'];
    if (!Array.isArray(raw)) errors.push('watch_only 必须是数组');
    else next.watch_only = [...new Set(raw.map((s) => String(s).trim().toUpperCase()).filter((s) => next.watchlist.includes(s)))];
  }
  // watchlist 变了,watch_only 只保留还在名单里的
  next.watch_only = (next.watch_only ?? []).filter((s) => next.watchlist.includes(s));
  if ('paused' in patch) {
    if (typeof patch['paused'] !== 'boolean') errors.push('paused 必须是布尔');
    else next.paused = patch['paused'];
  }
  if ('narrate' in patch) {
    if (typeof patch['narrate'] !== 'boolean') errors.push('narrate 必须是布尔');
    else next.narrate = patch['narrate'];
  }
  if ('chat_requires_approval' in patch) {
    if (typeof patch['chat_requires_approval'] !== 'boolean') errors.push('chat_requires_approval 必须是布尔');
    else next.chat_requires_approval = patch['chat_requires_approval'];
  }
  if ('scan_mode' in patch) {
    if (patch['scan_mode'] !== 'triggered' && patch['scan_mode'] !== 'every_close') errors.push('scan_mode 只能是 triggered/every_close');
    else next.scan_mode = patch['scan_mode'];
  }
  if ('heartbeat_every_ms' in patch) {
    const v = clampNum(patch['heartbeat_every_ms'], WORKFLOW_BOUNDS.heartbeat_every_ms, 'heartbeat_every_ms');
    if (v !== null) next.heartbeat_every_ms = Math.round(v);
  }
  if ('fast_move_pct' in patch) {
    const v = clampNum(patch['fast_move_pct'], WORKFLOW_BOUNDS.fast_move_pct, 'fast_move_pct');
    if (v !== null) next.fast_move_pct = String(Math.round(v * 100) / 100);
  }
  if ('review_every_close' in patch) {
    if (typeof patch['review_every_close'] !== 'boolean') errors.push('review_every_close 必须是布尔');
    else next.review_every_close = patch['review_every_close'];
  }
  if ('execution' in patch) {
    const b = patch['execution'];
    if (typeof b !== 'string' || !BACKENDS.includes(b as Backend)) errors.push(`execution 只能是 ${BACKENDS.join('/')}`);
    else next.execution = b as Backend;
  }
  if ('exec_agent_cli' in patch) {
    const c = patch['exec_agent_cli'];
    if (typeof c !== 'string' || !AGENT_CLIS.includes(c as AgentCliKind)) errors.push(`exec_agent_cli 只能是 ${AGENT_CLIS.join('/')}`);
    else next.exec_agent_cli = c as AgentCliKind;
  }
  if ('exec_agent_model' in patch) {
    const m = patch['exec_agent_model'];
    if (m === null || m === '' || m === undefined) next.exec_agent_model = null;
    else if (typeof m !== 'string' || !MODEL_ID_RE.test(m.trim())) errors.push('exec_agent_model 只能是模型 id(字母数字 . _ : / -,≤ 80 字符),如 sonnet 或 gpt-5.4');
    else next.exec_agent_model = m.trim();
  }
  if ('active_strategies' in patch) {
    const raw = patch['active_strategies'];
    if (!Array.isArray(raw)) errors.push('active_strategies 必须是数组');
    else {
      const list = [...new Set(raw.map((x) => String(x).trim()))];
      const bad = list.filter((x) => !STRATEGY_ID_RE.test(x));
      if (bad.length) errors.push(`active_strategies 里不是合法策略 id:${bad.join(', ')}`);
      // 库里存不存在、够不够 paper 由 routes-strategies.ts / buildContext 前的 resolve() 把关(这里是纯函数)。
      else next.active_strategies = list.slice(0, WORKFLOW_BOUNDS.active_strategies_max);
    }
  }
  if ('daily_judgment_cap' in patch) {
    const v = clampNum(patch['daily_judgment_cap'], WORKFLOW_BOUNDS.daily_judgment_cap, 'daily_judgment_cap');
    if (v !== null) next.daily_judgment_cap = Math.round(v);
  }
  if ('cli_commands' in patch) {
    const raw = patch['cli_commands'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) errors.push('cli_commands 必须是对象,如 {"claude":"claudeproxy"}');
    else {
      const merged: CliCommandsView = { ...current.cli_commands };
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!(CLI_NAMES as string[]).includes(k)) {
          errors.push(`cli_commands.${k} 不认识,只能是 ${CLI_NAMES.join('/')}`);
          continue;
        }
        const name = k as CliName;
        const err = cliCommandError(v);
        if (err) errors.push(`cli_commands.${name} ${err}`);
        else merged[name] = String(v).trim();
      }
      next.cli_commands = merged;
    }
  }
  next.updated_at = Date.now();
  return { next, errors };
}

/** null = accepted. A launch command is one line of shell: non-empty, bounded, no newlines. */
export function cliCommandError(v: unknown): string | null {
  if (typeof v !== 'string') return '必须是字符串';
  const t = v.trim();
  if (!t) return '不能为空(默认就写 CLI 名字,如 claude)';
  if (t.length > CLI_COMMAND_MAX_CHARS) return `太长(最多 ${CLI_COMMAND_MAX_CHARS} 字符)`;
  if (/[\r\n]/.test(v)) return '只能是一行,不能有换行';
  return null;
}

export function loadWorkflow(json: string | undefined): Workflow {
  if (!json) return { ...DEFAULT_WORKFLOW, updated_at: Date.now() };
  try {
    const parsed = JSON.parse(json) as Partial<Workflow>;
    // cli_commands landed after some DBs were written, and a hand-edited one may be partial: merge
    // per key so a missing CLI still gets its default instead of `undefined` reaching spawn().
    const cli = { ...DEFAULT_WORKFLOW.cli_commands, ...(typeof parsed.cli_commands === 'object' && parsed.cli_commands ? parsed.cli_commands : {}) };
    for (const n of CLI_NAMES) if (cliCommandError(cli[n])) cli[n] = DEFAULT_WORKFLOW.cli_commands[n];
    return { ...DEFAULT_WORKFLOW, ...parsed, cli_commands: cli };
  } catch {
    return { ...DEFAULT_WORKFLOW, updated_at: Date.now() };
  }
}
