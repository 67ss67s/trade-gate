/**
 * 应用外壳:侧栏 + 顶栏 + hash 路由 + 底部状态栏 + 命令面板 + 紧急停止确认弹窗。
 * 仿 the reference console,砍掉 dry_run/live 模式、readonly 角色、更新检查、
 * 首次向导、账户切换——本项目只有 paper/demo 两个后端,由网关自己决定,前端不切换。
 *
 * ── react-query key 约定(所有页面必须遵守,这样 App.tsx 这一个 SSE 连接才能把大家的
 *    缓存都失效对) ──
 *   ['overview']                 GET /api/overview(loop/strategy/account/market/
 *                                 recent_episodes/workflow/market_state/threads/markets/queue)
 *   ['episodes']                 GET /api/episodes(时间线列表)
 *   ['episode', id]              GET /api/episodes/:id(详情,懒加载)
 *   ['threads', status]          GET /api/threads?status=  status ∈ 'open' | 'all'
 *   ['thread', id]               GET /api/threads/:id
 *   ['logs']                     GET /api/logs
 *   ['workflow']                 GET /api/workflow
 *   ['market-state']             GET /api/market-state
 *   ['market-state-history']     GET /api/market-state/history
 *   ['chat-messages']            GET /api/chat/messages
 *   ['positions']                GET /api/positions
 *   ['open-orders']              GET /api/orders/open
 *   ['symbols']                  GET /api/symbols
 *   ['info-events']              GET /api/info/events
 *   ---- v3(design notes)----
 *   ['chat-messages', kind]      GET /api/chat/messages?kind=  kind ∈ 'chat' | 'narration' | 'all'
 *                                (invalidate 用前缀 ['chat-messages'] 一次全失效)
 *   ['history']                  GET /api/history(复盘页;thread.changed 时失效)
 *   ['activity']                 GET /api/activity(活动流;SSE `activity` 直接 prepend)
 *   ['regime', symbol]           GET /api/market/regime?symbol=
 *   ---- v3.3:执行后端(操作台)----
 *   ['execution']                GET /api/execution(执行后端 + agent_mcp 连接状态;
 *                                SSE `execution.changed` 失效它。refetchInterval 30s)
 *   ['brains']                   GET /api/brains(大脑选项,staleTime 5 分钟)
 *   ---- v3.4(design notes):回放与盲测 ----
 *   ['backtest']                 GET /api/backtest(回测列表 + running)
 *   ['backtest', id]             GET /api/backtest/:id(run + steps + trades)
 *   ['klines-history', symbol, interval, from, to]
 *                                GET /api/market/klines/history(回放图的历史 K 线,磁盘缓存)
 *   ---- v3.5:策略库 ----
 *   ['strategies']               GET /api/strategies(策略库列表 + active + 文案表;
 *                                SSE `strategy.changed` 按这个前缀失效,连详情一起带上)
 *   ['strategies', id]           GET /api/strategies/:id(spec + 版本列表 + 该策略的归因点)
 *   ---- v3.6(网关 src/demo/screener.ts):雷达 / 筛选器 ----
 *   ['screener', 'latest', horizon]
 *                                GET /api/screener/latest?horizon=(最新一次筛选 + 候选 + 排程)
 *   ['screener', 'history', horizon]
 *                                GET /api/screener/history?horizon=&limit=
 *   ['screener', 'detail', id]   GET /api/screener/:id(点历史里的老筛选)
 *                                (SSE `screener.changed` 按前缀 ['screener'] 一次全失效)
 *   ['backtest', id, 'attribution']
 *                                GET /api/backtest/:id/attribution(某次回测的归因点位;
 *                                跑归因是 POST /api/backtest/:id/attribute,调便宜大脑会花钱)
 *
 * SSE → 缓存的映射见下面 useLiveEvents(...) 里的 handlers;新页面只要用上面这些 key 发
 * useQuery,不用自己再开一条 /api/events 连接。
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/app-sidebar';
import { CommandMenu } from '@/components/command-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusBar } from '@/components/status-bar';
import { TopBar } from '@/components/top-bar';
import { api, useLiveEvents } from '@/api/client';
import type { Page } from '@/lib/nav';
import { t, useLang } from '@/lib/i18n';
import { HomePage } from '@/pages/home';
import { FloorPage } from '@/pages/floor';
import { TradePage } from '@/pages/trade';
import { AgentPage } from '@/pages/agent';
import { IntelPage } from '@/pages/intel';
import { ScreenerPage } from '@/pages/screener';
import { WatchPage } from '@/pages/watch';
import { PageErrorBoundary } from '@/components/page-error-boundary';
import { JudgmentsPage } from '@/pages/judgments';
import { HistoryPage } from '@/pages/history';
import { ReplayPage } from '@/pages/replay';
import { StrategiesPage } from '@/pages/strategies';
import { LogsPage } from '@/pages/logs';
import { SettingsPage } from '@/pages/settings';

const PAGE_IDS: Page[] = ['home', 'floor', 'trade', 'agent', 'watch', 'intel', 'screener', 'judgments', 'history', 'replay', 'strategies', 'logs', 'settings'];

const LAST_PAGE_KEY = 'tg.page.last';

/** 无 hash 时的落点:上次离开的页;第一次进来落首页(五个工位的全景) */
function defaultPage(): Page {
  try {
    const saved = window.localStorage.getItem(LAST_PAGE_KEY) as Page | null;
    if (saved && PAGE_IDS.includes(saved)) return saved;
  } catch {
    /* 无 storage */
  }
  return 'home';
}

