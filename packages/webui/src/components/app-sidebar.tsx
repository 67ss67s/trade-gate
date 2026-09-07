import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { NAV, NAV_GROUP_LABEL, NAV_GROUP_ORDER, type Page } from '@/lib/nav';
import { t } from '@/lib/i18n';

/**
 * 全局待办徽章:等人批的提案(['intents'],intent.changed 时失效;老网关 / 接口失败按 0 处理)。
 * 只挂在「Agent」一项上——批提案在那儿。
 */
function usePendingIntents(): number {
  const intentsQ = useQuery({ queryKey: ['intents'], queryFn: () => api.intents(50), refetchInterval: 60_000, retry: false });
  return (intentsQ.data ?? []).filter((i) => i.status === 'pending_approval').length;
}

interface AppSidebarProps {
  page: Page;
  onNavigate: (page: Page) => void;
}

export function AppSidebar({ page, onNavigate }: AppSidebarProps) {
  const pendingIntents = usePendingIntents();
  const badgeFor = (id: Page): number => (id === 'agent' ? pendingIntents : 0);
  return (
    <Sidebar collapsible="icon" className="select-none">
      <SidebarHeader className="py-1.5">
        <div className="flex items-center gap-2 px-1 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex size-6.5 shrink-0 items-center justify-center rounded bg-primary font-mono text-[11px] font-bold text-primary-foreground">
            TS
          </div>
          <div className="min-w-0 leading-none group-data-[collapsible=icon]:hidden">
            <div className="truncate text-[13px] font-semibold">Trading Swarm</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {NAV_GROUP_ORDER.map((g) => (
          <SidebarGroup key={g} className="py-1">
            <SidebarGroupLabel className="kicker h-5 px-2 text-[9.5px] text-muted-foreground/70">{NAV_GROUP_LABEL[g]}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {NAV.filter((item) => item.group === g).map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={page === item.id}
                      tooltip={t(item.label)}
                      onClick={() => onNavigate(item.id)}
                      className="h-7 text-[12.5px] [&>svg]:size-3.5"
                    >
                      <item.icon />
                      <span>{t(item.label)}</span>
                    </SidebarMenuButton>
                    {badgeFor(item.id) > 0 ? (
                      <SidebarMenuBadge className="bg-warn/20 text-warn" title={t('{i} 个提案待批', { i: pendingIntents })}>
                        {badgeFor(item.id)}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
