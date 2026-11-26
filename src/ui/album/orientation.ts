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
