/**
 * 移动工具的拖拽读数（移植自 PhotoCraft #16859）。
 *
 * 上游把 ΔX / ΔY 换成方向箭头 + 绝对距离：向右 10px 是「→ 10 px」，
 * 向左 10px 是「← 10 px」；零位移按 ↓ 显示。距离按屏幕像素四舍五入，
 * 方向由位移符号决定。读数只画在浮层，不进像素也不进历史。
 */
export interface MoveReadoutRow {
  arrow: "←" | "→" | "↑" | "↓";
  text: string;
}

export function moveReadout(dx: number, dy: number): MoveReadoutRow[] {
  return [
    {
      arrow: dx < 0 ? "←" : "→",
      text: `${Math.round(Math.abs(dx))} px`,
    },
    {
      arrow: dy < 0 ? "↑" : "↓",
      text: `${Math.round(Math.abs(dy))} px`,
    },
  ];
}

/** 浮层徽标的一行文案（与 PhotoCraft 的选项条读数顺序一致：横向在前）。 */
export function moveReadoutText(dx: number, dy: number): string {
  return moveReadout(dx, dy).map((r) => `${r.arrow} ${r.text}`).join("  ");
}
