// 体感倾斜：用「相对首次读数的差值」而不是绝对姿态。
//
// 绝对姿态（beta/gamma）在平放与竖直握持下含义完全不同：竖直时重力投影饱和，
// 平放时又几乎没有投影，直接拿来当倾斜会让卡片在某些姿势下完全不动。
// 改成相对基准的 beta/gamma 差值后，不管手机平放还是举着，倾斜都会得到一致的响应；
// beta 会跨 ±180，必须归一后再用。

export interface Orientation {
  beta: number;
  gamma: number;
}

export interface TiltDelta {
  /** 右倾为正（度） */
  x: number;
  /** 前倾为负（度） */
  y: number;
}

/** 折回 (-180, 180]；用于 beta 跨过 ±180 时的连续差值 */
export function normalizeDeg(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** 相对基准的倾斜差（度） */
export function tiltDelta(base: Orientation, current: Orientation): TiltDelta {
  return {
    x: normalizeDeg(current.gamma - base.gamma),
    y: normalizeDeg(current.beta - base.beta)
  };
}

/** 受控倾斜的最大角度：不再做自由旋转，只做小幅跟手 */
const PITCH_DEG = 12;
const ROLL_DEG = 12;

/**
 * 归一化倾斜（-1..1）→ 卡面角度。
 *
 * 关键：**不要映射到 rotateY**。卡片的 360° 甩动用的就是 Y 轴，
 * 体感再去转 Y 就变成两股力量抢同一根轴，看起来像在打架。
 * 这里只给俯仰（X）和横滚（Z），旋转始终只由手指控制。
 */
export function tiltAngles(lean: { x: number; y: number }): { x: number; z: number } {
  // `|| 0` 把 -0 归一成 0：-0 会让 UI 显示成 "-0deg"
  return { x: -lean.y * PITCH_DEG || 0, z: lean.x * ROLL_DEG || 0 };
}

/**
 * 倾斜死区：手抖 1-2 度不该让卡片跟着抖。
 * 输入输出都是 -1..1；死区内的抖动归零，死区外按剩余量程放大，满量程仍然是 ±1。
 */
export const TILT_DEAD_ZONE = 0.06;

export function deadZone(value: number, dead = TILT_DEAD_ZONE): number {
  const v = Math.max(-1, Math.min(1, value));
  const a = Math.abs(v);
  if (a <= dead) return 0;
  const scaled = (a - dead) / (1 - dead);
  return Math.sign(v) * Math.min(1, scaled);
}