/**
 * 调色范围几何（Power Window）。
 *
 * 四种形状：
 *   · **线性**（line）—— 一条可拉长的线，沿它的法线做渐变淡出；适合压天空、压地面
 *   · **椭圆**（ellipse）—— 四个把手调长短轴，可旋转
 *   · **四边形**（quad）—— 四个角**各自独立**：拖一个角只动那个角，另外三个钉死；
 *                        四条边各有自己的羽化宽度
 *   · **钢笔 / 多边形**（poly）—— 逐点可拖
 *
 * 几何是**参数**而不是像素：蒙版每次现算，所以拖手柄只是改几个数字。
 * 一个范围对应一个调色层 —— 想加第二个范围就再加一层，
 * 于是图层的隐藏 / 删除 / 排序天然就是「范围的开关 / 删掉 / 谁先谁后」。
 *
 * 这里只放纯数学 + 蒙版生成，不碰 React，方便单测。
 */
import { createMask } from "./layer";
import { mustCtx } from "../engine/surface";

export interface Pt {
  x: number;
  y: number;
}

/** 所有范围共有的字段。 */
interface WindowBase {
  /** 统一羽化半径（px）。四边形可再用 edges 逐边覆盖 */
  feather: number;
  /** 反转：圈内不调、圈外调（存进几何里，拖手柄时不会被抹掉） */
  invert?: boolean;
}

/** 范围形状。椭圆带旋转角（弧度，绕自身中心）。 */
export type GradeWindow = WindowBase &
  (
    | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; rot?: number }
    | { kind: "quad"; points: Pt[]; edges?: number[] }
    | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
    | { kind: "poly"; points: Pt[] }
  );

/** 手柄种类：决定拖动时改哪几个参数。 */
export type HandleId =
  | "move"
  | "rotate"
  | "feather"
  | "n" | "s" | "e" | "w"
  | "a" | "b"
  | `v${number}`
  | `fe${number}`;

export interface Handle {
  id: HandleId;
  x: number;
  y: number;
  /** 视觉半径（文档坐标；调用方通常按 1/scale 折算成固定屏幕大小） */
  r: number;
}

/** 默认羽化（像素）。给一个能一眼看出"软边"的值，而不是 0。 */
export const DEFAULT_FEATHER = 40;

/* ---------------------------------------------------------------- 构造 */

export function defaultEllipse(docW: number, docH: number, feather = DEFAULT_FEATHER): GradeWindow {
  return { kind: "ellipse", cx: docW / 2, cy: docH / 2, rx: docW * 0.3, ry: docH * 0.3, feather };
}

/**
 * 四边形：默认是画面中间一个矩形框的四角。
 * 注意它**不是**"矩形工具"—— 拖任意一个角，另外三个角原地不动，形状可以变成任意四边形。
 */
export function defaultQuad(docW: number, docH: number, feather = DEFAULT_FEATHER): GradeWindow {
  const x0 = docW * 0.2;
  const y0 = docH * 0.2;
  const x1 = docW * 0.8;
  const y1 = docH * 0.8;
  return {
    kind: "quad",
    points: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    feather,
  };
}

/** 线性：默认横跨画面中间偏上，法线朝上（一侧不调、另一侧调）。 */
export function defaultLine(docW: number, docH: number, feather = DEFAULT_FEATHER): GradeWindow {
  const y = docH * 0.45;
  return { kind: "line", x1: docW * 0.1, y1: y, x2: docW * 0.9, y2: y, feather };
}

/**
 * 钢笔：**从空开始**，等用户自己点。
 *
 * 以前这里给一个预置五边形，看着像"已经画好了"，但那是猜的形状 ——
 * 钢笔该是「点一下 → 橡皮筋跟着走 → 再点一点 → …」直到闭合。
 * 点集为空时蒙版全透明（等于没有范围），所以建完不会有副作用。
 */
export function defaultPoly(docW: number, docH: number, feather = DEFAULT_FEATHER): GradeWindow {
  void docW;
  void docH;
  return { kind: "poly", points: [], feather };
}

/** 由选区的包围盒造一个四边形范围。 */
export function quadFromBox(
  box: { x: number; y: number; w: number; h: number },
  feather = DEFAULT_FEATHER,
): GradeWindow {
  return {
    kind: "quad",
    points: [
      { x: box.x, y: box.y },
      { x: box.x + box.w, y: box.y },
      { x: box.x + box.w, y: box.y + box.h },
      { x: box.x, y: box.y + box.h },
    ],
    feather,
  };
}

