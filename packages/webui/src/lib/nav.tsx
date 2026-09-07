import { ArrowLeftRight, Bot, LayoutGrid, ClipboardList, Crosshair, Eye, FileClock, Home, Radar, ScrollText, Settings, type LucideIcon } from 'lucide-react';
import { t, tmap } from '@/lib/i18n';

// 侧栏 = 五个工位的流水线顺序:总览 → Radar(信息员 / 筛选 / 盯盘参数)→ Thesis(Agent / 判断记录)
// → Strategy(策略库 / 回放)→ Execution(交易 / 复盘)→ 系统(日志 / 设置)。
// 风控没有独立页:闸门参数在工作流表单与设置页里,闸门结果在判断记录里。

export type Page = 'home' | 'floor' | 'trade' | 'agent' | 'watch' | 'intel' | 'screener' | 'judgments' | 'history' | 'logs' | 'settings';

export type NavGroup = 'overview' | 'radar' | 'thesis' | 'execution' | 'system';

export const NAV_GROUP_LABEL: Record<NavGroup, string> = tmap({
  overview: '总览',
  radar: 'Radar',
  thesis: 'Thesis',
  execution: 'Execution',
  system: '系统',
});

export const NAV_GROUP_ORDER: NavGroup[] = ['overview', 'radar', 'thesis', 'execution', 'system'];

export interface NavItem {
  id: Page;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
}

export const NAV: NavItem[] = [
  { id: 'home', label: '首页', icon: Home, group: 'overview' },
  { id: 'floor', label: '楼层', icon: LayoutGrid, group: 'overview' },
  { id: 'intel', label: '信息员', icon: Radar, group: 'radar' },
  { id: 'screener', label: '筛选', icon: Crosshair, group: 'radar' },
  { id: 'watch', label: '盯盘参数', icon: Eye, group: 'radar' },
  { id: 'agent', label: 'Agent', icon: Bot, group: 'thesis' },
  { id: 'judgments', label: '判断记录', icon: ClipboardList, group: 'thesis' },
  { id: 'trade', label: '交易', icon: ArrowLeftRight, group: 'execution' },
  { id: 'history', label: '复盘', icon: FileClock, group: 'execution' },
  { id: 'logs', label: '日志', icon: ScrollText, group: 'system' },
  { id: 'settings', label: '设置', icon: Settings, group: 'system' },
];

export function pageLabel(page: Page): string {
  const label = NAV.find((n) => n.id === page)?.label;
  return label ? t(label) : '';
}
