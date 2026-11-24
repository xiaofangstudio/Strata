/**
 * 形状工具（矩形 / 椭圆 / 直线）。
 *
 * 与画笔、修饰工具同一套范式：拖动过程只在浮层回显，抬笔才把结果落到
 * 图层上，一步可撤销。生成的像素先画在临时画布上，若文档有选区，就用
 * 选区遮罩做一次 destination-in 裁切再整体盖到图层表面 —— 与渐变、
 * 油漆桶处理选区的方式完全一致。
 */
import { mustCtx } from "./surface";
import { smoothLeafPoints, type LeafMode, type LeafPoint } from "../core/leafBrush";

export type ShapeKind = "rect" | "ellipse" | "line" | "leaf";

export interface ShapeSettings {
  /** 用前景色铺满形状内部 */
  fill: boolean;
  /** 用背景色勾出轮廓 */
  stroke: boolean;
  /** 描边线宽（文档像素） */
  strokeWidth: number;
  /** 柳叶笔：实心覆盖 / 空心擦除 / 模糊 */
  leafMode: LeafMode;
  /** 柳叶笔轨迹平滑强度 0..1 */
  leafSmooth: number;
  /** 柳叶笔模糊半径（文档像素） */
  leafBlur: number;
}

export const DEFAULT_SHAPE: ShapeSettings = {
  fill: true,
  stroke: false,
  strokeWidth: 2,
  leafMode: "solid",
  leafSmooth: 0.5,
  leafBlur: 12,
};

export interface ShapePaint {
  kind: ShapeKind;
  a: { x: number; y: number };
  b: { x: number; y: number };
  fill: boolean;
  stroke: boolean;
  strokeWidth: number;
  fillColor: string;
  strokeColor: string;
  /** 柳叶笔：按下后拖出的轨迹；closePath 会自动补上「终点 → 起点」那条弦 */
  points?: readonly LeafPoint[];
  leafMode?: LeafMode;
  leafSmooth?: number;
  leafBlur?: number;
}

export interface ShapeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 拖动两端的包围盒（文档坐标）。 */
export function shapeBounds(s: ShapePaint): ShapeBounds {
  return {
    x: Math.min(s.a.x, s.b.x),
    y: Math.min(s.a.y, s.b.y),
    width: Math.abs(s.b.x - s.a.x),
    height: Math.abs(s.b.y - s.a.y),
  };
}

/** 把形状的路径放进上下文；太小画不出东西时返回 false。 */
function pathOf(c: CanvasRenderingContext2D, s: ShapePaint): boolean {
  c.beginPath();
  if (s.kind === "leaf") {
    const src = s.points ?? [];
    if (src.length < 3) return false;
    const p = smoothLeafPoints(src, s.leafSmooth ?? 0.5);
    c.moveTo(p[0].x, p[0].y);
    // 中间点走二次贝塞尔控制点，落到相邻点中点；轨迹平滑但保留手腕的方向感
    for (let i = 1; i < p.length - 1; i += 1) {
      const cur = p[i];
      const next = p[i + 1];
      c.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
    }
    const last = p[p.length - 1];
    c.lineTo(last.x, last.y);
    // 柳叶形的关键：自动把终点连回起点，围出闭合区域再填充
    c.closePath();
    return true;
  }
  if (s.kind === "line") {
    c.moveTo(s.a.x, s.a.y);
    c.lineTo(s.b.x, s.b.y);
    return true;
  }
  const b = shapeBounds(s);
  if (b.width < 1 || b.height < 1) return false;
  if (s.kind === "ellipse") {
    c.ellipse(
      b.x + b.width / 2,
      b.y + b.height / 2,
      b.width / 2,
      b.height / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else {
    c.rect(b.x, b.y, b.width, b.height);
  }
  return true;
}

/** 按住 Shift 时的约束：矩形 / 椭圆取正方，直线吸附到 45° 方向。 */
export function constrainEnd(s: ShapePaint, shift: boolean): { x: number; y: number } {
  if (!shift) return s.b;
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  if (s.kind === "line") {
    const len = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: s.a.x + Math.cos(ang) * len, y: s.a.y + Math.sin(ang) * len };
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: s.a.x + (dx < 0 ? -size : size),
    y: s.a.y + (dy < 0 ? -size : size),
  };
}

/** 在目标画布上就地画一个形状；返回是否真的落下了像素。 */
export function drawShape(target: HTMLCanvasElement, s: ShapePaint): boolean {
  // 柳叶笔生来就是填充工具，不受「填充 / 描边」两个复选框影响
  const wantsFill = s.kind === "leaf" || (s.kind !== "line" && s.fill);
  const wantsStroke = s.kind !== "leaf" && s.stroke && s.strokeWidth > 0;
  if (!wantsFill && !wantsStroke) return false;

  const c = mustCtx(target);
  c.save();
  if (!pathOf(c, s)) {
    c.restore();
    return false;
  }
  // 模糊柳叶笔不改颜色而是柔化覆盖区域，预览用蓝色虚线与实心模式区分
  if (s.kind === "leaf" && s.leafMode === "blur") {
    c.fillStyle = "rgba(96, 165, 250, 0.24)";
    c.fill();
    c.strokeStyle = "rgba(96, 165, 250, 0.95)";
    c.lineWidth = 1.5;
    c.setLineDash([6, 4]);
    c.stroke();
    c.restore();
    return true;
  }
  // 空心柳叶笔会把覆盖区域的颜色减掉，预览用红白虚线提示「这里是擦除」
  if (s.kind === "leaf" && s.leafMode === "hollow") {
    c.fillStyle = "rgba(255, 92, 92, 0.30)";
    c.fill();
    c.strokeStyle = "rgba(255, 92, 92, 0.95)";
    c.lineWidth = 1.5;
    c.setLineDash([6, 4]);
    c.stroke();
    c.restore();
    return true;
  }
  if (wantsFill) {
    c.fillStyle = s.fillColor;
    c.fill();
  }
  if (wantsStroke) {
    c.strokeStyle = s.strokeColor;
    c.lineWidth = s.strokeWidth;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.stroke();
  }
  c.restore();
  return true;
}
