/**
 * 调色范围几何（Power Window）。
 *
 * 这是「达芬奇式局部调色」里那块会被鼠标拖着走的东西：椭圆（内外两个环调羽化）、
 * 矩形（四角可拉）、多边形（逐点可拖）。几何单独存一份，蒙版是从它现算出来的 ——
 * 所以拖手柄只需要重算一张蒙版，不必再让用户重新画选区。
 *
 * 设计上刻意与「选区」分开：
 *   · 选区是**一次性**的（画完就成像素，改不了）；
 *   · 范围是**参数化**的（几何一直在，随时可拖动、可调羽化、可存盘）。
 *
 * 这里只放纯数学 + 蒙版生成，不碰 React，方便单测。
 */
import { createMask } from "./layer";
import { mustCtx } from "../engine/surface";

/** 所有范围共有的字段。 */
interface WindowBase {
  /** 羽化半径（px）：边缘靠它淡出 */
  feather: number;
  /** 反转：圈内不调、圈外调（存进几何里，拖手柄时不会被抹掉） */
  invert?: boolean;
}

/** 范围形状。 */
export type GradeWindow = WindowBase &
  (
    | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
    | { kind: "rect"; x: number; y: number; w: number; h: number }
    | { kind: "poly"; points: { x: number; y: number }[] }
  );

/** 手柄种类：决定拖动时改哪几个参数。 */
export type HandleId =
  | "move"
  | "feather"
  | "n" | "s" | "e" | "w"
  | "ne" | "nw" | "se" | "sw"
  | `v${number}`;

export interface Handle {
  id: HandleId;
  x: number;
  y: number;
  /** 视觉半径（文档坐标；调用方通常按 1/scale 折算成固定屏幕大小） */
  r: number;
}

/** 默认羽化（像素）。给一个能一眼看出"软边"的值，而不是 0。 */
export const DEFAULT_FEATHER = 40;

/** 从文档尺寸造一个居中、占画面 60% 的椭圆范围。 */
export function defaultEllipse(docW: number, docH: number, feather = DEFAULT_FEATHER): GradeWindow {
  return {
    kind: "ellipse",
    cx: docW / 2,
    cy: docH / 2,
    rx: docW * 0.3,
    ry: docH * 0.3,
    feather,
  };
}

/** 从文档尺寸造一个居中、占画面 60% 的矩形范围。 */
export function defaultRect(docW: number, docH: number, feather = DEFAULT_FEATHER): GradeWindow {
  return {
    kind: "rect",
    x: docW * 0.2,
    y: docH * 0.2,
    w: docW * 0.6,
    h: docH * 0.6,
    feather,
  };
}

/** 由选区的包围盒造一个矩形范围（"把刚圈的选区转成可拖的范围"）。 */
export function rectFromBox(
  box: { x: number; y: number; w: number; h: number },
  feather = DEFAULT_FEATHER,
): GradeWindow {
  return { kind: "rect", x: box.x, y: box.y, w: box.w, h: box.h, feather };
}

/** 范围的包围盒（含羽化向外扩散的部分）。 */
export function windowBounds(w: GradeWindow): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const f = Math.max(0, w.feather);
  if (w.kind === "ellipse") {
    return { x: w.cx - w.rx - f, y: w.cy - w.ry - f, w: (w.rx + f) * 2, h: (w.ry + f) * 2 };
  }
  if (w.kind === "rect") {
    return { x: w.x - f, y: w.y - f, w: w.w + f * 2, h: w.h + f * 2 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of w.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - f, y: minY - f, w: maxX - minX + f * 2, h: maxY - minY + f * 2 };
}

