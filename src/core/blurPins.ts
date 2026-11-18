/**
 * 模糊画廊钉点几何（纯函数，不碰 DOM）——移植自 PhotoCraft `blur_pins.rs` 的核心：
 * 归一化钉点坐标 ↔ 文档像素、环/轴手柄位置、命中测试、拖动约束。
 *
 * 为什么单独一层：交互逻辑最容易藏 bug（坐标换算方向、命中优先级、越界），
 * 做成纯函数才能在 node 里对固定数值断言。UI 层只负责画和转发指针事件。
 *
 * 约定（对齐参考实现）：
 *  · 钉点坐标 x/y 是相对「滤镜 bounds」的 0..1 比例；
 *  · 半径 / 羽化以 bounds 的短边为基准（short_side），保证宽高比不同也不变形；
 *  · 命中优先级：轴/形状手柄 > 环 > 钉点本体 —— 否则点环会被钉点抢走。
 */

export interface Pt2 {
  x: number;
  y: number;
}

/** 滤镜 bounds：[x0,y0,x1,y1]，文档像素。 */
export type Bounds = readonly [number, number, number, number];

/** 一个钉点：归一化位置 + 模糊量 + 可选形状参数。 */
export interface BlurPin {
  x: number;
  y: number;
  /** 模糊半径（像素，文档域）。 */
  blur: number;
  /** 清晰区半径（短边比例，0..1）—— Iris / Spin。 */
  radius: number;
  /** 羽化（短边比例，0..1）—— Iris / Tilt。 */
  feather: number;
}

export const MIN_RADIUS = 0.02;
export const MAX_RADIUS = 1;
export const MAX_BLUR = 200;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 有限数兜底 + 夹取，防止 localStorage / 脏参数带 NaN 进来。 */
export function cleanPin(src: Partial<BlurPin> | null | undefined): BlurPin {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    x: clamp(num(src?.x, 0.5), 0, 1),
    y: clamp(num(src?.y, 0.5), 0, 1),
    blur: clamp(num(src?.blur, 16), 0, MAX_BLUR),
    radius: clamp(num(src?.radius, 0.35), MIN_RADIUS, MAX_RADIUS),
    feather: clamp(num(src?.feather, 0.5), 0, 1),
  };
}

export function shortSide(b: Bounds): number {
  return Math.max(1, Math.min(b[2] - b[0], b[3] - b[1]));
}

/** 归一化 → 文档像素。 */
export function toDoc(b: Bounds, p: BlurPin): Pt2 {
  return { x: b[0] + p.x * (b[2] - b[0]), y: b[1] + p.y * (b[3] - b[1]) };
}

/** 文档像素 → 归一化（夹到 0..1）。 */
export function fromDoc(b: Bounds, d: Pt2): Pt2 {
  return {
    x: clamp((d.x - b[0]) / Math.max(1, b[2] - b[0]), 0, 1),
    y: clamp((d.y - b[1]) / Math.max(1, b[3] - b[1]), 0, 1),
  };
}

/** 手柄种类 —— 命中优先级从高到低。 */
export type GrabKind = "radius" | "center" | "new" | null;

/** 屏幕上可抓的半径（CSS px），与 GradeWindow 的 GRAB 同量级。 */
const GRAB = 14;

/**
 * 命中测试。返回抓到了哪种手柄（已选中钉点时优先半径环、再中心）。
 * screenDist 是「文档像素 → 屏幕像素」的缩放比；手柄阈值按屏幕像素固定。
 */
export function hitPin(
  b: Bounds,
  p: BlurPin,
  at: Pt2,
  screenDist: number,
  selected: boolean,
): GrabKind {
  const c = toDoc(b, p);
  const ring = p.radius * shortSide(b);
  // at 是文档坐标；阈值按屏幕像素固定 → 文档域阈值 = GRAB / screenDist（screenDist=屏幕px/文档px，与 GradeWindow 一致）
  const tol = GRAB / Math.max(0.05, screenDist);
  const dCenter = Math.hypot(at.x - c.x, at.y - c.y);
  const dRing = Math.hypot(at.x - (c.x + ring), at.y - c.y);
  if (selected && dRing <= tol) return "radius";
  if (dCenter <= tol) return "center";
  return null;
}

/** 该滤镜是否支持「半径环」手柄。Field / Path 用方向线，Tilt 用带宽，Iris/Spin 用环。 */
export function usesRing(id: string): boolean {
  return id === "filter.blurGallery.irisBlur" || id === "filter.blurGallery.spinBlur";
}

/** 钉点 → 滤镜参数（写回 FilterDef 的 params，字段名与 defs.ts 一致）。 */
export function pinToParams(id: string, p: BlurPin): Record<string, number> {
  // defs 的 cx/cy 是相对整图 0..100；bounds 就是整层（0,0,docW,docH），
  // 故用归一化 p.x/p.y 直接换算，与 bounds 原点无关（避免偏移 bounds 时算出负/超界百分比）。
  const cxPct = Math.round(p.x * 100);
  const cyPct = Math.round(p.y * 100);
  switch (id) {
    case "filter.blurGallery.irisBlur":
      return {
        radius: Math.round(p.blur),
        cx: cxPct,
        cy: cyPct,
        iris: Math.round(p.radius * 100),
      };
    case "filter.blurGallery.spinBlur":
      return {
        angle: Math.round(p.blur * 18), // blur 0..200 → 0..360°
        cx: cxPct,
        cy: cyPct,
      };
    case "filter.blurGallery.tiltShift":
      return {
        radius: Math.round(p.blur),
        center: Math.round(p.y * 100),
      };
    case "filter.blurGallery.fieldBlur":
      return {
        amount: Math.round(p.blur),
      };
    case "filter.blurGallery.pathBlur":
      return {
        distance: Math.round(p.blur),
      };
    default:
      return {};
  }
}

/** 滤镜参数 → 初始钉点（打开画布时从现有 params 反推，保证滑块与钉点一致）。 */
export function paramsToPin(id: string, params: Record<string, number>): BlurPin {
  const num = (k: string, d: number) => (typeof params[k] === "number" && Number.isFinite(params[k]) ? params[k] : d);
  switch (id) {
    case "filter.blurGallery.irisBlur":
      return cleanPin({
        x: num("cx", 50) / 100,
        y: num("cy", 50) / 100,
        blur: num("radius", 16),
        radius: num("iris", 30) / 100,
      });
    case "filter.blurGallery.spinBlur":
      return cleanPin({
        x: num("cx", 50) / 100,
        y: num("cy", 50) / 100,
        blur: num("angle", 20) / 18,
      });
    case "filter.blurGallery.tiltShift":
      return cleanPin({ x: 0.5, y: num("center", 50) / 100, blur: num("radius", 18), radius: 0.25 });
    case "filter.blurGallery.fieldBlur":
      return cleanPin({ x: 0.5, y: 0.5, blur: num("amount", 12), radius: 0.3 });
    case "filter.blurGallery.pathBlur":
      return cleanPin({ x: 0.5, y: 0.5, blur: num("distance", 40), radius: 0.3 });
    default:
      return cleanPin({});
  }
}

/** 该 id 是不是模糊画廊族。 */
export function isBlurGallery(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("filter.blurGallery.");
}
