/**
 * 「执行」卡(v3.3 操作台):选下单走哪个后端,以及 agent_mcp 模式下用哪个 CLI 子进程调
 * 币安 MCP、连没连上。
 *
 * 契约:
 *   GET  /api/execution        → ExecutionView
 *   POST /api/execution/check  → ExecutionView(重新探一次)
 *   POST /api/execution/connect→ { started, instructions }
 *   POST /api/workflow         → 带 execution / exec_agent_cli / exec_agent_model,回 { workflow, errors }
 *   SSE  execution.changed     → App.tsx 失效 ['execution']
 *
 * agent_mcp 的连接方式:点「用 Claude 登录币安」→ 网关弹一个终端跑交互式 `claude "/mcp"`
 * → 选 binance-mcp-server → Authenticate → 回来点「检查连接」。
 *
 * 网关还没接线时这些路由会 404:本卡片一律 retry:0 + 缺省兜底,只显示一行说明,不炸页面。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { ExecutionBackend, ExecutionConnectionStatus, ExecutionView, NetCheckResult, Workflow } from '@/api/types';
import { ProtectionBlock } from '@/components/protection-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { backendLabel, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

/** ['execution'] 的标准订阅方式:顶栏徽章和本卡片共用同一份缓存。 */
export function useExecutionQuery() {
  return useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 30_000, retry: 0, staleTime: 10_000 });
}

const CONNECTION_LABEL: Record<ExecutionConnectionStatus, string> = tmap({
  connected: '已连接',
  needs_auth: '要先登录',
  unavailable: '不可用',
  unknown: '未知',
});

function connectionClass(status: ExecutionConnectionStatus | undefined): string {
  if (status === 'connected') return 'border-up/40 text-up';
  if (status === 'needs_auth') return 'border-warn/40 text-warn';
  if (status === 'unavailable') return 'border-destructive/40 text-destructive';
  return 'text-muted-foreground';
}

/** 顶栏用的小徽章:执行后端一眼可见。 */
/**
 * 09-07 网络自检:连续 5 次只读账户调用(每次一个子进程一条新连接,和真下单同一条路),报掉线率和建议。
 * 同步等结果,agent_mcp 约 2 分钟。结果只在本页面内存里,刷新就没,活动流里有一条记录。
 */
function NetCheckRow() {
  const [result, setResult] = useState<NetCheckResult | null>(null);
  const run = useMutation({
    mutationFn: () => api.netCheck(5),
    onSuccess: (res) => {
      setResult(res.result);
      (res.result.transport_errors ? toast.warning : toast.success)(t('网络自检:{ok}/{total} 通', { ok: res.result.ok, total: res.result.runs.length }), { description: res.result.verdict });
    },
    onError: (e: Error & { status?: number }) => toast.error(e.status === 409 ? t('正在跑,别重复点') : t('自检没跑起来'), { description: e.message }),
  });
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
      <Button size="xs" variant="outline" disabled={run.isPending} onClick={() => run.mutate()} title={t('连续 5 次只读账户调用,约 2 分钟;测的就是下单走的那条路')}>
        {run.isPending ? <Loader2 data-slot="icon" className="animate-spin" /> : <RefreshCw data-slot="icon" />}
        {run.isPending ? t('自检中,约 2 分钟…') : t('网络自检')}
      </Button>
      {result ? (
        <span className={cn('num min-w-0 flex-1', result.transport_errors ? 'text-warn' : 'text-muted-foreground')} title={result.runs.map((r, i) => `#${i + 1} ${r.ok ? 'ok' : r.transport_error ? t('掉线') : t('错误')} ${r.ms} ms${r.error ? ` ${r.error}` : ''}`).join('\n')}>
          {result.verdict}
        </span>
      ) : null}
    </div>
  );
}

