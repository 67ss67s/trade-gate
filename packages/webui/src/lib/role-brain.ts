/**
 * 角色 ↔ 大脑槽位。网关只有两个大脑槽(workflow.brain = 主脑:判断/对话;workflow.cheap_brain = 副脑:
 * 信息员/复盘/Radar),bots.model_pin 虽然落库但网关**还没读**(demo/bots.ts 只存不取)。
 * 所以「某角色用什么模型」= 它所在槽位当前生效的大脑;切模型 = 切槽位,会连带同槽的其它角色。
 * 对齐 gateway:runtime.ts brain()/cheapBrain() 的调用点(chat.ts 主脑;radar.ts / reviewer-agent.ts / 信息员 副脑)。
 */
import type { BotRole, LoopView } from '@/api/types';
import { tmap } from '@/lib/i18n';

export type BrainSlot = 'main' | 'cheap';

export const ROLE_BRAIN_SLOT: Partial<Record<BotRole, BrainSlot>> = {
  gate_captain: 'main',
  thread_manager: 'main',
  radar: 'cheap',
  reviewer: 'cheap',
};

export const SLOT_LABEL: Record<BrainSlot, string> = tmap({ main: '主脑', cheap: '副脑' });

/** 同槽位的其它角色呼号,用来提示「切了会一起换」 */
export const SLOT_ROLES: Record<BrainSlot, BotRole[]> = {
  main: ['gate_captain', 'thread_manager'],
  cheap: ['radar', 'reviewer'],
};

/** 每个用模型的角色在这个槽位上干什么(顶栏大脑弹层 / 团队卡共用一份文案) */
export const SLOT_ROLE_DUTY: Partial<Record<BotRole, string>> = tmap({
  gate_captain: '对话',
  thread_manager: '判断',
  radar: '信息员 · 筛选',
  reviewer: '复盘',
});

export function roleBrainName(role: BotRole, loop: Pick<LoopView, 'brain' | 'cheap_brain'> | null | undefined): { slot: BrainSlot; name: string } | null {
  const slot = ROLE_BRAIN_SLOT[role];
  if (!slot || !loop) return null;
  return { slot, name: slot === 'main' ? loop.brain : loop.cheap_brain };
}