/** 点是否落在范围里（不含羽化过渡区）。 */
export function windowHit(w: GradeWindow, px: number, py: number): boolean {
  if (w.kind === "ellipse") {
    if (w.rx <= 0 || w.ry <= 0) return false;
    const dx = (px - w.cx) / w.rx;
    const dy = (py - w.cy) / w.ry;
    return dx * dx + dy * dy <= 1;
  }
  if (w.kind === "rect") {
    return px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h;
  }
  // 射线法判多边形
  let inside = false;
  const pts = w.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 列出可拖的手柄。
 * @param scale 当前缩放（手柄半径按 7/scale 给，屏幕上大小恒定）
 */
export function windowHandles(w: GradeWindow, scale: number): Handle[] {
  const r = 7 / Math.max(0.05, scale);
  const f = Math.max(0, w.feather);
  if (w.kind === "ellipse") {
    return [
      { id: "move", x: w.cx, y: w.cy, r },
      { id: "e", x: w.cx + w.rx, y: w.cy, r },
      { id: "w", x: w.cx - w.rx, y: w.cy, r },
      { id: "n", x: w.cx, y: w.cy - w.ry, r },
      { id: "s", x: w.cx, y: w.cy + w.ry, r },
      // 右上角外侧：拖它改羽化（对应视频里那个"边缘淡出"的环）
      { id: "feather", x: w.cx + (w.rx + f), y: w.cy - (w.ry + f), r },
    ];
  }
  if (w.kind === "rect") {
    const { x, y, w: rw, h } = w;
    return [
      { id: "move", x: x + rw / 2, y: y + h / 2, r },
      { id: "nw", x, y, r },
      { id: "ne", x: x + rw, y, r },
      { id: "sw", x, y: y + h, r },
      { id: "se", x: x + rw, y: y + h, r },
      { id: "feather", x: x + rw + f, y: y - f, r },
    ];
  }
  return [
    ...w.points.map((p, i) => ({ id: `v${i}` as HandleId, x: p.x, y: p.y, r })),
    {
      id: "feather",
      x: Math.min(...w.points.map((p) => p.x)) + f,
      y: Math.min(...w.points.map((p) => p.y)) - f,
      r,
    },
  ];
}

/** 命中测试：返回被按住的手柄（先查手柄，再查是否落在形状里 = 整体拖动）。 */
export function hitHandle(
  w: GradeWindow,
  px: number,
  py: number,
  scale: number,
): HandleId | null {
  const hs = windowHandles(w, scale);
  // 反向遍历：后画的手柄优先（feather 在最后，避免被角点抢）
  for (let i = hs.length - 1; i >= 0; i -= 1) {
    const h = hs[i];
    if (Math.hypot(px - h.x, py - h.y) <= h.r) return h.id;
  }
  return windowHit(w, px, py) ? "move" : null;
}

/**
 * 拖动后的新几何。
 *
 * @param id     按住的手柄
 * @param from   按下时的几何（拖动全程以它为基准，避免累积误差）
 * @param dx/dy  从按下点到位移的文档坐标增量
 */
export function dragWindow(
  id: HandleId,
  from: GradeWindow,
  dx: number,
  dy: number,
): GradeWindow {
  if (id === "move") {
    if (from.kind === "ellipse") return { ...from, cx: from.cx + dx, cy: from.cy + dy };
    if (from.kind === "rect") return { ...from, x: from.x + dx, y: from.y + dy };
    return { ...from, points: from.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }

  if (id === "feather") {
    // 羽化：按「到形状中心的距离增量」换算，往内收就减小
    const mag = Math.hypot(dx, dy) * (dx + dy < 0 ? -1 : 1);
    const next = Math.max(0, Math.min(400, from.feather + mag));
    return { ...from, feather: Math.round(next) };
  }

  if (from.kind === "ellipse") {
    const { rx, ry } = from;
    switch (id) {
      case "e":
        return { ...from, rx: Math.max(2, rx + dx) };
      case "w":
        return { ...from, rx: Math.max(2, rx - dx) };
      case "s":
        return { ...from, ry: Math.max(2, ry + dy) };
      case "n":
        return { ...from, ry: Math.max(2, ry - dy) };
      default:
        return from;
    }
  }

  if (from.kind === "rect") {
    const { x, y, w, h } = from;
    let nx = x;
    let ny = y;
    let nw = w;
    let nh = h;
    if (id === "nw" || id === "w" || id === "sw") {
      nx = Math.min(x + dx, x + w - 2);
      nw = w + (x - nx);
    }
    if (id === "ne" || id === "e" || id === "se") {
      nw = Math.max(2, w + dx);
    }
    if (id === "nw" || id === "n" || id === "ne") {
      ny = Math.min(y + dy, y + h - 2);
      nh = h + (y - ny);
    }
    if (id === "sw" || id === "s" || id === "se") {
      nh = Math.max(2, h + dy);
    }
    return { ...from, x: nx, y: ny, w: nw, h: nh };
  }

  // 多边形：拖某个顶点
  if (id.startsWith("v")) {
    const idx = Number(id.slice(1));
    if (!Number.isFinite(idx) || !from.points[idx]) return from;
    const points = from.points.map((p, i) =>
      i === idx ? { x: p.x + dx, y: p.y + dy } : p,
    );
    return { ...from, points };
  }
  return from;
}

/* ---------------------------------------------------------------- 蒙版 */

/**
 * 把范围烘成蒙版（白 = 调色，透明 = 不调）。
 *
 * 羽化不是"画一个更软的形状"，而是把形状模糊一次：画布模糊会把硬边变成
 * 渐变 alpha，这正是视频里那种"边缘淡出去"的观感，也是合成器里
 * destination-in 需要的输入。
 */
export function windowToMask(docW: number, docH: number, w: GradeWindow): HTMLCanvasElement {
  const mask = createMask(docW, docH);
  const ctx = mustCtx(mask);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, docW, docH);
  ctx.fillStyle = "#ffffff";
  const feather = Math.max(0, w.feather);
  // 先画到临时画布，模糊后再贴回来（直接对 mask 模糊会连边界一起糊到画布外）
  const tmp = createMask(docW, docH);
  const tctx = mustCtx(tmp);
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, docW, docH);
  tctx.fillStyle = "#ffffff";
  tctx.beginPath();
  if (w.kind === "ellipse") {
    tctx.ellipse(w.cx, w.cy, Math.max(0.5, w.rx), Math.max(0.5, w.ry), 0, 0, Math.PI * 2);
  } else if (w.kind === "rect") {
    tctx.rect(w.x, w.y, Math.max(1, w.w), Math.max(1, w.h));
  } else {
    if (w.points.length < 3) {
      ctx.clearRect(0, 0, docW, docH);
      return mask;
    }
    tctx.moveTo(w.points[0].x, w.points[0].y);
    for (let i = 1; i < w.points.length; i += 1) tctx.lineTo(w.points[i].x, w.points[i].y);
    tctx.closePath();
  }
  tctx.fill();
  if (feather > 0) ctx.filter = `blur(${feather}px)`;
  ctx.drawImage(tmp, 0, 0);
  ctx.filter = "none";
  if (w.invert) {
    // 反转：圈外要调、圈内不调 —— 把 alpha 翻过来即可
    const img = ctx.getImageData(0, 0, docW, docH);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = 255 - d[i];
    ctx.putImageData(img, 0, 0);
  }
  return mask;
}
