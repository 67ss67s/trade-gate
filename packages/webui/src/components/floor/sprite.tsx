/**
 * 像素小人:12×12 位图用一个 box-shadow 画出来(一个 DOM 节点,不用 canvas)。
 * 两帧腿部:`walking` 时 160ms 交替(走路);常驻环境动效交给工位的四处预算;
 * 待命只慢呼吸,不眨眼不乱抖(the maintainer 2026-09-06:一闪一闪没设计感)。`facing` 决定朝向。
 */
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { PresenceState } from './types';
import { useReducedMotion } from './ambient';

interface SpriteProps {
  rows: string[];
  color: string;
  /** 每个像素多少 px */
  px?: number;
  state?: PresenceState;
  walking?: boolean;
  facing?: 'left' | 'right';
  /** 叠加的短暂脉冲 class(of-pulse-stamp / done …),由 deck 传 */
  pulseClass?: string;
  className?: string;
}

function shade(hex: string, amt: number): string {
  const n = hex.replace('#', '');
  const v = parseInt(n.length === 3 ? n.split('').map((c) => c + c).join('') : n, 16);
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  const r = clamp(((v >> 16) & 255) * amt);
  const g = clamp(((v >> 8) & 255) * amt);
  const b = clamp((v & 255) * amt);
  return `rgb(${r} ${g} ${b})`;
}

/** 第二帧:第 7–9 行整体右移一格(最右一列丢掉),看起来像腿在动。 */
export function frameRows(rows: string[], frame: number): string[] {
  if (frame === 0) return rows;
  return rows.map((r, i) => (i >= 6 && i <= 8 ? `.${r.slice(0, r.length - 1)}` : r));
}

export function Sprite({ rows, color, px = 4, state = 'idle', walking = false, facing = 'right', pulseClass, className }: SpriteProps) {
  const reduced = useReducedMotion();
  const step = walking && !reduced ? 160 : null;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
    if (step === null) return;
    const t = window.setInterval(() => setFrame((f) => (f ? 0 : 1)), step);
    return () => window.clearInterval(t);
  }, [step]);

  const shadow = useMemo(() => {
    const parts: string[] = [];
    const eye = '#10130f';
    const hi = shade(color, 1.35);
    frameRows(rows, frame).forEach((row, y) => {
      row.split('').forEach((ch, x) => {
        if (ch === '.') return;
        const c = ch === 'e' ? eye : ch === 'h' ? hi : color;
        parts.push(`${x * px}px ${y * px}px 0 0 ${c}`);
      });
    });
    return parts.join(',');
  }, [rows, color, px, frame]);
  const w = (rows[0]?.length ?? 12) * px;
  const h = rows.length * px;
  return (
    <span aria-hidden className={cn('of-sprite', `of-sprite-${state}`, walking && 'of-walking', pulseClass, className)} style={{ width: w, height: h, display: 'block', position: 'relative' }}>
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: px,
          height: px,
          boxShadow: shadow,
          opacity: state === 'off' ? 0.35 : 1,
          filter: state === 'off' ? 'grayscale(1)' : undefined,
          transformOrigin: `${w / 2}px ${h / 2}px`,
          transform: facing === 'left' ? 'scaleX(-1)' : undefined,
          transition: 'transform .12s steps(2)',
        }}
      />
    </span>
  );
}
