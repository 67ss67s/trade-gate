import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Command, OctagonAlert, Pause, Play, UserCheck, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { BrainControls } from '@/components/brain-controls';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ExecutionBadge } from '@/components/execution-panel';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { NeedsYouBadge } from '@/components/approvals';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { pageLabel, type Page } from '@/lib/nav';
import { getLang, setLang, t, useLang } from '@/lib/i18n';
import { backendLabel, fmtSigned, fmtUsdt, pnlText } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AccountView, QueueView, UsageToday } from '@/api/types';

interface TopBarProps {
  page: Page;
  account: AccountView | null;
  queue: QueueView | null;
  halted: boolean;
  paused: boolean;
  brain: string;
  cheapBrain: string;
  /** v3.3:今日模型用量(老网关没有这个字段时为 null,整块不显示)。 */
  usage?: UsageToday | null;
  connected: boolean;
  onOpenCommand: () => void;
  onOpenHalt: () => void;
  onOpenResumeHalt: () => void;
}

function goToWorkflowPanel() {
  if (window.location.hash.slice(1).split('?')[0] !== 'agent') window.location.hash = 'agent';
  window.setTimeout(() => document.getElementById('workflow-brain-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

/**
 * 顶栏大脑名 = 一个 Popover,里面就能直接换 CLI / 模型并「应用」(以前只是一段文字,
 * 用户看不出来这里能改)。完整工作流设置仍在 Agent 页。
 */
function BrainPopover({ brain, cheapBrain }: { brain: string; cheapBrain: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('点这里换大脑和模型')}
          className="flex max-w-40 items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground aria-expanded:border-border aria-expanded:text-foreground"
        >
          <span className="num truncate">{brain}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="text-[12px] font-semibold">{t('大脑')}</span>
          <span className="num ml-auto max-w-48 truncate text-[10.5px] text-muted-foreground" title={t('主脑 {a} · 副脑 {b}', { a: brain, b: cheapBrain })}>
            {cheapBrain}
          </span>
        </div>
        <div className="border-b px-3 py-1.5 text-[10.5px] text-muted-foreground">
          {t('两个槽位:主脑管判断和对话,副脑管信息员、筛选和复盘。')}
        </div>
        <BrainControls idPrefix="topbar" onApplied={() => setOpen(false)} />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            goToWorkflowPanel();
          }}
          className="w-full border-t px-3 py-1.5 text-left text-[11px] text-primary hover:underline"
        >
          {t('去 Agent 页看完整工作流 →')}
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** 今日判断次数 / 花费。cap=0 = 不限;capped = 已到上限,警示色 + tooltip。 */
function UsageMeter({ usage }: { usage: UsageToday }) {
  const cap = Number(usage.cap) || 0;
  const judgments = Number(usage.judgments) || 0;
  const cost = usage.est_cny !== null && usage.est_cny !== undefined && Number.isFinite(Number(usage.est_cny)) ? `≈¥${Number(usage.est_cny).toFixed(2)}` : null;
  const text = `${t('今日判断')} ${judgments}${cap > 0 ? `/${cap}` : ''}${cost ? ` · ${cost}` : ''}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('num text-[11px]', usage.capped ? 'font-semibold text-warn' : 'text-muted-foreground')}>{text}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {usage.capped ? (
          <span>{t('已到每天上限,今天不再调模型')}</span>
        ) : (
          <span className="num">
            {t('输入')} {usage.input_tokens ?? 0} · {t('输出')} {usage.output_tokens ?? 0} tokens{cap > 0 ? ` · ${t('上限 {n} 次/天', { n: cap })}` : ` · ${t('没设上限')}`}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** 中 / EN 一键切换:显示的是「点了会切到哪」。 */
function LangSwitch() {
  const lang = useLang();
  return (
    <Button
      variant="ghost"
      size="xs"
      className="w-8 px-0 font-semibold text-muted-foreground hover:text-foreground"
      title={lang === 'zh' ? 'Switch to English' : '切换成中文'}
      aria-label={lang === 'zh' ? 'Switch to English' : '切换成中文'}
      onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')}
    >
      {lang === 'zh' ? 'EN' : '中'}
    </Button>
  );
}

function AgentRunSwitch({ paused, halted }: { paused: boolean; halted: boolean }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.patchWorkflow({ paused: next }),
    onSuccess: (_res, next) => {
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      toast.success(next ? t('已暂停 agent') : t('已恢复 agent'));
    },
    onError: (err) => toast.error(t('切换失败'), { description: err instanceof Error ? err.message : String(err) }),
  });
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={halted || toggle.isPending}
      title={halted ? t('紧急停止期间不能切') : paused ? t('点这里恢复运行') : t('点这里暂停')}
      className={cn(
        'border-transparent',
        paused ? 'bg-warn/15 text-warn hover:bg-warn/25' : 'bg-up/15 text-up hover:bg-up/25',
      )}
      onClick={() => toggle.mutate(!paused)}
    >
      {paused ? <Pause data-slot="icon" /> : <Play data-slot="icon" />}
      {paused ? t('已暂停') : t('Agent 运行中')}
    </Button>
  );
}

/**
 * 审批模式开关 = workflow.auto_approve。开 = agent 的 PROPOSE 过完代码闸直接下单;关 = 每笔停在「需要你点」等确认。
 * 切到自动要弹一次确认(真钱);切回人工不用。和左边的「Agent 运行中/已暂停」是两件事:那个管要不要判断,这个管判断完要不要人批。
 */
function ApprovalModeSwitch({ halted }: { halted: boolean }) {
  const queryClient = useQueryClient();
  const wfQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const auto = wfQ.data?.auto_approve ?? null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.patchWorkflow({ auto_approve: next }),
    onSuccess: (res, next) => {
      if (res.errors?.length) {
        toast.error(t('没切成'), { description: res.errors.join('；') });
        return;
      }
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(next ? t('已切到自动交易:agent 的提议过闸后直接下单') : t('已切到需要审批:每笔等你确认'));
      setConfirmOpen(false);
    },
    onError: (err) => toast.error(t('切换失败'), { description: err instanceof Error ? err.message : String(err) }),
  });
  if (auto === null) return null;
  return (
    <>
      <Button
        variant="outline"
        size="xs"
        disabled={halted || toggle.isPending}
        title={halted ? t('紧急停止期间不能切') : auto ? t('现在是自动交易;点一下改成每笔要你批') : t('现在每笔要你批;点一下改成自动交易')}
        className={cn('border-transparent', auto ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-muted text-muted-foreground hover:bg-muted/80')}
        onClick={() => (auto ? toggle.mutate(false) : setConfirmOpen(true))}
      >
        {auto ? <Zap data-slot="icon" /> : <UserCheck data-slot="icon" />}
        {auto ? t('自动交易') : t('需要审批')}
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        title={t('切到自动交易')}
        summary={t('确认切换')}
        busy={toggle.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => toggle.mutate(true)}
      >
        <p className="text-muted-foreground">{t('切过去之后,agent 的开仓提议只要过完全部代码闸(风险、组合限额、风控哨兵),就直接在当前后端下真钱单,不再等你确认。风险、杠杆、上限还是按工作流的设置走。随时能点回「需要审批」。')}</p>
      </ConfirmDialog>
    </>
  );
}

function queueText(queue: QueueView | null): string {
  if (!queue) return '—';
  if (queue.running) {
    const stepText: Record<string, string> = { fetching: t('拉行情'), context: t('收集依据'), thinking: t('思考中'), validating: t('校验结果'), gating: t('过闸'), executing: t('执行中'), done: t('完成') };
    const kindText: Record<string, string> = { scan: t('扫描'), review: t('复查'), info: t('信息员'), chat: t('对话'), manual: t('手动') };
    const base = queue.running.symbol ? `${kindText[queue.running.kind] ?? t('判断')} ${queue.running.symbol}` : (kindText[queue.running.kind] ?? t('判断中'));
    const step = queue.running.step ? ` · ${stepText[queue.running.step] ?? queue.running.step}` : '';
    const label = `${base}${step}`;
    return queue.pending > 0 ? `${label} · ${t('排队 {n}', { n: queue.pending })}` : label;
  }
  return queue.pending > 0 ? t('排队 {n}', { n: queue.pending }) : t('空闲');
}

export function TopBar({ page, account, queue, halted, paused, brain, cheapBrain, usage, connected, onOpenCommand, onOpenHalt, onOpenResumeHalt }: TopBarProps) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2.5 border-b bg-background px-2.5 select-none">
      <SidebarTrigger className="-ml-0.5" />
      <Separator orientation="vertical" className="!h-4" />
      <h1 className="text-[13px] font-semibold">{pageLabel(page)}</h1>

      <div className="ml-auto flex items-center gap-2">
        <div className="num flex items-center gap-2.5 text-[11px]">
          <span className="text-muted-foreground">
            {t('权益')} <span className="text-[12.5px] font-semibold text-foreground">{fmtUsdt(account?.equity)}</span>
          </span>
          <span className="text-muted-foreground">
            {t('未实现')} <span className={cn('text-[12.5px] font-semibold', pnlText(account?.unrealized_pnl))}>{fmtSigned(account?.unrealized_pnl)}</span>
          </span>
        </div>
        <Separator orientation="vertical" className="!h-4" />

        {/* 09-07:原来这里是一枚只读的后端名 pill,和右边 ExecutionBadge 重复;换成审批模式开关(auto_approve 以前埋在工作流表单里,没人知道) */}
        <ApprovalModeSwitch halted={halted} />
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-up' : 'bg-down')} />
          {queueText(queue)}
        </span>

        {usage ? (
          <>
            <Separator orientation="vertical" className="!h-4" />
            <UsageMeter usage={usage} />
          </>
        ) : null}

        <Separator orientation="vertical" className="!h-4" />
        <NeedsYouBadge />
        <AgentRunSwitch paused={paused} halted={halted} />
        <BrainPopover brain={brain} cheapBrain={cheapBrain} />
        <ExecutionBadge />

        <Separator orientation="vertical" className="!h-4" />
        <Button
          variant={halted ? 'destructive' : 'outline'}
          size="xs"
          className={cn(!halted && 'border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive')}
          onClick={halted ? onOpenResumeHalt : onOpenHalt}
        >
          <OctagonAlert data-slot="icon" />
          {halted ? t('解除紧急停止') : t('紧急停止')}
        </Button>

        <Separator orientation="vertical" className="!h-4" />
        <LangSwitch />
        <Button variant="ghost" size="icon-xs" aria-label={t('命令面板')} title="⌘K" onClick={onOpenCommand}>
          <Command />
        </Button>
      </div>
    </header>
  );
}