/* ---------------------------------------------------------------- 工具 */

const norm = (a: number) => {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
};

/** 把点绕 (cx,cy) 反向旋转 rot —— 转进形状自己的坐标系再做命中判断。 */
function unrotate(px: number, py: number, cx: number, cy: number, rot = 0) {
  if (!rot) return { x: px, y: py };
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** 四点（或任意多点）的质心。 */
export function centroidOf(points: Pt[]): Pt {
  const n = Math.max(1, points.length);
  return {
    x: points.reduce((s, p) => s + p.x, 0) / n,
    y: points.reduce((s, p) => s + p.y, 0) / n,
  };
}

/** 形状中心（线 = 中点；多边形 = 顶点均值）。 */
export function windowCenter(w: GradeWindow): Pt {
  if (w.kind === "ellipse") return { x: w.cx, y: w.cy };
  if (w.kind === "line") return { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 };
  return centroidOf(w.points);
}

/** 四边形的四条边羽化宽度（缺省都等于统一羽化）。 */
export function quadEdgeFeathers(w: GradeWindow): [number, number, number, number] {
  const def = Math.max(0, w.feather);
  if (w.kind !== "quad") return [def, def, def, def];
  const e = w.edges ?? [];
  return [0, 1, 2, 3].map((i) => {
    const v = Number(e[i]);
    return Number.isFinite(v) ? Math.max(0, v) : def;
  }) as [number, number, number, number];
}

/** 多边形内部（射线法）。 */
function pointInPolygon(points: Pt[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 范围的包围盒（含羽化向外扩散的部分）。 */
export function windowBounds(w: GradeWindow): { x: number; y: number; w: number; h: number } {
  if (w.kind === "ellipse") {
    const f = Math.max(0, w.feather);
    if (!w.rot) {
      return { x: w.cx - w.rx - f, y: w.cy - w.ry - f, w: (w.rx + f) * 2, h: (w.ry + f) * 2 };
    }
    const c = Math.cos(w.rot);
    const s = Math.sin(w.rot);
    const ex = Math.hypot(w.rx * c, w.ry * s);
    const ey = Math.hypot(w.rx * s, w.ry * c);
    return { x: w.cx - ex - f, y: w.cy - ey - f, w: (ex + f) * 2, h: (ey + f) * 2 };
  }
  if (w.kind === "line") {
    const f = Math.max(0, w.feather);
    return {
      x: Math.min(w.x1, w.x2) - f,
      y: Math.min(w.y1, w.y2) - f,
      w: Math.abs(w.x2 - w.x1) + f * 2,
      h: Math.abs(w.y2 - w.y1) + f * 2,
    };
  }
  // 四边形 / 多边形：顶点极值 + 最大羽化
  const f =
    w.kind === "quad" ? Math.max(...quadEdgeFeathers(w)) : Math.max(0, w.feather);
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

/** 点到线段的距离。 */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 点是否落在范围里（不含羽化过渡区）。 */
export function windowHit(w: GradeWindow, px: number, py: number): boolean {
  if (w.kind === "ellipse") {
    if (w.rx <= 0 || w.ry <= 0) return false;
    const p = unrotate(px, py, w.cx, w.cy, w.rot);
    const dx = (p.x - w.cx) / w.rx;
    const dy = (p.y - w.cy) / w.ry;
    return dx * dx + dy * dy <= 1;
  }
  if (w.kind === "line") {
    return distToSegment(px, py, w.x1, w.y1, w.x2, w.y2) <= Math.max(8, w.feather);
  }
  return pointInPolygon(w.points, px, py);
}

/** 一条边的外法线（指向远离质心的一侧）。 */
function outwardNormal(a: Pt, b: Pt, center: Pt): Pt {
  let nx = -(b.y - a.y);
  let ny = b.x - a.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  // 若这条法线指向内部，翻过来
  if ((center.x - mx) * nx + (center.y - my) * ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

/**
 * 列出可拖的手柄。
 * @param scale 当前缩放（手柄半径按 7/scale 给，屏幕上大小恒定）
 */
export function windowHandles(w: GradeWindow, scale: number): Handle[] {
  /**
   * 手柄命中半径：屏幕上恒定 15px（一路从 7 → 12 → 15 调上来的）。
   *
   * 判定区比画出来的圆点大一圈是常规做法 —— 人不是瞄准镜，
   * 按住的点总会偏几个像素；偏出去的那一下如果判成"点了别处"，
   * 手感就是"抓不住"。
   */
  const r = 15 / Math.max(0.05, scale);
  const f = Math.max(0, w.feather);
  const rotOff = (ox: number, oy: number, cx: number, cy: number, rot = 0) => {
    if (!rot) return { x: cx + ox, y: cy + oy };
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    return { x: cx + ox * c - oy * s, y: cy + ox * s + oy * c };
  };

  if (w.kind === "ellipse") {
    const { cx, cy, rx, ry, rot } = w;
    const at = (ox: number, oy: number) => rotOff(ox, oy, cx, cy, rot);
    return [
      { id: "move", ...at(0, 0), r },
      { id: "e", ...at(rx, 0), r },
      { id: "w", ...at(-rx, 0), r },
      { id: "n", ...at(0, -ry), r },
      { id: "s", ...at(0, ry), r },
      { id: "rotate", ...at(0, -(ry + f + r * 4)), r },
      { id: "feather", ...at(rx + f, -(ry + f)), r },
    ];
  }

  if (w.kind === "quad") {
    const c = centroidOf(w.points);
    const fe = quadEdgeFeathers(w);
    const hs: Handle[] = [{ id: "move", x: c.x, y: c.y, r }];
    w.points.forEach((p, i) => hs.push({ id: `v${i}`, x: p.x, y: p.y, r }));
    // 每条边中点外侧一个羽化把手：拖它改这一条边的淡出宽度
    for (let i = 0; i < 4; i += 1) {
      const a = w.points[i];
      const b = w.points[(i + 1) % 4];
      const n = outwardNormal(a, b, c);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      hs.push({
        id: `fe${i}`,
        x: mx + n.x * (fe[i] + r * 2),
        y: my + n.y * (fe[i] + r * 2),
        r,
      });
    }
    return hs;
  }

  if (w.kind === "line") {
    const mx = (w.x1 + w.x2) / 2;
    const my = (w.y1 + w.y2) / 2;
    // 法线：与蒙版渐变同一边向（+n 是"淡出到透明"的那一侧）
    const dx = w.x2 - w.x1;
    const dy = w.y2 - w.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const off = Math.max(12, f);
    return [
      { id: "move", x: mx, y: my, r },
      { id: "a", x: w.x1, y: w.y1, r },
      { id: "b", x: w.x2, y: w.y2, r },
      { id: "feather", x: mx + nx * off, y: my + ny * off, r },
    ];
  }

  // 空点集（钢笔刚建、还没点）没有任何手柄
  if (w.points.length === 0) return [];
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
  /**
   * 取**距离最近**的那个手柄，而不是"第一个落进半径的"。
   *
   * 形状小或者放大之后，几个手柄的判定圈会互相重叠 —— 先到先得会让用户
   * 按住自己想要的点、动的却是旁边那个，手感像"抓错东西"。
   * 按距离取最接近的，重叠时就等于"判定范围各自收缩"，谁也不抢谁的。
   *
   * 反向遍历 + 严格小于：距离完全相等时保留后画的那个
   * （feather / rotate 排在数组末尾，避免被角点抢走）。
   */
  let best: { id: HandleId; d: number } | null = null;
  for (let i = hs.length - 1; i >= 0; i -= 1) {
    const h = hs[i];
    const d = Math.hypot(px - h.x, py - h.y);
    if (d > h.r) continue;
    if (!best || d < best.d) best = { id: h.id, d };
  }
  if (best) return best.id;
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
  /** 按下时的文档坐标（可选）。旋转与羽化要靠它算角度/投影，否则斜着拖会偏。 */
  origin?: { x: number; y: number },
): GradeWindow {
  if (id === "move") {
    if (from.kind === "ellipse") return { ...from, cx: from.cx + dx, cy: from.cy + dy };
    if (from.kind === "line") {
      return { ...from, x1: from.x1 + dx, y1: from.y1 + dy, x2: from.x2 + dx, y2: from.y2 + dy };
    }
    return { ...from, points: from.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }

  /**
   * 旋转：算「按下点」和「当前点」相对中心的**夹角差**。
   *
   * 早先是拿手柄位置反推方向，但手柄位置依赖缩放（半径 r 随 scale 变），
   * 于是拖起来会有一小段"先跳一下"的偏差。用按下点算就没有这个问题。
   */
  if (id === "rotate") {
    if (from.kind !== "ellipse") return from;
    const c = windowCenter(from);
    const o = origin ?? { x: c.x, y: c.y - 1 };
    const at = { x: o.x + dx, y: o.y + dy };
    const a0 = Math.atan2(o.y - c.y, o.x - c.x);
    const a1 = Math.atan2(at.y - c.y, at.x - c.x);
    return { ...from, rot: norm((from.rot ?? 0) + (a1 - a0)) };
  }

  // 四边形：某一条边的羽化（四条边各调各的）
  if (from.kind === "quad" && id.startsWith("fe")) {
    const idx = Number(id.slice(2));
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return from;
    const cur = quadEdgeFeathers(from);
    const center = centroidOf(from.points);
    const a = from.points[idx];
    const b = from.points[(idx + 1) % 4];
    const n = outwardNormal(a, b, center);
    // 沿外法线方向的位移才算数（往内收就减小）
    const move = dx * n.x + dy * n.y;
    cur[idx] = Math.max(0, Math.min(400, Math.round(cur[idx] + move)));
    return { ...from, edges: cur };
  }

  if (id === "feather") {
    let delta: number;
    if (from.kind === "line") {
      // 线段：沿法线投影（往淡出一侧拖 = 变宽）
      const vx = from.x2 - from.x1;
      const vy = from.y2 - from.y1;
      const len = Math.hypot(vx, vy) || 1;
      delta = (dx * (-vy / len) + dy * (vx / len)) * -1;
    } else {
      // 其它形状：按"到中心的距离变化"算 —— 往外拖变宽、往里拖变窄，
      // 不再是 (dx+dy) 的符号猜测（那个斜着拖会朝反方向跑）
      const c = windowCenter(from);
      const o = origin ?? { x: c.x, y: c.y };
      const d0 = Math.hypot(o.x - c.x, o.y - c.y);
      const d1 = Math.hypot(o.x + dx - c.x, o.y + dy - c.y);
      delta = d1 - d0;
    }
    const next = Math.max(0, Math.min(400, from.feather + delta));
    return { ...from, feather: Math.round(next) };
  }

  // 线性：两端点
  if (from.kind === "line") {
    if (id === "a") return { ...from, x1: from.x1 + dx, y1: from.y1 + dy };
    if (id === "b") return { ...from, x2: from.x2 + dx, y2: from.y2 + dy };
    return from;
  }

  // 四边形 / 多边形：**只动被拖的那个顶点**，其余钉死
  if ((from.kind === "quad" || from.kind === "poly") && id.startsWith("v")) {
    const idx = Number(id.slice(1));
    if (!Number.isFinite(idx) || !from.points[idx]) return from;
    const points = from.points.map((p, i) => (i === idx ? { x: p.x + dx, y: p.y + dy } : p));
    return { ...from, points };
  }

  if (from.kind === "ellipse") {
    const rot = from.rot ?? 0;
    const lx = rot ? dx * Math.cos(-rot) - dy * Math.sin(-rot) : dx;
    const ly = rot ? dx * Math.sin(-rot) + dy * Math.cos(-rot) : dy;
    switch (id) {
      case "e":
        return { ...from, rx: Math.max(2, from.rx + lx) };
      case "w":
        return { ...from, rx: Math.max(2, from.rx - lx) };
      case "s":
        return { ...from, ry: Math.max(2, from.ry + ly) };
      case "n":
        return { ...from, ry: Math.max(2, from.ry - ly) };
      default:
        return from;
    }
  }

  return from;
}

/* ---------------------------------------------------------------- 蒙版 */

/** 复用的临时画布（四边形每条边都要过一遍，别每次 new 一张 24MP 的）。 */
let scratch: HTMLCanvasElement | null = null;
function scratchCanvas(w: number, h: number): HTMLCanvasElement {
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  const ctx = scratch.getContext("2d");
  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.clearRect(0, 0, w, h);
  }
  return scratch;
}

/**
 * 把范围烘成蒙版（白 = 调色，透明 = 不调）。
 *
 * 羽化的实现分三种：
 *   · 椭圆 / 钢笔：画实心形状，再整体 blur 一次 —— 边缘自然渐变
 *   · 线性：直接用 createLinearGradient 画一条渐变带
 *   · 四边形：**每条边各自一条渐变**，再用 destination-in 连乘 ——
 *     这样四条边的羽化宽度可以完全不同（这是"四边形"和"矩形"的关键差别）
 */
export function windowToMask(docW: number, docH: number, w: GradeWindow): HTMLCanvasElement {
  const mask = createMask(docW, docH);
  const ctx = mustCtx(mask);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, docW, docH);

  if (w.kind === "line") {
    const dx = w.x2 - w.x1;
    const dy = w.y2 - w.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const mx = (w.x1 + w.x2) / 2;
    const my = (w.y1 + w.y2) / 2;
    const band = Math.max(0.5, w.feather);
    /**
     * **单向**渐变：线本身就是 100% 处，只朝 +n 一侧衰减到 0。
     * 早先写成 mid−band → mid+band 的对称渐变，等于把线两侧各淡出一半 ——
     * 那不是"线性"，是"一条中间的软缝"，跟达芬奇的 linear 差得远。
     */
    const g = ctx.createLinearGradient(mx, my, mx + nx * band, my + ny * band);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, docW, docH);
    if (w.invert) invertAlpha(ctx, docW, docH);
    return mask;
  }

  if (w.kind === "quad") {
    const pts = w.points;
    if (pts.length < 4) return mask;
    const fe = quadEdgeFeathers(w);
    const c = centroidOf(pts);
    /**
     * 只在「四边形的包围盒（含最大羽化）」里画。
     *
     * 拖手柄时这张蒙版会被反复重建（约 10 次/秒）；整幅填充 + 四条边各一次全画布
     * 相乘，在 24MP 上就是几百毫秒一次 —— 拖起来必然顿。限制到盒内之后，
     * 圈一小块的代价只跟那块面积有关。
     */
    const b = windowBounds(w);
    const bx = Math.max(0, Math.floor(b.x));
    const by = Math.max(0, Math.floor(b.y));
    const bw = Math.min(docW, Math.ceil(b.x + b.w)) - bx;
    const bh = Math.min(docH, Math.ceil(b.y + b.h)) - by;
    if (bw <= 0 || bh <= 0) return mask;

    // 起点：盒内全白（内部默认全调）
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(bx, by, bw, bh);
    // 逐边乘上"从这条边往外渐变到 0"的软边
    for (let i = 0; i < 4; i += 1) {
      const f = fe[i];
      if (f < 0.5) continue; // 这条边不羽化（硬边）
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      const n = outwardNormal(a, b, c);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const tmp = scratchCanvas(docW, docH);
      const tctx = mustCtx(tmp);
      const g = tctx.createLinearGradient(mx + n.x * f, my + n.y * f, mx, my);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(1, "rgba(255,255,255,1)");
      tctx.fillStyle = g;
      tctx.fillRect(bx, by, bw, bh);
      ctx.globalCompositeOperation = "destination-in";
      // 只乘盒内那块，盒外保持透明（合成时不会被覆盖）
      ctx.drawImage(tmp, bx, by, bw, bh, bx, by, bw, bh);
      ctx.globalCompositeOperation = "source-over";
    }
    if (w.invert) invertAlpha(ctx, docW, docH);
    return mask;
  }

  const feather = Math.max(0, w.feather);
  const tmp = createMask(docW, docH);
  const tctx = mustCtx(tmp);
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, docW, docH);
  tctx.fillStyle = "#ffffff";

  if (w.kind === "ellipse") {
    tctx.save();
    tctx.translate(w.cx, w.cy);
    if (w.rot) tctx.rotate(w.rot);
    tctx.beginPath();
    tctx.ellipse(0, 0, Math.max(0.5, w.rx), Math.max(0.5, w.ry), 0, 0, Math.PI * 2);
    tctx.fill();
    tctx.restore();
  } else {
    if (w.points.length < 3) return mask;
    tctx.beginPath();
    tctx.moveTo(w.points[0].x, w.points[0].y);
    for (let i = 1; i < w.points.length; i += 1) tctx.lineTo(w.points[i].x, w.points[i].y);
    tctx.closePath();
    tctx.fill();
  }

  if (feather > 0) ctx.filter = `blur(${feather}px)`;
  ctx.drawImage(tmp, 0, 0);
  ctx.filter = "none";
  if (w.invert) invertAlpha(ctx, docW, docH);
  return mask;
}

/** 就地反转蒙版 alpha。 */
function invertAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = 255 - d[i];
  ctx.putImageData(img, 0, 0);
}
