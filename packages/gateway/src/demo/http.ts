// HTTP + SSE control surface (design notes + v2-agent-loop.md §3). node:http only.

import { infoSourcesView } from './info.js';
import http from 'node:http';
import type { DemoRuntime } from './runtime.js';
import type { DemoStore } from './store.js';
import { fetchKlines, tfToMs } from './market.js';
import { BacktestManager, estimateBacktest, loadKlines, normalizeParams as normalizeBacktestParams } from './backtest.js';
import type { BrainKind, ManualOrderRequest, ThreadStatus } from './types.js';
import { brainCatalog, testBrain } from './brain.js';
import { claudeLoginCommand, CODEX_MCP_BLOCKED_DETAIL, claudeLoginInstructions, codexLoginInstructions, DEFAULT_MCP_NAME, DEFAULT_MCP_URL, openTerminalWith, type TerminalOpener } from './execution-agent.js';
import { extraRouteModules } from './routes.js';
import { BRAINS, MODEL_ID_RE } from './workflow.js';
import { defaultBinanceCliBin } from './execution-cli.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGMENT_GRAPH, toMermaid } from './graph.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: Record<string, string>) => Promise<void>;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function fail(res: http.ServerResponse, status: number, message: string, code = 'error'): void {
  json(res, status, { error: { code, message } });
}
function errStatus(e: unknown): number {
  return (e as { status?: number }).status ?? 500;
}
async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

const EVENTS = ['loop.state', 'episode.started', 'episode.progress', 'episode.finished', 'strategy.changed', 'intent.changed', 'account.updated', 'market.tick', 'log', 'market_state.updated', 'thread.changed', 'chat.message', 'queue.state', 'workflow.changed', 'activity', 'execution.changed', 'backtest.progress', 'backtest.changed', 'screener.changed', 'workflow.proposal'] as const;

export interface ServerOptions {
  /** How `/api/execution/connect` pops the interactive `claude` login; injectable so tests open nothing. */
  openTerminal?: TerminalOpener;
}

