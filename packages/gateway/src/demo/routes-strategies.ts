/**
 * Strategy-library HTTP routes (design notes). Registered in routes.ts.
 *
 * Red line: no route here can change the numbers of a running strategy. Changing a parameter creates a
 * new DRAFT version; going live means promoting one status at a time, and paper -> live_capped needs an
 * explicit human confirmation.
 */
import type { RouteContext, RouteModule } from './routes.js';
import { FAMILY_LABEL, STATUS_LABEL, STATUS_ORDER, type StrategySpec, type StrategyStatus } from './strategies.js';

function isStatus(v: unknown): v is StrategyStatus {
  return typeof v === 'string' && (STATUS_ORDER as string[]).concat('retired').includes(v);
}

/** The next status a strategy could be promoted to, or null at the top / retired. */
export function nextStatus(s: StrategySpec): StrategyStatus | null {
  const i = STATUS_ORDER.indexOf(s.status);
  return i >= 0 && i + 1 < STATUS_ORDER.length ? STATUS_ORDER[i + 1]! : null;
}

export const strategyRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail, readBody, rt, store } = ctx;
  const lib = store.strategies;

  const view = (s: StrategySpec): StrategySpec & { family_label: string; status_label: string; next_status: StrategyStatus | null; promote_blocked: string | null; active: boolean } => {
    const next = nextStatus(s);
    return {
      ...s,
      family_label: FAMILY_LABEL[s.family] ?? s.family,
      status_label: STATUS_LABEL[s.status] ?? s.status,
      next_status: next,
      promote_blocked: next ? lib.promoteGate(s, next, { confirm: false }) : '已经在最高状态',
      active: (rt.workflow.active_strategies ?? []).includes(s.id),
    };
  };

  const changed = (s: StrategySpec | null): void => {
    if (s) ctx.emit('strategy.changed', { id: s.id, version: s.version, status: s.status });
  };

  // ---- 列表 / 详情

  route('GET', '/api/strategies', guarded(async (_req, res, url) => {
    const includeRetired = url.searchParams.get('include_retired') === '1';
    const strategies = lib.list({ include_retired: includeRetired }).map(view);
    json(res, 200, { strategies, active: rt.workflow.active_strategies ?? [], statuses: STATUS_ORDER, status_labels: STATUS_LABEL, family_labels: FAMILY_LABEL });
  }));

  route('GET', '/api/strategies/:id', guarded(async (_req, res, _url, p) => {
    const id = p['id']!;
    const head = lib.head(id);
    if (!head) return fail(res, 404, `没有策略 ${id}`, 'not_found');
    json(res, 200, { strategy: view(head), versions: lib.versions(id) });
  }));

  // ---- 启用 / 停用(写 workflow.active_strategies;只有 ≥ paper 的能进实盘)

  route('POST', '/api/strategies/active', guarded(async (req, res) => {
    const body = await readBody(req);
    const raw = body['ids'];
    if (!Array.isArray(raw)) return fail(res, 400, 'ids 必须是数组', 'invalid');
    const ids = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
    const { specs, errors } = lib.resolve(ids, { allow_below_paper: false });
    if (errors.length) return json(res, 400, { error: { code: 'invalid', message: errors.join(';') }, errors });
    const r = await rt.applyWorkflow({ active_strategies: specs.map((s) => s.id) });
    if (r.errors.length) return json(res, 400, { error: { code: 'invalid', message: r.errors.join(';') }, errors: r.errors });
    ctx.emit('strategy.changed', { active: r.workflow.active_strategies });
    json(res, 200, { active: r.workflow.active_strategies, workflow: r.workflow });
  }));

  // ---- 生成新版本 / 晋升 / 退役

  route('POST', '/api/strategies/:id/propose-version', guarded(async (req, res, _url, p) => {
    const id = p['id']!;
    const body = await readBody(req);
    const params = (body['params'] ?? undefined) as Record<string, number> | undefined;
    const rules = (body['rules'] ?? undefined) as Partial<StrategySpec['rules']> | undefined;
    const { spec, error } = lib.createVersion(id, { ...(params ? { params } : {}), ...(rules ? { rules } : {}), ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}) });
    if (error) return fail(res, 400, error, 'invalid');
    changed(spec);
    json(res, 201, { strategy: spec ? view(spec) : null });
  }));

  route('POST', '/api/strategies/:id/promote', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    const to = body['to'];
    if (!isStatus(to) || to === 'retired') return fail(res, 400, `to 只能是 ${STATUS_ORDER.join('/')}`, 'invalid');
    const { spec, error } = lib.promote(p['id']!, to, { confirm: body['confirm'] === true });
    if (error) return fail(res, 409, error, 'conflict');
    changed(spec);
    json(res, 200, { strategy: spec ? view(spec) : null });
  }));

  route('POST', '/api/strategies/:id/retire', guarded(async (_req, res, _url, p) => {
    const { spec, error } = lib.retire(p['id']!);
    if (error) return fail(res, 404, error, 'not_found');
    // 退役的策略不该继续挂在实盘启用列表里。
    const active = (rt.workflow.active_strategies ?? []).filter((x) => x !== p['id']);
    if (active.length !== (rt.workflow.active_strategies ?? []).length) await rt.applyWorkflow({ active_strategies: active });
    changed(spec);
    json(res, 200, { strategy: spec ? view(spec) : null, active });
  }));
};