export function ExecutionBadge({ className }: { className?: string }) {
  const execQ = useExecutionQuery();
  const view = execQ.data;
  if (!view?.backend) return null;
  const conn = view.connection?.status;
  const isAgent = view.backend === 'agent_mcp';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            if (window.location.hash.slice(1).split('?')[0] !== 'agent') window.location.hash = 'agent';
            window.setTimeout(() => document.getElementById('execution-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
          }}
          className={cn(
            'rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground',
            isAgent && conn === 'connected' && 'border-up/40 text-up',
            isAgent && conn === 'needs_auth' && 'border-warn/40 text-warn',
            isAgent && conn === 'unavailable' && 'border-destructive/40 text-destructive',
            className,
          )}
        >
          {backendLabel(view.backend)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span className="num">
          {t('执行后端')} {backendLabel(view.backend)}
          {isAgent ? ` · ${view.agent?.cli ?? '—'} · ${CONNECTION_LABEL[conn ?? 'unknown']}` : ''}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export function ExecutionPanel() {
  const queryClient = useQueryClient();
  const execQ = useExecutionQuery();
  const view: ExecutionView | undefined = execQ.data;
  const now = useNow(10_000);

  const [instructions, setInstructions] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const serverModel = view?.agent?.model ?? null;
  const lastServerModelRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastServerModelRef.current === serverModel) return;
    lastServerModelRef.current = serverModel;
    setModel(serverModel ?? '');
  }, [serverModel]);

  const save = useMutation({
    mutationFn: (p: Partial<Workflow>) => api.patchWorkflow(p),
    onSuccess: (res) => {
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['execution'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      if ((res.errors ?? []).length > 0) toast.warning(t('{n} 项没保存', { n: res.errors.length }), { description: res.errors.join('; ') });
      else toast.success(t('已保存'));
    },
    onError: (err) => toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const check = useMutation({
    mutationFn: api.executionCheck,
    onSuccess: (res) => {
      queryClient.setQueryData(['execution'], res);
      const status = res.connection?.status;
      if (status === 'connected') toast.success(t('币安 MCP 连上了'));
      else toast.warning(t('连接状态:{status}', { status: CONNECTION_LABEL[status ?? 'unknown'] }), { description: res.connection?.detail || undefined });
    },
    onError: (err) => toast.error(t('检查失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const connect = useMutation({
    mutationFn: api.executionConnect,
    onSuccess: (res) => {
      if (res?.started) {
        // 网关弹了一个终端跑 `claude "/mcp"`:人在那个窗口里 Authenticate,回来点「检查连接」
        toast.info(t('终端弹出来了'), { description: res.instructions || t('在终端里选 binance-mcp-server → Authenticate,弄完回来点「检查连接」') });
        return;
      }
      setInstructions(res?.instructions || t('网关没返回操作说明。'));
    },
    onError: (err) => toast.error(t('连接失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const options = useMemo(() => view?.options ?? [], [view]);
  const canSwitch = view?.can_switch !== false;
  const backend = view?.backend;
  const conn = view?.connection;
  const modelDirty = (serverModel ?? '') !== model.trim();

  const pickBackend = (kind: ExecutionBackend) => {
    if (!canSwitch || kind === backend || save.isPending) return;
    save.mutate({ execution: kind });
  };
  const commitModel = () => {
    if (!modelDirty) return;
    save.mutate({ exec_agent_model: model.trim() === '' ? null : model.trim() });
  };

  if (execQ.isLoading) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-2/3" />
      </div>
    );
  }
  if (!view) {
    return (
      <div className="p-3 text-[11.5px] leading-relaxed text-muted-foreground">
        {t('网关还没提供')} <span className="num">/api/execution</span>{t(',执行后端面板暂时用不了(接好线自动出现)。')}
        <div className="mt-1.5">
          <Button size="xs" variant="outline" onClick={() => void execQ.refetch()}>
            <RefreshCw data-slot="icon" />
            {t('重试')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div id="execution-section" className="flex flex-col">
      {/* 09-07:推荐通道(官方 binance-cli)没接好时,接入步骤顶到最上面——用户先看到这个,再看别的 */}
      {options.filter((o) => o.recommended && !o.available && o.setup).map((o) => (
        <div key={`setup-${o.kind}`} className="mx-3 mt-2 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-2 text-[11.5px] leading-relaxed">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Badge variant="outline" className="h-4 border-primary/50 px-1 text-[9.5px] text-primary">{t('推荐')}</Badge>
            {t('{name} 还没接好', { name: o.label })}
          </div>
          <pre className="num whitespace-pre-wrap font-sans text-[11px] text-muted-foreground">{o.setup}</pre>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        {options.length === 0 ? (
          <span className="num text-[12px]">{backendLabel(backend)}</span>
        ) : (
          [...options].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended))).map((opt) => {
            const active = opt.kind === backend;
            const disabled = !opt.available || !canSwitch || save.isPending;
            return (
              <Tooltip key={opt.kind}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      size="xs"
                      variant={active ? 'default' : 'outline'}
                      disabled={disabled && !active}
                      className={cn('rounded-full', active && 'pointer-events-none', opt.recommended && !active && 'border-primary/50')}
                      onClick={() => pickBackend(opt.kind)}
                    >
                      {opt.recommended ? <span className="mr-1 rounded-sm bg-primary/20 px-1 text-[9.5px] text-primary">{t('推荐')}</span> : null}
                      {opt.label || backendLabel(opt.kind)}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-64 text-[11.5px] leading-relaxed">
                  {!opt.available ? t('不可用:{why}', { why: opt.note || t('少凭证或者少 CLI') }) : !canSwitch ? view.switch_blocker || t('现在不能切') : opt.note || backendLabel(opt.kind)}
                </TooltipContent>
              </Tooltip>
            );
          })
        )}
        {save.isPending ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
      </div>

      {!canSwitch ? (
        <div className="mx-3 mb-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
          {view.switch_blocker || t('现在不能切执行后端')}
        </div>
      ) : null}

      {backend === 'agent_mcp' ? (
        <div className="border-t">
          {/* §9.20:止损保护验证状态 + 一键验证(真钱最小仓),阻断类告警的按钮是同一入口 */}
          <ProtectionBlock protection={view.protection} />
          {view.transport ? (
            <div
              className={cn('num mt-1.5 text-[11px]', view.transport.transport_errors > 0 ? 'text-warn' : 'text-muted-foreground')}
              title={view.transport.last_error ? t('最近一次:{detail}', { detail: view.transport.last_error }) : t('最近 30 分钟没出现连接被掐或超时')}
            >
              {t('网络:最近 {min} 分钟 {runs} 次调用,{bad} 次连接被掐或超时', { min: Math.round(view.transport.window_ms / 60_000), runs: view.transport.runs, bad: view.transport.transport_errors })}
              {view.transport.transport_errors > 0 ? ` · ${t('回执丢了会自动查、自动重发,不会误平仓;老是这样就看看代理是不是掐长连接')}` : ''}
            </div>
          ) : null}
          {view.backend === 'agent_mcp' ? <NetCheckRow /> : null}
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <Label className="shrink-0 text-[12px] font-normal text-muted-foreground">CLI</Label>
            <Select
              value={view.agent?.cli ?? 'claude'}
              onValueChange={(v) => save.mutate({ exec_agent_cli: v as 'claude' | 'codex' })}
              disabled={save.isPending}
            >
              <SelectTrigger size="sm" className="h-7 w-28 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">claude</SelectItem>
                <SelectItem value="codex">codex</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <Label className="shrink-0 text-[12px] font-normal text-muted-foreground">
              {t('模型')}
              <span className="ml-1 text-[10px] text-muted-foreground/70">{view.agent?.model_note ?? t('留空 = 用这个 CLI 的默认')}</span>
            </Label>
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={commitModel}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitModel();
                  }
                }}
                placeholder="sonnet / gpt-5 …"
                className="num h-7 w-40 text-[12px]"
              />
              {modelDirty ? (
                <Button size="xs" variant="outline" disabled={save.isPending} onClick={commitModel}>
                  {t('保存')}
                </Button>
              ) : null}
            </div>
          </div>

          {view.agent?.command ? (
            <div className="flex items-center gap-2 px-3 pb-2 text-[10.5px] text-muted-foreground">
              <span className="shrink-0">{t('启动命令')}</span>
              <span className="num min-w-0 flex-1 truncate text-foreground" title={view.agent.resolved?.detail ?? ''}>
                {view.agent.command}
              </span>
              {view.agent.resolved ? (
                <span className={cn('shrink-0', view.agent.resolved.ok ? 'text-muted-foreground' : 'text-destructive')}>
                  {view.agent.resolved.ok ? (view.agent.resolved.via === 'shell' ? t('经 shell') : t('直接起')) : t('找不到')}
                </span>
              ) : null}
              <span className="shrink-0">· {t('在「设置」页改')}</span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
            <Badge variant="outline" className={cn('text-[10.5px]', connectionClass(conn?.status))}>
              {CONNECTION_LABEL[conn?.status ?? 'unknown']}
            </Badge>
            {conn?.checked_at ? <span className="text-[10.5px] text-muted-foreground">{t('{ago}检查的', { ago: relativeTime(conn.checked_at, now) })}</span> : null}
            {conn?.detail ? (
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground" title={conn.detail}>
                {conn.detail}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
            <Button size="xs" variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
              {t('检查连接')}
            </Button>
            <Button size="xs" variant="outline" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
              {t('用 Claude 登录币安')}
            </Button>
            {view.agent?.server_name ? (
              <span className="num truncate text-[10.5px] text-muted-foreground" title={view.agent?.url ?? ''}>
                {view.agent.server_name}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="border-t px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('agent_mcp = 每笔下单由 claude 子进程代调币安官方 MCP(默认 sonnet,读账户有缓存);纸面 / 模拟盘不花钱')}
      </div>

      <Dialog open={instructions !== null} onOpenChange={(open) => !open && setInstructions(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('手动完成币安授权')}</DialogTitle>
            <DialogDescription>{t('在终端里按下面的步骤走一遍,弄完回来点「检查连接」。')}</DialogDescription>
          </DialogHeader>
          <pre className="num max-h-60 overflow-auto rounded-md bg-muted/60 p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap">{instructions}</pre>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(instructions ?? '')
                  .then(() => toast.success(t('已复制')))
                  .catch(() => toast.error(t('复制失败,自己选中复制吧')));
              }}
            >
              <Copy data-slot="icon" />
              {t('复制')}
            </Button>
            <Button size="sm" onClick={() => setInstructions(null)}>
              {t('知道了')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
