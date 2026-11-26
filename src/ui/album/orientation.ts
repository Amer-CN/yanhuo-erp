// 用重力向量推导「手机往哪边倾」，不直接用 beta/gamma。
//
// 竖直握持（beta≈90）时 gamma 会万向节死锁、微小的侧转还会让它变号，
// 直接把原始读数当倾斜会把卡片甩向反方向。cos(beta)·sin(gamma) 与 -sin(beta)
// 在这附近保持连续，代价是竖直姿态下 y 约为 -90°——所以消费方必须减掉首次读数
// 作为基准，看的是**变化量**，不是绝对值。

const DEG = Math.PI / 180;

const clampUnit = (v: number): number => Math.max(-1, Math.min(1, v));

export interface Lean {
  /** 右边缘下沉为正（度） */
  x: number;
  /** 上边缘下沉为正（度） */
  y: number;
}

/** beta/gamma 来自 `deviceorientation`，单位度；返回度 */
export function leanFromOrientation(beta: number, gamma: number): Lean {
  const b = beta * DEG;
  const g = gamma * DEG;
  return {
    x: Math.asin(clampUnit(Math.cos(b) * Math.sin(g))) / DEG,
    y: Math.asin(clampUnit(-Math.sin(b))) / DEG
  };
}
