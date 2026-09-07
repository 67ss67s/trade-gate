/**
 * §9.20 止损保护验证(agent_mcp 通道):一行状态 + 「用最小仓验证止损」按钮。
 * 网关自己跑:读账户 → 算最小仓 → 市价开最小仓 → 挂止损 → 交易所确认 → 撤止损 → 平仓 → 确认已平;通过落库自动放行。
 * 点前弹确认写清 cost_note(真钱最小仓)。unverified/failed 可点,verifying 禁用并显示当前步。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { ProtectionStatusView } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t as tr } from '@/lib/i18n';

export function protectionText(p: ProtectionStatusView): { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' } {
  const cur = p.steps.length ? p.steps.filter((s) => s.ok).length : 0;
  switch (p.status) {
    case 'not_needed':
      return { text: tr('这个通道不用验证'), tone: 'dim' };
    case 'verified':
      return { text: `${tr('已验证')} ${p.verified_at ? fmtDateTime(p.verified_at) : '—'}${p.source === 'env' ? tr('(环境声明)') : ''}`, tone: 'ok' };
    case 'verifying':
      return { text: `${tr('验证中')} · ${tr('第 {i}/{n} 步', { i: cur + 1, n: p.steps.length || '?' })}${p.steps[cur]?.name ? ` ${p.steps[cur]!.name}` : ''}`, tone: 'warn' };
    case 'failed':
      return { text: `${tr('失败')}:${p.last_error ?? p.steps.find((s) => !s.ok)?.detail ?? tr('原因不明')}${p.last_run_at ? ` · ${relativeTime(p.last_run_at)}` : ''}`, tone: 'bad' };
    default:
      return { text: tr('还没验证:新开仓会被下单前的闸挡住'), tone: 'warn' };
  }
}

const TONE: Record<'ok' | 'warn' | 'bad' | 'dim', string> = { ok: 'text-up', warn: 'text-warn', bad: 'text-down', dim: 'text-muted-foreground' };

export function useVerifyProtection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (symbol?: string) => api.verifyProtection(symbol),
    onSuccess: () => {
      toast.info(tr('开始验证,大概 2 分钟,跑完自动刷新'));
      void qc.invalidateQueries({ queryKey: ['execution'] });
      void qc.invalidateQueries({ queryKey: ['risk'] });
    },
    onError: (e: Error & { status?: number }) => toast.error(e.status === 409 ? tr('正在验证,别重复点') : tr('没跑起来'), { description: e.message }),
  });
}

export function ProtectionBlock({ protection, compact }: { protection: ProtectionStatusView | null | undefined; compact?: boolean }) {
  const [ask, setAsk] = useState(false);
  const verify = useVerifyProtection();
  if (!protection || protection.status === 'not_needed') return null;
  const t = protectionText(protection);
  const canRun = protection.status === 'unverified' || protection.status === 'failed';
  return (
    <div className={cn('flex flex-wrap items-center gap-2', compact ? 'text-[10.5px]' : 'px-3 py-2 text-[11.5px]')}>
      {protection.status === 'verifying' ? <Loader2 className="size-3.5 animate-spin text-warn" /> : <ShieldCheck className={cn('size-3.5', TONE[t.tone])} />}
      <span className="shrink-0 text-muted-foreground">{tr('止损保护')}</span>
      <span className={cn('min-w-0 flex-1 truncate', TONE[t.tone])} title={t.text}>
        {t.text}
      </span>
      {protection.status !== 'verified' ? (
        <Button size="xs" variant={protection.status === 'failed' ? 'destructive' : 'outline'} disabled={!canRun || verify.isPending} onClick={() => setAsk(true)} title={protection.cost_note}>
          {protection.status === 'verifying' ? tr('验证中…') : tr('用最小仓验证止损')}
        </Button>
      ) : null}
      <ConfirmDialog open={ask} title={tr('用最小仓验证止损')} summary={tr('确认,开始验证')} danger busy={verify.isPending} onCancel={() => setAsk(false)} onConfirm={() => { setAsk(false); verify.mutate(undefined); }}>
        <p>{protection.cost_note}</p>
        <p className="mt-1 text-muted-foreground">{tr('流程:读账户 → 市价开最小仓 → 挂止损 → 交易所确认 → 撤止损 → 平仓 → 确认已平。过了就自动放行新开仓;失败会尽力撤单平仓,并继续挡着。')}</p>
      </ConfirmDialog>
    </div>
  );
}