export function createServer(rt: DemoRuntime, store: DemoStore, options: ServerOptions = {}): http.Server {
  const openTerminal = options.openTerminal ?? openTerminalWith;
  const sse = new Set<http.ServerResponse>();
  const broadcast = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(frame);
  };
  for (const ev of EVENTS) rt.on(ev, (data) => broadcast(ev, data));
  setInterval(() => {
    for (const res of sse) res.write(': ping\n\n');
  }, 15_000).unref();

  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler): void => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:([a-z_]+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, pattern, keys, handler });
  };
  const guarded = (fn: Handler): Handler => async (req, res, url, p) => {
    try {
      await fn(req, res, url, p);
    } catch (e) {
      if (!res.headersSent) fail(res, errStatus(e), (e as Error).message, typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'error');
    }
  };

  // ---- overview / episodes / logs
  route('GET', '/api/overview', async (_req, res) => {
    json(res, 200, {
      loop: rt.loopView(),
      workflow: rt.workflow,
      account: rt.account,
      markets: Object.fromEntries(rt.markets),
      market: rt.markets.get(rt.workflow.watchlist[0] ?? 'BTCUSDT') ?? null,
      market_state: rt.marketState,
      threads: rt.openThreads(),
      queue: rt.queueView(),
      daily_loss_pct: rt.dailyLossPct().toFixed(2),
      usage_today: rt.usageToday(),
      recent_episodes: store.episodes(20),
    });
  });
  route('GET', '/api/episodes', async (_req, res, url) => {
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? '50'));
    const before = url.searchParams.get('before');
    const symbol = url.searchParams.get('symbol');
    const beforeAt = before ? store.episode(before)?.at : undefined;
    let rows = store.episodes(symbol ? limit * 4 : limit, beforeAt);
    if (symbol) rows = rows.filter((e) => e.symbol === symbol).slice(0, limit);
    json(res, 200, rows);
  });
  route('GET', '/api/episodes/:id', async (_req, res, _url, p) => {
    const ep = store.episode(p['id']!);
    if (!ep) return fail(res, 404, 'episode not found', 'not_found');
    json(res, 200, ep);
  });
  route('GET', '/api/intents', async (_req, res, url) => json(res, 200, store.intents(Math.min(200, Number(url.searchParams.get('limit') ?? '50')))));
  route('GET', '/api/logs', async (_req, res, url) => json(res, 200, { logs: store.logs(Math.min(1000, Number(url.searchParams.get('limit') ?? '200'))) }));
  route('GET', '/api/market/klines', async (_req, res, url) => {
    const symbol = (url.searchParams.get('symbol') ?? rt.workflow.watchlist[0] ?? 'BTCUSDT').toUpperCase();
    const tf = url.searchParams.get('tf') ?? '1h';
    const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? '300'));
    const endRaw = Number(url.searchParams.get('end_time') ?? '');
    const endTime = Number.isFinite(endRaw) && endRaw > 0 ? endRaw : undefined;
    json(res, 200, { symbol, tf, klines: await fetchKlines(symbol, tf, limit, endTime) });
  });
  route('GET', '/api/market/regime', guarded(async (_req, res, url) => json(res, 200, await rt.regime((url.searchParams.get('symbol') ?? rt.workflow.watchlist[0] ?? 'BTCUSDT').toUpperCase()))));

  // ---- v3: history + activity (design notes)
  route('GET', '/api/history', async (_req, res, url) => json(res, 200, rt.history(Math.min(500, Number(url.searchParams.get('limit') ?? '200')))));
  route('GET', '/api/activity', async (_req, res, url) => {
    const before = Number(url.searchParams.get('before') ?? '');
    const threadId = url.searchParams.get('thread_id') ?? undefined;
    json(res, 200, { activity: store.activity(Math.min(500, Number(url.searchParams.get('limit') ?? '200')), Number.isFinite(before) && before > 0 ? before : undefined, threadId) });
  });
  route('GET', '/api/symbols', guarded(async (_req, res) => json(res, 200, { symbols: await rt.symbols() })));

  // ---- loop controls
  route('POST', '/api/run-now', async (_req, res) => {
    const n = rt.scanAll({ kind: 'manual', detail: '界面上点了「立即扫描」' });
    json(res, 202, { queued: n });
  });
  route('POST', '/api/scan-now', async (req, res) => {
    const body = await readBody(req);
    const symbol = typeof body['symbol'] === 'string' ? body['symbol'].toUpperCase() : null;
    const queued = symbol ? (rt.scan(symbol, { kind: 'manual', detail: '界面上要求扫描' }) ? 1 : 0) : rt.scanAll({ kind: 'manual', detail: '界面上点了「立即扫描」' });
    json(res, 202, { queued, job_ids: Array.from({ length: queued }, (_v, i) => `scan-${Date.now().toString(36)}-${i}`) });
  });
  route('POST', '/api/info/run-now', async (_req, res) => {
    const queued = rt.runInfoNow('界面');
    json(res, 202, { queued, job_id: `info-${Date.now().toString(36)}` });
  });
  route('POST', '/api/pause', async (_req, res) => {
    rt.pause();
    json(res, 200, rt.loopView());
  });
  route('POST', '/api/resume', async (req, res) => {
    const body = await readBody(req);
    const r = rt.resume(typeof body['confirm'] === 'string' ? body['confirm'] : undefined);
    if (!r.ok) return fail(res, 400, r.message, 'confirm_required');
    json(res, 200, rt.loopView());
  });
  route('POST', '/api/halt', async (req, res) => {
    const body = await readBody(req);
    if (body['confirm'] !== 'HALT') return fail(res, 400, 'body.confirm must be "HALT"', 'confirm_required');
    await rt.halt();
    json(res, 200, rt.loopView());
  });
  route('POST', '/api/settings', async (req, res) => {
    const body = await readBody(req);
    const r = await rt.applyWorkflow(body);
    if (r.errors.length) return json(res, 400, { error: { code: 'invalid', message: r.errors.join('; ') }, errors: r.errors });
    json(res, 200, rt.loopView());
  });

  // ---- workflow
  route('GET', '/api/workflow', async (_req, res) => json(res, 200, rt.workflow));
  // ---- brains (which CLI/model the judgment and the information officer run on)
  route('GET', '/api/brains', async (_req, res, url) =>
    json(res, 200, {
      brains: brainCatalog(url.searchParams.get('refresh') === '1', rt.workflow.cli_commands),
      current: { brain: rt.mainBrain().name, cheap_brain: rt.cheapBrain().name },
      cli_commands: rt.workflow.cli_commands,
    }),
  );
  route('POST', '/api/brains/test', async (req, res) => {
    const body = await readBody(req);
    const kind = body['kind'];
    if (typeof kind !== 'string' || !(BRAINS as string[]).includes(kind)) return fail(res, 400, `kind 只能是 ${BRAINS.join('/')}`, 'bad_request');
    const model = body['model'] === undefined || body['model'] === null || body['model'] === '' ? null : String(body['model']).trim();
    if (model !== null && !MODEL_ID_RE.test(model)) return fail(res, 400, 'model 只能是模型 id(字母数字 . _ : / -)', 'bad_request');
    json(res, 200, await testBrain(kind as BrainKind, model, undefined, rt.workflow.cli_commands));
  });
  // ---- judgment graph: the same table the runtime reads
  route('GET', '/api/graph', async (_req, res) => json(res, 200, { graph: JUDGMENT_GRAPH, mermaid: toMermaid(JUDGMENT_GRAPH) }));
  route('POST', '/api/workflow', async (req, res) => {
    const body = await readBody(req);
    // `execution` is applied by actually switching the backend; a refused switch leaves the field
    // unchanged and lands in `errors` (design notes).
    const r = await rt.applyWorkflow(body);
    // Always 200 with {workflow, errors}: the UI shows the errors inline next to the fields.
    json(res, 200, { workflow: r.workflow, errors: r.errors });
  });

  // ---- execution backend + Binance MCP connection (design notes)
  route('GET', '/api/execution', guarded(async (_req, res) => json(res, 200, await rt.checkExecutionConnection(false))));
  route('POST', '/api/execution/check', guarded(async (_req, res) => json(res, 200, await rt.checkExecutionConnection(true))));
  route('POST', '/api/execution/connect', guarded(async (_req, res) => {
    // The gateway never holds a Binance credential: connecting means letting the agent CLI own the
    // OAuth session with Binance's official MCP server.
    const cli = rt.workflow.exec_agent_cli;
    // codex: `codex mcp login` is dead upstream (dynamic client registration vs Binance's CIMD), so
    // never spawn it — say so instead.
    if (cli === 'codex') return json(res, 200, { started: false, instructions: codexLoginInstructions(DEFAULT_MCP_NAME), detail: CODEX_MCP_BLOCKED_DETAIL });
    // The user's own launch command (alias / env prefix), so the terminal runs what actually works here.
    const loginCommand = claudeLoginCommand(rt.cliCommandFor('claude'));
    // claude has no headless MCP login, so pop a Terminal window with the interactive one. We read no
    // credential of any kind: the human authenticates in that window and the CLI keeps the token.
    const opened = openTerminal(loginCommand);
    if (opened.ok) return json(res, 200, { started: true, instructions: '已弹出终端:在里面选 binance-mcp-server → Authenticate,浏览器里同意后回来点「检查连接」', detail: loginCommand });
    json(res, 200, { started: false, instructions: claudeLoginInstructions(DEFAULT_MCP_NAME, rt.cliCommandFor('claude')), detail: opened.error });
  }));

  // ---- binance-cli profile setup (the recommended channel): pop a Terminal running the official CLI's
  // interactive `profile create`. The key is pasted there and stays in binance-cli's own profile store.
  route('POST', '/api/execution/setup-cli', guarded(async (_req, res) => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const profile = process.env['TG_DEMO_CLI_PROFILE'] ?? 'tgate-demo';
    const command = `${defaultBinanceCliBin(repoRoot)} profile create --name ${profile}`;
    const instructions = `1. 到 https://demo.binance.com 开 Demo Trading,生成一对 API key。\n2. 终端里跑:${command}(环境选 demo,粘 key/secret)。\n3. 回来点「检查连接」。`;
    const opened = openTerminal(command);
    if (opened.ok) return json(res, 200, { started: true, command, instructions: `已弹出终端:按提示粘 Demo Trading 的 key/secret,环境选 demo;弄完回来点「检查连接」`, url: 'https://demo.binance.com' });
    json(res, 200, { started: false, command, instructions, url: 'https://demo.binance.com', detail: opened.error });
  }));

  // ---- information officer
  route('GET', '/api/market-state', async (_req, res) => json(res, 200, rt.marketState));
  route('GET', '/api/market-state/history', async (_req, res, url) => json(res, 200, { history: store.marketStates(Math.min(100, Number(url.searchParams.get('limit') ?? '20'))) }));
  route('GET', '/api/info/sources', async (_req, res) => json(res, 200, { sources: infoSourcesView() }));
  route('GET', '/api/info/events', async (_req, res, url) => json(res, 200, { events: store.infoEvents(Math.min(500, Number(url.searchParams.get('limit') ?? '100'))) }));

  // ---- threads
  route('GET', '/api/threads', async (_req, res, url) => {
    const status = url.searchParams.get('status') ?? 'open';
    const statuses: ThreadStatus[] | undefined = status === 'open' ? ['pending_entry', 'in_position'] : status === 'all' ? undefined : (status.split(',') as ThreadStatus[]);
    const be = url.searchParams.get('backend');
    json(res, 200, { threads: store.threads({ ...(statuses ? { statuses } : {}), limit: Math.min(500, Number(url.searchParams.get('limit') ?? '100')), backend: be === 'all' ? null : be || rt.backend.kind }), backend: be === 'all' ? 'all' : be || rt.backend.kind });
  });
  route('GET', '/api/threads/:id', async (_req, res, _url, p) => {
    const t = store.thread(p['id']!);
    if (!t) return fail(res, 404, 'thread not found', 'not_found');
    json(res, 200, { thread: t, episodes: store.episodesForThread(t.id), intents: store.intentsForThread(t.id) });
  });
  route('POST', '/api/threads/:id/close', guarded(async (_req, res, _url, p) => json(res, 200, await rt.closeThread(p['id']!, '界面上手动平仓/撤单'))));
  // 09-07:把无主持仓交给 agent(建 in_position 线程;body {stop_price?, take_profit?},没交易所止损时 stop_price 必填)
  route('POST', '/api/positions/:symbol/adopt', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    const thread = await rt.adoptPosition(p['symbol']!, { stop_price: typeof body['stop_price'] === 'string' ? body['stop_price'] : null, take_profit: typeof body['take_profit'] === 'string' ? body['take_profit'] : null });
    json(res, 200, { thread });
  }));
  route('POST', '/api/threads/:id/review', async (_req, res, _url, p) => json(res, 202, { queued: rt.reviewThread(p['id']!, { kind: 'manual', detail: '界面上点了「复查」' }) }));

  // ---- manual orders / positions
  route('POST', '/api/orders', guarded(async (req, res) => {
    const body = (await readBody(req)) as unknown as ManualOrderRequest;
    if (!body.symbol || (body.side !== 'long' && body.side !== 'short') || (body.action !== 'open' && body.action !== 'close') || (body.type !== 'market' && body.type !== 'limit')) return fail(res, 400, 'symbol/side/action/type 必填', 'invalid');
    json(res, 200, await rt.manualOrder(body));
  }));
  route('GET', '/api/orders/open', async (_req, res) => json(res, 200, rt.account?.open_orders ?? []));
  route('GET', '/api/positions', async (_req, res) => json(res, 200, rt.account?.positions ?? []));
  // v3.11 保护腿自验证(§9.20):用户点按钮,网关自己跑金丝雀;202 立即返回,进度走 SSE execution.changed 的 protection 字段。
  route('POST', '/api/execution/verify-protection', guarded(async (req, res) => {
    const body = await readBody(req);
    if (body['confirm'] !== true) return fail(res, 400, '需要 confirm:true(真钱最小仓)', 'confirm_required');
    const symbol = typeof body['symbol'] === 'string' ? body['symbol'] : undefined;
    const st = rt.protectionStatus();
    if (st.status === 'verifying') return fail(res, 409, '验证正在进行', 'busy');
    void rt.verifyProtection(symbol ? { symbol } : {}).catch(() => {});
    json(res, 202, { started: true, protection: rt.protectionStatus() });
  }));
  route('GET', '/api/execution/protection', async (_req, res) => json(res, 200, { protection: rt.protectionStatus() }));
  // 09-07:网络自检(只读,n 次账户调用,每次一个子进程;agent_mcp 约 20–30 s/次)。同步等结果,n 钳 1–10。
  route('POST', '/api/execution/net-check', guarded(async (req, res) => {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const n = Number(body['n'] ?? 5);
    const r = await rt.netCheck(Number.isFinite(n) ? n : 5);
    if (!r) return fail(res, 409, '当前执行后端没有网络可测(纸面/本地)', 'not_applicable');
    json(res, 200, { result: r });
  }));
  // v3.10 人批(§9.19):先取一次性 confirm token(绑定意图内容指纹,120 s),再带 nonce 批准;缺 nonce → 428 confirm_required。
  route('POST', '/api/intents/:id/confirm-token', guarded(async (_req, res, _url, p) => {
    const r = rt.issueIntentConfirmation(p['id']!);
    json(res, 200, { nonce: r.token.nonce, expires_at: r.token.expires_at, fingerprint: r.token.fingerprint, intent: { id: r.intent.id, kind: r.intent.kind, symbol: r.intent.symbol, direction: r.intent.direction, quantity: r.intent.quantity, entry: r.intent.entry, limit_price: r.intent.limit_price, stop_price: r.intent.stop_price, take_profit_price: r.intent.take_profit_price, backend: r.intent.backend } });
  }));
  route('POST', '/api/intents/:id/approve', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    json(res, 200, await rt.approveIntent(p['id']!, typeof body['nonce'] === 'string' ? body['nonce'] : null));
  }));
  route('POST', '/api/intents/:id/reject', guarded(async (_req, res, _url, p) => json(res, 200, rt.rejectIntent(p['id']!))));
  // v3.10 设置提议(对话里改高风险设置只到提议,人取 token 后 apply)
  route('GET', '/api/workflow/proposals', async (_req, res) => json(res, 200, { proposals: rt.workflowProposals() }));
  route('POST', '/api/workflow/proposals/:id/confirm-token', guarded(async (_req, res, _url, p) => {
    const r = rt.issueProposalConfirmation(p['id']!);
    json(res, 200, { nonce: r.token.nonce, expires_at: r.token.expires_at, fingerprint: r.token.fingerprint, proposal: r.proposal });
  }));
  route('POST', '/api/workflow/proposals/:id/apply', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    json(res, 200, rt.applyWorkflowProposal(p['id']!, typeof body['nonce'] === 'string' ? body['nonce'] : null));
  }));
  route('POST', '/api/workflow/proposals/:id/reject', guarded(async (_req, res, _url, p) => json(res, 200, { proposal: rt.rejectWorkflowProposal(p['id']!) })));

  // ---- chat
  route('GET', '/api/chat/messages', async (_req, res, url) => {
    const session = url.searchParams.get('session');
    json(res, 200, { messages: store.chat(Math.min(500, Number(url.searchParams.get('limit') ?? '100')), (['chat', 'narration', 'all'].includes(url.searchParams.get('kind') ?? '') ? url.searchParams.get('kind') : 'all') as 'chat' | 'narration' | 'all', session), session: session ? store.chatSession(session) : null });
  });
  route('POST', '/api/chat/messages', async (req, res) => {
    const body = await readBody(req);
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (!text) return fail(res, 400, 'text 必填', 'invalid');
    const session = typeof body['session'] === 'string' && body['session'] ? body['session'] : 'default';
    if (!store.chatSession(session)) return fail(res, 404, `没有会话 ${session}`, 'not_found');
    const r = rt.sendChat(text.slice(0, 4000), session);
    json(res, 202, { accepted: r.queued, queued: r.queued, session });
  });
  route('POST', '/api/chat/reset', async (req, res) => {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    store.clearChat(typeof body['session'] === 'string' ? body['session'] : undefined);
    json(res, 200, { ok: true });
  });
  // ---- v3.8 会话列表(design notes)
  route('GET', '/api/chat/sessions', async (_req, res, url) => json(res, 200, { sessions: store.chatSessions({ include_archived: url.searchParams.get('archived') === '1' }) }));
  route('POST', '/api/chat/sessions', async (req, res) => {
    const body = await readBody(req);
    json(res, 201, { session: store.createChatSession(typeof body['title'] === 'string' && body['title'] ? body['title'] : '新会话', Date.now()) });
  });
  route('POST', '/api/chat/sessions/:id', async (req, res, _url, p) => {
    const body = await readBody(req);
    const patch: { title?: string; archived?: boolean; can_execute?: boolean } = {};
    if (typeof body['title'] === 'string') patch.title = body['title'];
    if (typeof body['archived'] === 'boolean') patch.archived = body['archived'];
    if (typeof body['can_execute'] === 'boolean') patch.can_execute = body['can_execute'];
    const s = store.updateChatSession(p['id']!, patch);
    if (!s) return fail(res, 404, `没有会话 ${p['id']}`, 'not_found');
    if (patch.can_execute !== undefined) rt.log('warn', 'chat', `会话 ${s.id}「${s.title}」允许执行 = ${s.can_execute ? '开' : '关'}`);
    json(res, 200, { session: s });
  });
  route('DELETE', '/api/chat/sessions/:id', async (_req, res, _url, p) => {
    if (!store.deleteChatSession(p['id']!)) return fail(res, 409, p['id'] === 'default' ? '默认会话不能删,只能清空' : '没有这个会话', 'cannot_delete');
    json(res, 200, { ok: true });
  });

  // ---- backtest / replay(design notes)
  // 盲测:每根 K 线只喂当时可见的数据给同一套 buildContext + 契约 + 闸。花钱的动作(POST /api/backtest)
  // 前端必须先拿 estimate 给用户看 ¥ 再确认;回测不受每日判断上限约束,但花费单独在 summary 里算。
  const backtests = new BacktestManager({
    store,
    brainFor: (kind, model) => rt.brainFor(kind, model),
    workflow: () => rt.workflow,
    emit: (event, data) => rt.emit(event, data),
    log: (level, message) => rt.log(level, 'backtest', message),
  });
  const backtestParams = (raw: Record<string, unknown>): { params: ReturnType<typeof normalizeBacktestParams>['params']; errors: string[] } => normalizeBacktestParams(raw, rt.workflow);
  const paramsFromQuery = (url: URL): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams) out[k] = k === 'from' || k === 'to' || k === 'max_judgments' || k === 'horizon_bars' ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
    return out;
  };
  route('GET', '/api/backtest/estimate', guarded(async (_req, res, url) => {
    const { params, errors } = backtestParams(paramsFromQuery(url));
    if (errors.length) return json(res, 400, { error: { code: 'invalid', message: errors.join('; ') }, errors });
    json(res, 200, await estimateBacktest(params, rt.workflow, backtests.brainName(params)));
  }));
  route('GET', '/api/backtest', async (_req, res, url) => json(res, 200, { runs: backtests.list(Math.min(200, Number(url.searchParams.get('limit') ?? '50'))), running: backtests.isRunning() }));
  route('POST', '/api/backtest', guarded(async (req, res) => {
    const { params, errors } = backtestParams(await readBody(req));
    if (errors.length) return json(res, 400, { error: { code: 'invalid', message: errors.join('; ') }, errors });
    const { run, error } = backtests.start(params);
    json(res, error ? 409 : 202, { run, error });
  }));
  route('GET', '/api/backtest/:id', async (_req, res, _url, p) => {
    const found = backtests.get(p['id']!);
    if (!found) return fail(res, 404, 'no such backtest', 'not_found');
    json(res, 200, found);
  });
  route('POST', '/api/backtest/:id/cancel', async (_req, res, _url, p) => json(res, 200, { cancelled: backtests.cancel(p['id']!) }));
  /**
   * Deep historical klines for the replay chart. Binance's /fapi/v1/klines caps a single call at 1500
   * bars, so loadKlines pages backwards for us and keeps a disk cache of both the bars and the spans it
   * has already asked about — scrubbing or re-opening a range costs nothing after the first call.
   * `complete:false` means the request was truncated at the bar cap and `from` is the earliest bar
   * actually returned, so the UI knows there is more to ask for further back.
   */
  const HISTORY_MAX_BARS = 20_000;
  route('GET', '/api/market/klines/history', guarded(async (_req, res, url) => {
    const symbol = (url.searchParams.get('symbol') ?? rt.workflow.watchlist[0] ?? 'BTCUSDT').toUpperCase();
    const interval = url.searchParams.get('interval') ?? url.searchParams.get('tf') ?? '15m';
    const step = tfToMs(interval);
    const to = Number(url.searchParams.get('to') ?? Date.now());
    const from = Number(url.searchParams.get('from') ?? to - 500 * step);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return fail(res, 400, 'from/to 必须是毫秒时间戳且 to > from', 'bad_request');
    const earliest = Math.max(from, to - HISTORY_MAX_BARS * step);
    const klines = await loadKlines(symbol, interval, earliest, to);
    json(res, 200, { symbol, interval, from: earliest, to, requested_from: from, klines, complete: earliest <= from, max_bars: HISTORY_MAX_BARS });
  }));

  // ---- extension modules (routes.ts: one file per feature, one registration line)
  for (const mod of extraRouteModules) mod({ route: (m, p, h) => route(m, p, h), guarded, json, fail, readBody, rt, store, emit: (ev, data) => void rt.emit(ev, data) });

  // ---- SSE
  route('GET', '/api/events', async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    res.write(`event: loop.state\ndata: ${JSON.stringify(rt.loopView())}\n\n`);
    res.write(`event: queue.state\ndata: ${JSON.stringify(rt.queueView())}\n\n`);
    sse.add(res);
    res.on('close', () => sse.delete(res));
  });

  // CSRF guard for writes: any loopback origin is ours (the UI port is configurable via TG_UI_PORT); extra
  // origins can be listed in TG_ALLOWED_ORIGINS (comma-separated).
  const EXTRA_ORIGINS = new Set((process.env['TG_ALLOWED_ORIGINS'] ?? '').split(',').map((o) => o.trim()).filter(Boolean));
  const originAllowed = (origin: string): boolean => EXTRA_ORIGINS.has(origin) || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Browser requests must come from our own UI; non-browser callers (no Origin) are local tools.
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin) && req.method !== 'GET') return fail(res, 403, `origin ${origin} not allowed`, 'forbidden');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' });
      return res.end();
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        await r.handler(req, res, url, params);
      } catch (e) {
        if (!res.headersSent) fail(res, errStatus(e), (e as Error).message, 'internal');
      }
      return;
    }
    fail(res, 404, `no route ${req.method} ${url.pathname}`, 'not_found');
  });
}
