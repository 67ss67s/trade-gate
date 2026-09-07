/**
 * 首页(#/home)= 五个工位的全景(LAYER 1)+ 二层能力预告(LAYER 2,不在本次发布范围)。
 * 每张工位卡复用其它页面同一份 react-query key(见 App.tsx 顶部注释的 key 约定),
 * 数据在别的页面已经拉过就直接命中缓存,首页自己不开新的轮询连接(除了照抄同款 refetchInterval)。
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Lock } from 'lucide-react';
import { api } from '@/api/client';
import type { ExecutionConnectionStatus } from '@/api/types';
import { buttonVariants } from '@/components/ui/button';
import { BIAS_LABEL, REGIME_LABEL, actionLabel, backendLabel, relativeTime, useNow } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// 沿用 execution-panel.tsx 同一套中文口径(同一个 t() key,英文词典已经有翻译,不用重复登记)。
const CONNECTION_LABEL: Record<ExecutionConnectionStatus, string> = tmap({
  connected: '已连接',
  needs_auth: '要先登录',
  unavailable: '不可用',
  unknown: '未知',
});

type Fact = { label: string; value: ReactNode };

// ---------------------------------------------------------------------------
// LAYER 1:五个工位

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={cn('size-1.5 shrink-0 rounded-full', ok ? 'bg-up' : 'bg-muted-foreground/40')} />;
}

function FactRow({ fact }: { fact: Fact }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 py-1 text-[11.5px]">
      <span className="shrink-0 text-muted-foreground">{fact.label}</span>
      <span className="num min-w-0 truncate text-right text-foreground">{fact.value}</span>
    </div>
  );
}

function Station({ no, name, role, ok, facts, href, cta }: { no: string; name: string; role: string; ok: boolean; facts: Fact[]; href: string; cta: string }) {
  return (
    <div className="flex h-full min-w-0 flex-col rounded-md border bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="num text-[11px] text-muted-foreground">{no}</span>
        <span className="kicker min-w-0 truncate text-[11px] text-foreground/85">{name}</span>
        <StatusDot ok={ok} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">{role}</p>
        <div className="mt-1 flex-1 divide-y">
          {facts.map((f, i) => (
            <FactRow key={i} fact={f} />
          ))}
        </div>
        <a href={href} className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'mt-2 w-full justify-center text-[11.5px] text-muted-foreground hover:text-primary')}>
          {cta}
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LAYER 2:自我进化(锁定卡片,只读展示)

type LockStatus = 'next' | 'planned';

function StatusPill({ status }: { status: LockStatus }) {
  return (
    <span className={cn('kicker shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px]', status === 'next' ? 'border-up/30 bg-up/10 text-up' : 'border-transparent bg-muted text-muted-foreground')}>
      {status}
    </span>
  );
}

function LockedCard({ name, status, desc, feeds }: { name: string; status: LockStatus; desc: string; feeds: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-dashed bg-card p-3 opacity-70">
      <div className="flex items-center gap-2">
        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="kicker min-w-0 truncate text-[11px] text-foreground/85">{name}</span>
        <StatusPill status={status} />
      </div>
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">{t(desc)}</p>
      <div className="mt-auto pt-1 text-[10.5px] text-muted-foreground/70">{feeds}</div>
    </div>
  );
}

const LOCKED_MODULES: { name: string; status: LockStatus; desc: string; feeds: string }[] = [
  {
    name: 'REVIEWER',
    status: 'next',
    desc: '按 R 倍数做事后归因:论点、择时、离场分开打分,对照市场后来实际走的路复盘。',
    feeds: 'feeds → Thesis prompt, Strategy playbook',
  },
  {
    name: 'MEMORY',
    status: 'next',
    desc: '复盘员提出的教训,经人核准后才留存,下次以证据 M1..Mn 的身份和 E1..En 一起出现在提示词里。没有人签字,任何东西都进不了提示词。',
    feeds: 'feeds → Radar evidence registry',
  },
  {
    name: 'STRATEGY LAB',
    status: 'planned',
    desc: '在可回放的历史片段上做预注册实验:规则要改之前先说清楚预期效果,只有量出来的胜绩才能晋升。',
    feeds: 'feeds → Strategy versions',
  },
  {
    name: 'CAPTAIN & COUNCIL',
    status: 'planned',
    desc: '每日简报和跨角色交接,零模型调用。',
    feeds: 'feeds → you',
  },
  {
    name: 'PORTFOLIO & RISK SENTINEL',
    status: 'planned',
    desc: '集群敞口、相关止损、逐币容量,告警自带一个按钮,而不是一份配置改动。',
    feeds: 'feeds → Risk gates',
  },
  {
    name: 'OPS FLOOR',
    status: 'planned',
    desc: '一屏之内,每个角色各就各位。',
    feeds: 'feeds → you',
  },
];

// ---------------------------------------------------------------------------
// 页面

export function HomePage() {
  const now = useNow();

  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const marketStateQ = useQuery({ queryKey: ['market-state'], queryFn: api.marketState });
  const screenerQ = useQuery({ queryKey: ['screener', 'latest', 'short'], queryFn: () => api.screenerLatest('short') });
  const episodesQ = useQuery({ queryKey: ['episodes'], queryFn: () => api.episodes({ limit: 100 }) });
  const strategiesQ = useQuery({ queryKey: ['strategies'], queryFn: () => api.strategies(true) });
  const executionQ = useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 30_000 });
  const threadsQ = useQuery({ queryKey: ['threads', 'open'], queryFn: () => api.threads('open') });
  const positionsQ = useQuery({ queryKey: ['positions'], queryFn: api.positions });
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });

  const workflow = workflowQ.data ?? null;
  const state = marketStateQ.data ?? null;
  const loop = overviewQ.data?.loop ?? null;

  // ---- RADAR ----
  const screenerCount = screenerQ.data?.candidates.length ?? null;
  const radarFacts: Fact[] = [
    { label: t('上次运行'), value: state ? relativeTime(state.as_of, now) : t('等待第一轮') },
    { label: t('态势'), value: state ? `${REGIME_LABEL[state.regime]} · ${BIAS_LABEL[state.bias]}` : '—' },
    { label: t('关注名单'), value: workflow ? t('{n} 个', { n: workflow.watchlist.length }) : '—' },
    { label: t('筛选候选'), value: screenerCount !== null ? t('共 {n} 条', { n: screenerCount }) : t('等待第一轮') },
  ];

  // ---- THESIS ----
  const episodes = episodesQ.data ?? [];
  const latestEpisode = episodes.length ? [...episodes].sort((a, b) => b.at - a.at)[0] : null;
  const thesisFacts: Fact[] = [
    { label: t('判断大脑'), value: loop?.brain ?? workflow?.brain ?? '—' },
    {
      label: t('最新判断'),
      value: latestEpisode
        ? `${latestEpisode.symbol} · ${latestEpisode.action ? actionLabel(latestEpisode.action, latestEpisode.direction) : t('判断失败')} · ${relativeTime(latestEpisode.at, now)}`
        : t('等待第一轮'),
    },
    { label: t('已记录'), value: episodesQ.data ? t('共 {n} 条', { n: episodes.length }) : '—' },
  ];

  // ---- STRATEGY ----
  const activeIds = strategiesQ.data?.active ?? [];
  const activeNames = strategiesQ.data ? strategiesQ.data.strategies.filter((s) => activeIds.includes(s.id)).map((s) => s.name) : [];
  const strategyFacts: Fact[] = [
    { label: t('启用策略'), value: activeNames.length ? activeNames.join(' · ') : workflow?.playbook_text ? t('自定义 Playbook') : '—' },
    { label: t('策略库'), value: strategiesQ.data ? t('共 {n} 条', { n: strategiesQ.data.strategies.length }) : '—' },
    { label: t('判断周期'), value: workflow?.timeframe ?? '—' },
  ];

  // ---- RISK ----
  const riskFacts: Fact[] = [
    { label: t('单笔风险'), value: workflow ? `${workflow.risk_pct}%` : '—' },
    { label: t('杠杆'), value: workflow ? `${workflow.leverage}x` : '—' },
    { label: t('单日止损线'), value: workflow ? `${workflow.daily_loss_stop_pct}%` : '—' },
    { label: t('自动执行'), value: workflow ? (workflow.auto_approve ? t('免确认') : t('需人工批')) : '—' },
  ];

  // ---- EXECUTION ----
  const execution = executionQ.data ?? null;
  const positionsCount = positionsQ.data ? positionsQ.data.length : null;
  const openThreadsCount = threadsQ.data ? threadsQ.data.threads.length : null;
  const runState = !loop ? '—' : loop.halted ? t('已紧急停止') : loop.paused ? t('已暂停') : t('运行中');
  const executionFacts: Fact[] = [
    { label: t('执行通道'), value: execution ? `${backendLabel(execution.backend)} · ${CONNECTION_LABEL[execution.connection.status]}` : '—' },
    { label: t('持仓'), value: positionsCount !== null ? String(positionsCount) : '—' },
    { label: t('开着的线程'), value: openThreadsCount !== null ? String(openThreadsCount) : '—' },
    { label: t('运行状态'), value: runState },
  ];

  const stations: { no: string; name: string; role: string; ok: boolean; facts: Fact[]; href: string; cta: string }[] = [
    { no: '01', name: 'RADAR', role: t('扫描新闻、主流币、异动,把环境摆到台面上。'), ok: state !== null, facts: radarFacts, href: '#screener', cta: t('打开 →') },
    { no: '02', name: 'THESIS', role: t('把环境变成判断:不交易、观察,或提议开仓。'), ok: episodes.length > 0, facts: thesisFacts, href: '#judgments', cta: t('打开 →') },
    { no: '03', name: 'STRATEGY', role: t('存版本、算胜率,决定哪条规则能上场。'), ok: (strategiesQ.data?.strategies.length ?? 0) > 0, facts: strategyFacts, href: '#strategies', cta: t('打开 →') },
    { no: '04', name: 'RISK', role: t('代码闸,不商量:单笔风险、杠杆、同时能开几仓。'), ok: workflow !== null, facts: riskFacts, href: '#agent', cta: t('工作流 →') },
    { no: '05', name: 'EXECUTION', role: t('把批准的判断变成真实的下单和持仓。'), ok: execution !== null, facts: executionFacts, href: '#trade', cta: t('打开 →') },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="kicker text-[10.5px] text-muted-foreground">LAYER 1 · THE FIVE STATIONS</div>
        <p className="text-[12.5px] text-muted-foreground">{t('模型只做判断,代码管钱。每一次判断都是可回放的 episode。')}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {stations.map((s, i) => (
          <div key={s.no} className="relative">
            <Station {...s} />
            {i < stations.length - 1 ? (
              <ChevronRight className="pointer-events-none absolute top-1/2 right-0 z-10 hidden size-3.5 -translate-y-1/2 translate-x-1/2 text-muted-foreground/40 xl:block" />
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-4 pb-1 text-center text-[11.5px] text-muted-foreground/60">{t('楼层下面还有一层 ▼')}</div>

      <div className="flex flex-col gap-2 rounded-md border border-dashed bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="kicker text-[10.5px] text-muted-foreground">LAYER 2 · SELF-EVOLUTION</div>
          <span className="kicker rounded-full border px-1.5 py-0.5 text-[9.5px] text-muted-foreground">not part of this release</span>
        </div>
        <p className="max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
          {t(
            '上面的五个工作台在这个仓库里真实运行。它们下面还有一层,盯着第一层:事后给每次决策打分,把教训变成 Thesis 下次能看到的证据,在规则被允许改变之前先做预注册实验。这些模块存在于我们的私有构建中,正在产品化,不在本次发布范围内。',
          )}
        </p>
        <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {LOCKED_MODULES.map((m) => (
            <LockedCard key={m.name} {...m} />
          ))}
        </div>
      </div>
    </div>
  );
}