function readPageFromHash(): Page {
  const hash = window.location.hash.slice(1).split('?')[0] as Page;
  return PAGE_IDS.includes(hash) ? hash : defaultPage();
}

export default function App() {
  // 语言一变,整棵树跟着重渲染,所有 t() 读到新值(组件自己不用再挂 hook)。
  useLang();
  const queryClient = useQueryClient();
  const [page, setPageState] = useState<Page>(readPageFromHash);
  const setPage = (p: Page) => {
    const current = window.location.hash.slice(1);
    if (current.split('?')[0] !== p) window.location.hash = p;
    setPageState(p);
  };
  useEffect(() => {
    const onHashChange = () => setPageState(readPageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_PAGE_KEY, page);
    } catch {
      /* 私密模式等 */
    }
  }, [page]);

  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });
  const [connected, setConnected] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [haltOpen, setHaltOpen] = useState(false);
  const [resumeHaltOpen, setResumeHaltOpen] = useState(false);
  const [haltBusy, setHaltBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);

  useLiveEvents(
    {
      'loop.state': () => void queryClient.invalidateQueries({ queryKey: ['overview'] }),
      'queue.state': () => void queryClient.invalidateQueries({ queryKey: ['overview'] }),
      'account.updated': (account) => {
        queryClient.setQueryData(['overview'], (old: unknown) => (old && typeof old === 'object' ? { ...old, account } : old));
        void queryClient.invalidateQueries({ queryKey: ['positions'] });
        void queryClient.invalidateQueries({ queryKey: ['open-orders'] });
      },
      'market.tick': () => void queryClient.invalidateQueries({ queryKey: ['overview'] }),
      // v3.5:同一个事件既报「在跑的策略变了」也报策略库自己的变动(晋升/退役/新版本/归因),
      //       前缀 ['strategies'] 一次把列表和 ['strategies', id] 详情都失效掉。
      'strategy.changed': () => {
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        void queryClient.invalidateQueries({ queryKey: ['strategies'] });
      },
      'workflow.changed': (workflow) => {
        queryClient.setQueryData(['workflow'], workflow);
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
      },
      // §9.19 设置提议:列表 + 活动流
      'workflow.proposal': () => {
        void queryClient.invalidateQueries({ queryKey: ['workflow', 'proposals'] });
        void queryClient.invalidateQueries({ queryKey: ['activity'] });
      },
      'intent.changed': () => {
        void queryClient.invalidateQueries({ queryKey: ['episodes'] });
        void queryClient.invalidateQueries({ queryKey: ['intents'] });
      },
      'episode.started': () => void queryClient.invalidateQueries({ queryKey: ['episodes'] }),
      'episode.finished': (summary) => {
        queryClient.setQueryData(['episodes'], (old: unknown) => {
          if (!Array.isArray(old)) return old;
          return [summary, ...old.filter((e: { id: string }) => e.id !== summary.id)].slice(0, 200);
        });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        if (summary.thread_id) void queryClient.invalidateQueries({ queryKey: ['thread', summary.thread_id] });
      },
      'thread.changed': (thread) => {
        void queryClient.invalidateQueries({ queryKey: ['threads', 'open'] });
        void queryClient.invalidateQueries({ queryKey: ['threads', 'all'] });
        void queryClient.invalidateQueries({ queryKey: ['thread', thread.id] });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        // 线程进终态才影响复盘页;不区分也没关系,history 查询自己有 staleTime
        if (thread.status === 'closed' || thread.status === 'canceled' || thread.status === 'invalidated') {
          void queryClient.invalidateQueries({ queryKey: ['history'] });
        }
      },
      'market_state.updated': (state) => {
        queryClient.setQueryData(['market-state'], state);
        void queryClient.invalidateQueries({ queryKey: ['market-state-history'] });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
      },
      // 前缀匹配:['chat-messages','chat'] / ['chat-messages','narration'] 一起失效
      'chat.message': () => void queryClient.invalidateQueries({ queryKey: ['chat-messages'] }),
      // v3.3:切了执行后端 / 重新探了 MCP 连接
      'execution.changed': () => {
        // 切执行通道 = 切账户上下文:权益/持仓/挂单/线程/复盘都要按新通道重拉
        void queryClient.invalidateQueries({ queryKey: ['execution'] });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        void queryClient.invalidateQueries({ queryKey: ['positions'] });
        void queryClient.invalidateQueries({ queryKey: ['open-orders'] });
        void queryClient.invalidateQueries({ queryKey: ['threads'] });
        void queryClient.invalidateQueries({ queryKey: ['history'] });
      },
      // v3.4:回测进度(每次判断一条)只更新那一条 run 的缓存,别整页刷新
      'backtest.progress': (p) => {
        queryClient.setQueryData(['backtest', p.run_id], (old: unknown) => {
          const cur = old as { run: { progress: unknown } } | undefined;
          if (!cur) return old;
          return { ...cur, run: { ...cur.run, progress: { done: p.done, total: p.total, last_action: p.last_action, at: p.at } } };
        });
        void queryClient.invalidateQueries({ queryKey: ['backtest', p.run_id] });
      },
      'backtest.changed': (run) => {
        void queryClient.invalidateQueries({ queryKey: ['backtest'] });
        void queryClient.invalidateQueries({ queryKey: ['backtest', run.id] });
      },
      // v3.6:一次筛选从 running 走到 done/failed,连带 workflow(auto 模式会改 watchlist)
      // 也可能变了;前缀 ['screener'] 一次把 latest/history/详情全失效。
      'screener.changed': () => {
        void queryClient.invalidateQueries({ queryKey: ['screener'] });
        void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      },
      activity: (item) => {
        queryClient.setQueryData(['activity'], (old: unknown) => {
          const cur = old as { activity: { id: string }[] } | undefined;
          if (!cur) return old;
          if (cur.activity.some((a) => a.id === item.id)) return old;
          return { activity: [item, ...cur.activity].slice(0, 500) };
        });
      },
      log: (entry) => {
        queryClient.setQueryData(['logs'], (old: unknown) => {
          const cur = old as { logs: unknown[] } | undefined;
          if (!cur) return old;
          return { logs: [entry, ...cur.logs].slice(0, 500) };
        });
      },
    },
    setConnected,
  );

  const account = overviewQ.data?.account ?? null;
  const queue = overviewQ.data?.queue ?? null;
  const halted = overviewQ.data?.loop.halted ?? false;
  const paused = overviewQ.data?.loop.paused ?? false;
  const backend = overviewQ.data?.loop.backend ?? 'paper';
  const brain = overviewQ.data?.loop.brain ?? '—';
  const cheapBrain = overviewQ.data?.loop.cheap_brain ?? '—';
  const usageToday = overviewQ.data?.usage_today ?? null;

  const confirmHalt = async () => {
    setHaltBusy(true);
    try {
      await api.halt();
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      setHaltOpen(false);
    } finally {
      setHaltBusy(false);
    }
  };
  const confirmResumeHalt = async () => {
    setResumeBusy(true);
    try {
      await api.resume('RESUME');
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      setResumeHaltOpen(false);
    } finally {
      setResumeBusy(false);
    }
  };

  return (
    <TooltipProvider>
      <SidebarProvider style={{ '--sidebar-width': '9.5rem', '--sidebar-width-icon': '2.9rem' } as React.CSSProperties}>
        <AppSidebar page={page} onNavigate={setPage} />
        <SidebarInset className="h-svh min-w-0 overflow-hidden">
          <TopBar
            page={page}
            account={account}
            queue={queue}
            halted={halted}
            paused={paused}
            brain={brain}
            cheapBrain={cheapBrain}
            usage={usageToday}
            connected={connected}
            onOpenCommand={() => setCmdOpen(true)}
            onOpenHalt={() => setHaltOpen(true)}
            onOpenResumeHalt={() => setResumeHaltOpen(true)}
          />
          <main className="min-h-0 flex-1 overflow-auto p-3">
            <PageErrorBoundary page={page}>
            {page === 'home' ? <HomePage /> : null}
            {page === 'floor' ? <FloorPage connected={connected} /> : null}
            {page === 'trade' ? <TradePage /> : null}
            {page === 'agent' ? <AgentPage /> : null}
            {page === 'intel' ? <IntelPage /> : null}
            {page === 'screener' ? <ScreenerPage /> : null}
            {page === 'watch' ? <WatchPage /> : null}
            {page === 'judgments' ? <JudgmentsPage /> : null}
            {page === 'history' ? <HistoryPage /> : null}
            {page === 'replay' ? <ReplayPage /> : null}
            {page === 'strategies' ? <StrategiesPage /> : null}
            {page === 'logs' ? <LogsPage /> : null}
            {page === 'settings' ? <SettingsPage /> : null}
            </PageErrorBoundary>
          </main>
          <StatusBar connected={connected} backend={backend} brain={brain} />
          <ConfirmDialog
            open={haltOpen}
            title={t('紧急停止')}
            summary={t('确认紧急停止')}
            danger
            requireText="HALT"
            busy={haltBusy}
            onCancel={() => setHaltOpen(false)}
            onConfirm={() => void confirmHalt()}
          >
            <p>{t('这会立刻撤掉全部挂单、市价平掉全部持仓,并停掉后面所有开仓判断,直到你手动恢复。不可逆,想清楚再确认。')}</p>
          </ConfirmDialog>
          <ConfirmDialog
            open={resumeHaltOpen}
            title={t('解除紧急停止')}
            summary={t('确认解除')}
            danger
            requireText="RESUME"
            busy={resumeBusy}
            onCancel={() => setResumeHaltOpen(false)}
            onConfirm={() => void confirmResumeHalt()}
          >
            <p>{t('解除之后调度恢复正常,agent 随时可能重新判断、重新开仓。当前状况处理好了吗?')}</p>
          </ConfirmDialog>
        </SidebarInset>
        <CommandMenu
          open={cmdOpen}
          onOpenChange={setCmdOpen}
          onNavigate={setPage}
          halted={halted}
          onOpenHalt={() => setHaltOpen(true)}
          onOpenResumeHalt={() => setResumeHaltOpen(true)}
        />
        <Toaster richColors position="bottom-right" />
      </SidebarProvider>
    </TooltipProvider>
  );
}
