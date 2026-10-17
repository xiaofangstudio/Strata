/**
 * 图层模型。
 *
 * M1 的图层 = 一张位图（surface）+ 一组属性。调整图层、文字、形状、组
 * 属于 P1 / P2，这里先把「像素图层」的结构与混合模式定死，后续类型在
 * 同一接口上扩展，不做返工。
 */
import { cloneSurface, createSurface, mustCtx } from "../engine/surface";
import {
  clamp01,
  colorMatrixMarkup,
  convolveMarkup,
  curveTable,
  hexToRgb01,
  linearToSrgb,
  luma01,
  lumaMatrixMarkup,
  motionMarkup,
  noiseMarkup,
  rgbTransfer,
  srgbToLinear,
  svgFilter,
  tableOf,
  uniDiscrete,
  uniLinear,
  uniTransfer,
  type CurvePoint,
} from "../engine/filters";

/**
 * 混合模式。
 *
 * 全套 27 种，与 PS「混合模式」下拉的条目与分组完全对齐（正常 / 变暗 /
 * 变亮 / 对比 / 反相 / 分量），一条不缺、也一条不多。
 *
 * 其中 16 种能直接映射到 Canvas2D 的 globalCompositeOperation，交给 GPU；
 * 剩下 11 种（溶解、线性加深、深色、线性减淡、浅色、亮光、线性光、点光、
 * 实色混合、减去、划分）Canvas2D 不提供，标记 soft: true，由 engine/blend
 * 在 ImageData 上逐像素软件合成 —— 两边都渲染得出来，所以没有假条目。
 */
export type BlendId =
  | "normal"
  | "dissolve"
  | "darken"
  | "multiply"
  | "color-burn"
  | "linear-burn"
  | "darker-color"
  | "lighten"
  | "screen"
  | "color-dodge"
  | "linear-dodge"
  | "lighter-color"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "vivid-light"
  | "linear-light"
  | "pin-light"
  | "hard-mix"
  | "difference"
  | "exclusion"
  | "subtract"
  | "divide"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export interface BlendDef {
  id: BlendId;
  label: string;
  /** 对应的 Canvas2D globalCompositeOperation */
  op: GlobalCompositeOperation;
  /** 需要逐像素软件合成的模式（Canvas2D 不提供），见 engine/blend */
  soft?: true;
}

export const BLEND_MODES: readonly BlendDef[] = [
  /* 正常组 */
  { id: "normal", label: "正常", op: "source-over" },
  { id: "dissolve", label: "溶解", op: "source-over", soft: true },
  /* 变暗组 */
  { id: "darken", label: "变暗", op: "darken" },
  { id: "multiply", label: "正片叠底", op: "multiply" },
  { id: "color-burn", label: "颜色加深", op: "color-burn" },
  { id: "linear-burn", label: "线性加深", op: "source-over", soft: true },
  { id: "darker-color", label: "深色", op: "source-over", soft: true },
  /* 变亮组 */
  { id: "lighten", label: "变亮", op: "lighten" },
  { id: "screen", label: "滤色", op: "screen" },
  { id: "color-dodge", label: "颜色减淡", op: "color-dodge" },
  { id: "linear-dodge", label: "线性减淡", op: "source-over", soft: true },
  { id: "lighter-color", label: "浅色", op: "source-over", soft: true },
  /* 对比组 */
  { id: "overlay", label: "叠加", op: "overlay" },
  { id: "soft-light", label: "柔光", op: "soft-light" },
  { id: "hard-light", label: "强光", op: "hard-light" },
  { id: "vivid-light", label: "亮光", op: "source-over", soft: true },
  { id: "linear-light", label: "线性光", op: "source-over", soft: true },
  { id: "pin-light", label: "点光", op: "source-over", soft: true },
  { id: "hard-mix", label: "实色混合", op: "source-over", soft: true },
  /* 反相组 */
  { id: "difference", label: "差值", op: "difference" },
  { id: "exclusion", label: "排除", op: "exclusion" },
  { id: "subtract", label: "减去", op: "source-over", soft: true },
  { id: "divide", label: "划分", op: "source-over", soft: true },
  /* 分量组 */
  { id: "hue", label: "色相", op: "hue" },
  { id: "saturation", label: "饱和度", op: "saturation" },
  { id: "color", label: "颜色", op: "color" },
  { id: "luminosity", label: "明度", op: "luminosity" },
];

const BLEND_BY_ID = new Map<string, BlendDef>(
  BLEND_MODES.map((b) => [b.id, b]),
);

/** 混合模式 → Canvas2D 合成算子。未知 id 退回正常。 */
export function blendOp(id: BlendId): GlobalCompositeOperation {
  return BLEND_BY_ID.get(id)?.op ?? "source-over";
}

/**
 * 这个混合模式是否必须走软件合成。
 *
 * 已声明 soft 的按声明；未知 id 交给 engine/blend 自己判断（两边同一张表）。
 */
export function isSoftBlend(id: BlendId): boolean {
  return BLEND_BY_ID.get(id)?.soft === true;
}

/** 混合模式 → 中文名。 */
export function blendLabel(id: BlendId): string {
  return BLEND_BY_ID.get(id)?.label ?? "正常";
}

/**
 * 调整图层的种类。
 *
 * 分三族（明暗 / 色彩 / 效果），与 PS「调整」面板的分组一致，菜单也按族
 * 分节显示 —— 类型一多最怕平铺成一条长菜单，分节之后一眼能定位。
 *
 * 实现上三条路，最终都只是 ctx.filter 里的一段字符串：
 *  · Canvas2D 自带 filter：亮度对比度、色相饱和度、去色、反相、模糊；
 *  · SVG feComponentTransfer：色阶、曲线、曝光、阈值、色调分离、渐变映射、色彩平衡；
 *  · SVG 其它原语：通道混合器（feColorMatrix）、锐化（feConvolveMatrix）、
 *    动感模糊（各向异性 feGaussianBlur）、颗粒与杂色（feTurbulence + feBlend）。
 *
 * 无论走哪条路，都是「调参数不碰像素、随时可改可删」的非破坏调整。
 */
export type AdjustId =
  | "bc"
  | "levels"
  | "curves"
  | "exposure"
  | "hs"
  | "colorbalance"
  | "bw"
  | "gradientmap"
  | "channelmixer"
  | "invert"
  | "threshold"
  | "posterize"
  | "channellevels"
  | "shadowhighlight"
  | "colortemp"
  | "photofilter"
  | "blur"
  | "motionblur"
  | "sharpen"
  | "grain"
  | "noise";

/** 调整类型的族别，只用于菜单与面板分组。 */
export type AdjustFamily = "tone" | "color" | "effect";

/** 一个可调参数的取值范围。 */
export interface AdjustParam {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 新建时的默认值 */
  def: number;
  unit?: string;
  /** 显示保留的小数位，默认 0 位 */
  dec?: number;
  /** 同一条调整里再分组的标题（色彩平衡、通道混合器用） */
  group?: string;
}

export interface AdjustDef {
  id: AdjustId;
  label: string;
  family: AdjustFamily;
  params: AdjustParam[];
}

export const ADJUST_DEFS: readonly AdjustDef[] = [
  /* ------------------------------------------------------------ 明暗 */
  {
    id: "bc",
    label: "亮度 / 对比度",
    family: "tone",
    params: [
      { id: "brightness", label: "亮度", min: -100, max: 100, step: 1, def: 0 },
      { id: "contrast", label: "对比度", min: -100, max: 100, step: 1, def: 0 },
    ],
  },
  {
    id: "levels",
    label: "色阶",
    family: "tone",
    params: [
      { id: "inBlack", label: "输入黑场", min: 0, max: 254, step: 1, def: 0, group: "输入色阶" },
      { id: "inWhite", label: "输入白场", min: 1, max: 255, step: 1, def: 255, group: "输入色阶" },
      { id: "gamma", label: "灰度系数", min: 10, max: 300, step: 1, def: 100, unit: "%", group: "输入色阶" },
      { id: "outBlack", label: "输出黑场", min: 0, max: 254, step: 1, def: 0, group: "输出色阶" },
      { id: "outWhite", label: "输出白场", min: 1, max: 255, step: 1, def: 255, group: "输出色阶" },
    ],
  },
  { id: "curves", label: "曲线", family: "tone", params: [] },
  {
    id: "exposure",
    label: "曝光",
    family: "tone",
    params: [
      { id: "exposure", label: "曝光", min: -5, max: 5, step: 0.01, def: 0, dec: 2, unit: " EV" },
      { id: "offset", label: "偏移", min: -0.5, max: 0.5, step: 0.01, def: 0, dec: 2 },
      { id: "gamma", label: "灰度系数", min: 0.1, max: 3, step: 0.01, def: 1, dec: 2 },
    ],
  },
  {
    id: "threshold",
    label: "阈值",
    family: "tone",
    params: [{ id: "level", label: "阈值色阶", min: 1, max: 254, step: 1, def: 128 }],
  },
  {
    id: "posterize",
    label: "色调分离",
    family: "tone",
    params: [{ id: "levels", label: "色阶数", min: 2, max: 64, step: 1, def: 6 }],
  },
  {
    id: "channellevels",
    label: "通道色阶",
    family: "tone",
    params: [
      { id: "rBlack", label: "输入黑场", min: 0, max: 254, step: 1, def: 0, group: "红" },
      { id: "rWhite", label: "输入白场", min: 1, max: 255, step: 1, def: 255, group: "红" },
      { id: "rGamma", label: "灰度系数", min: 10, max: 300, step: 1, def: 100, unit: "%", group: "红" },
      { id: "gBlack", label: "输入黑场", min: 0, max: 254, step: 1, def: 0, group: "绿" },
      { id: "gWhite", label: "输入白场", min: 1, max: 255, step: 1, def: 255, group: "绿" },
      { id: "gGamma", label: "灰度系数", min: 10, max: 300, step: 1, def: 100, unit: "%", group: "绿" },
      { id: "bBlack", label: "输入黑场", min: 0, max: 254, step: 1, def: 0, group: "蓝" },
      { id: "bWhite", label: "输入白场", min: 1, max: 255, step: 1, def: 255, group: "蓝" },
      { id: "bGamma", label: "灰度系数", min: 10, max: 300, step: 1, def: 100, unit: "%", group: "蓝" },
    ],
  },
  {
    id: "shadowhighlight",
    label: "阴影 / 高光",
    family: "tone",
    params: [
      { id: "shadow", label: "阴影提亮", min: 0, max: 100, step: 1, def: 0, unit: "%" },
      { id: "highlight", label: "高光压暗", min: 0, max: 100, step: 1, def: 0, unit: "%" },
    ],
  },

  /* ------------------------------------------------------------ 色彩 */
  {
    id: "hs",
    label: "色相 / 饱和度",
    family: "color",
    params: [
      { id: "hue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°" },
      { id: "saturate", label: "饱和度", min: -100, max: 100, step: 1, def: 0 },
    ],
  },
  {
    id: "colorbalance",
    label: "色彩平衡",
    family: "color",
    params: [
      { id: "shcr", label: "青色 — 红色", min: -100, max: 100, step: 1, def: 0, group: "阴影" },
      { id: "shmg", label: "洋红 — 绿色", min: -100, max: 100, step: 1, def: 0, group: "阴影" },
      { id: "shyb", label: "黄色 — 蓝色", min: -100, max: 100, step: 1, def: 0, group: "阴影" },
      { id: "mdcr", label: "青色 — 红色", min: -100, max: 100, step: 1, def: 0, group: "中间调" },
      { id: "mdmg", label: "洋红 — 绿色", min: -100, max: 100, step: 1, def: 0, group: "中间调" },
      { id: "mdyb", label: "黄色 — 蓝色", min: -100, max: 100, step: 1, def: 0, group: "中间调" },
      { id: "hicr", label: "青色 — 红色", min: -100, max: 100, step: 1, def: 0, group: "高光" },
      { id: "himg", label: "洋红 — 绿色", min: -100, max: 100, step: 1, def: 0, group: "高光" },
      { id: "hiyb", label: "黄色 — 蓝色", min: -100, max: 100, step: 1, def: 0, group: "高光" },
    ],
  },
  {
    id: "bw",
    label: "黑白",
    family: "color",
    params: [{ id: "amount", label: "强度", min: 0, max: 100, step: 1, def: 100, unit: "%" }],
  },
  { id: "gradientmap", label: "渐变映射", family: "color", params: [] },
  {
    id: "channelmixer",
    label: "通道混合器",
    family: "color",
    params: [
      { id: "rr", label: "红色", min: -200, max: 200, step: 1, def: 100, unit: "%", group: "输出 · 红" },
      { id: "rg", label: "绿色", min: -200, max: 200, step: 1, def: 0, unit: "%", group: "输出 · 红" },
      { id: "rb", label: "蓝色", min: -200, max: 200, step: 1, def: 0, unit: "%", group: "输出 · 红" },
      { id: "rc", label: "常数", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "输出 · 红" },
      { id: "gr", label: "红色", min: -200, max: 200, step: 1, def: 0, unit: "%", group: "输出 · 绿" },
      { id: "gg", label: "绿色", min: -200, max: 200, step: 1, def: 100, unit: "%", group: "输出 · 绿" },
      { id: "gb", label: "蓝色", min: -200, max: 200, step: 1, def: 0, unit: "%", group: "输出 · 绿" },
      { id: "gc", label: "常数", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "输出 · 绿" },
      { id: "br", label: "红色", min: -200, max: 200, step: 1, def: 0, unit: "%", group: "输出 · 蓝" },
      { id: "bg", label: "绿色", min: -200, max: 200, step: 1, def: 0, unit: "%", group: "输出 · 蓝" },
      { id: "bb", label: "蓝色", min: -200, max: 200, step: 1, def: 100, unit: "%", group: "输出 · 蓝" },
      { id: "bc", label: "常数", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "输出 · 蓝" },
    ],
  },
  {
    id: "invert",
    label: "反相",
    family: "color",
    params: [{ id: "amount", label: "强度", min: 0, max: 100, step: 1, def: 100, unit: "%" }],
  },
  {
    id: "colortemp",
    label: "色温",
    family: "color",
    params: [
      { id: "temp", label: "色温", min: -100, max: 100, step: 1, def: 0 },
      { id: "tint", label: "色调", min: -100, max: 100, step: 1, def: 0 },
    ],
  },
  {
    id: "photofilter",
    label: "照片滤镜",
    family: "color",
    params: [
      { id: "hue", label: "滤镜色相", min: 0, max: 360, step: 1, def: 40, unit: "°" },
      { id: "strength", label: "浓度", min: 0, max: 100, step: 1, def: 0, unit: "%" },
      { id: "preserve", label: "保留明度", min: 0, max: 100, step: 1, def: 100, unit: "%" },
    ],
  },

  /* ------------------------------------------------------------ 效果 */
  {
    id: "blur",
    label: "模糊",
    family: "effect",
    params: [{ id: "radius", label: "半径", min: 0, max: 60, step: 1, def: 6, unit: "px" }],
  },
  {
    id: "motionblur",
    label: "动感模糊",
    family: "effect",
    params: [
      { id: "angle", label: "角度", min: 0, max: 360, step: 1, def: 0, unit: "°" },
      { id: "distance", label: "距离", min: 0, max: 200, step: 1, def: 24, unit: "px" },
    ],
  },
  {
    id: "sharpen",
    label: "锐化",
    family: "effect",
    params: [{ id: "amount", label: "总量", min: 0, max: 200, step: 1, def: 70, unit: "%" }],
  },
  {
    id: "grain",
    label: "颗粒",
    family: "effect",
    params: [
      { id: "amount", label: "数量", min: 0, max: 100, step: 1, def: 25, unit: "%" },
      { id: "size", label: "大小", min: 1, max: 12, step: 1, def: 3, unit: "px" },
    ],
  },
  {
    id: "noise",
    label: "添加杂色",
    family: "effect",
    params: [
      { id: "amount", label: "数量", min: 0, max: 100, step: 1, def: 20, unit: "%" },
      { id: "size", label: "大小", min: 1, max: 12, step: 1, def: 1, unit: "px" },
    ],
  },
];

export function adjustDef(id: AdjustId): AdjustDef {
  return ADJUST_DEFS.find((d) => d.id === id) ?? ADJUST_DEFS[0];
}

/** 调整类型属于哪一族（菜单分组用）。 */
export function adjustFamily(id: AdjustId): AdjustFamily {
  return adjustDef(id).family;
}

/** 渐变映射的一个色标。 */
export interface GradientStop {
  /** 位置 0–1 */
  at: number;
  /** #rrggbb */
  color: string;
}

/** 一张调整图层的参数状态。 */
export interface AdjustState {
  id: AdjustId;
  params: Record<string, number>;
  /** 曲线控制点（id === "curves" 时用），按 x 升序 */
  curve?: CurvePoint[];
  /** 渐变映射色标（id === "gradientmap" 时用），按 at 升序 */
  stops?: GradientStop[];
}

/** 曲线默认是一条对角线，等于不改动画面。 */
export const DEFAULT_CURVE: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** 渐变映射默认是黑 → 白，同样等于不改动画面。 */
export const DEFAULT_STOPS: readonly GradientStop[] = [
  { at: 0, color: "#000000" },
  { at: 1, color: "#ffffff" },
];

/** 按定义生成一份默认参数（含曲线 / 渐变映射的初始数据）。 */
export function newAdjustState(id: AdjustId): AdjustState {
  const def = adjustDef(id);
  const params: Record<string, number> = {};
  for (const p of def.params) params[p.id] = p.def;
  const state: AdjustState = { id, params };
  if (id === "curves") state.curve = DEFAULT_CURVE.map((c) => ({ ...c }));
  if (id === "gradientmap") state.stops = DEFAULT_STOPS.map((s) => ({ ...s }));
  return state;
}

/**
 * 深拷贝一份调整状态。
 *
 * 复制图层与历史快照都必须走这里 —— 曲线与色标是引用类型，浅拷贝会让两张
 * 图层共用同一份数据，改一张另一张跟着变。
 */
export function cloneAdjust(state: AdjustState): AdjustState {
  const out: AdjustState = { id: state.id, params: { ...state.params } };
  if (state.curve) out.curve = state.curve.map((c) => ({ ...c }));
  if (state.stops) out.stops = state.stops.map((s) => ({ ...s }));
  return out;
}

/* ------------------------------------------------------------ 内部工具 */

/** Photoshop 通道混合器的单位矩阵，用来判断「参数是否还是中性的」。 */
const MIXER_IDENTITY = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/** 曲线是否就是那条对角线。 */
function isIdentityCurve(pts: readonly CurvePoint[]): boolean {
  return pts.every((c) => Math.abs(c.x - c.y) < 1e-4);
}

/** 色标是否就是默认的黑白两点。 */
function isIdentityStops(stops: readonly GradientStop[]): boolean {
  if (stops.length !== 2) return false;
  return (
    stops[0].at === 0 &&
    stops[1].at === 1 &&
    stops[0].color.toLowerCase() === "#000000" &&
    stops[1].color.toLowerCase() === "#ffffff"
  );
}

/** 按位置在渐变上取色（相邻色标之间线性插值）。 */
function sampleStops(
  stops: readonly GradientStop[],
  x: number,
): [number, number, number] {
  const n = stops.length;
  if (n === 0) return [x, x, x];
  if (n === 1) return hexToRgb01(stops[0].color);
  const t = clamp01(x);
  if (t <= stops[0].at) return hexToRgb01(stops[0].color);
  if (t >= stops[n - 1].at) return hexToRgb01(stops[n - 1].color);
  let k = 0;
  while (k < n - 2 && t > stops[k + 1].at) k += 1;
  const a = stops[k];
  const b = stops[k + 1];
  const u = (t - a.at) / Math.max(1e-6, b.at - a.at);
  const ca = hexToRgb01(a.color);
  const cb = hexToRgb01(b.color);
  return [
    ca[0] + (cb[0] - ca[0]) * u,
    ca[1] + (cb[1] - ca[1]) * u,
    ca[2] + (cb[2] - ca[2]) * u,
  ];
}

/** 把一段 SVG 滤镜原语注册成 `sfx-<图层 id>`，返回可赋给 ctx.filter 的 url()。 */
function register(layerId: string, markup: string): string {
  const id = `sfx-${layerId}`;
  return svgFilter(id, markup, markup);
}

/**
 * 色彩平衡的权重曲线。
 *
 * 阴影、中间调、高光三条钟形曲线按像素自身色阶取样，峰位分别落在 0、0.5、1；
 * 中间调那条归一化到峰高 1，三条曲线顶端强度才一致（PS 就是这么分的）。
 */
function balanceWeights(x: number): [number, number, number] {
  const s = (1 - x) * (1 - x) * (1 - x);
  const h = x * x * x;
  return [s, (1 - s - h) / 0.75, h];
}

/**
 * 色相（0–1 一圈）→ 中等饱和的 RGB（各 0–1）。
 *
 * 照片滤镜只需要「一个颜色」，不必让用户理解 HSL；固定饱和度 0.55、
 * 亮度 0.5，保证任何色相下 2c−1 的增益幅度都在合理区间。
 */
function hueRgb01(t: number): [number, number, number] {
  const h = ((t % 1) + 1) % 1;
  const s = 0.55;
  const l = 0.5;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    const v = k < 1 ? p + (q - p) * k : k < 3 ? q : k < 4 ? p + (q - p) * (4 - k) : p;
    return clamp01(v);
  };
  return [f(0), f(2), f(4)];
}

/**
 * 把参数状态编译成一条滤镜串。
 *
 * `layerId` 用于给 SVG 滤镜起名（`sfx-<图层 id>`）—— 同一条调整可能同时挂在
 * 多张图层上，参数不同，必须一个图层一份，不能共用。
 *
 * 参数全为中性时返回空串，调用方据此跳过整个调整，省一次全画布拷贝。
 */
export function adjustFilter(state: AdjustState, layerId: string): string {
  const p = state.params;
  const parts: string[] = [];
  switch (state.id) {
    /* ---------------------------------------------------------- 明暗 */
    case "bc": {
      const b = p.brightness ?? 0;
      const c = p.contrast ?? 0;
      if (b) parts.push(`brightness(${(1 + b / 100).toFixed(3)})`);
      if (c) parts.push(`contrast(${(1 + c / 100).toFixed(3)})`);
      break;
    }
    case "levels": {
      const ib = p.inBlack ?? 0;
      const iw = p.inWhite ?? 255;
      const g = p.gamma ?? 100;
      const ob = p.outBlack ?? 0;
      const ow = p.outWhite ?? 255;
      if (ib !== 0 || iw !== 255 || g !== 100 || ob !== 0 || ow !== 255) {
        const span = Math.max(1, iw - ib);
        const inv = 100 / Math.max(1, g);
        parts.push(
          register(
            layerId,
            uniTransfer(
              tableOf((x) => {
                const v = clamp01((x * 255 - ib) / span);
                const w = Math.pow(v, inv);
                return (ob + w * (ow - ob)) / 255;
              }),
            ),
          ),
        );
      }
      break;
    }
    case "curves": {
      const pts = state.curve;
      if (pts && pts.length >= 2 && !isIdentityCurve(pts)) {
        parts.push(register(layerId, uniTransfer(curveTable(pts))));
      }
      break;
    }
    case "exposure": {
      const ev = p.exposure ?? 0;
      const off = p.offset ?? 0;
      const ga = p.gamma ?? 1;
      if (ev || off || ga !== 1) {
        const gain = Math.pow(2, ev);
        const ig = 1 / Math.max(0.01, ga);
        parts.push(
          register(
            layerId,
            uniTransfer(
              tableOf((x) => {
                // 在光强域里算，再回写 sRGB —— 直接乘 sRGB 数值会歪掉中间调
                const lin = srgbToLinear(x) * gain + off;
                return linearToSrgb(lin <= 0 ? 0 : Math.pow(lin, ig));
              }),
            ),
          ),
        );
      }
      break;
    }
    case "threshold": {
      // 大斜率 + 落在色阶上的截距 = 一条干净的硬边台阶，比采样成斜坡准
      const t = (p.level ?? 128) / 255;
      parts.push(register(layerId, uniLinear(1000, 0.5 - 1000 * t)));
      break;
    }
    case "posterize": {
      parts.push(register(layerId, uniDiscrete(p.levels ?? 6)));
      break;
    }
    case "channellevels": {
      // 每个通道各自一条色阶表；某通道全中性就返回 null，最后统一补恒等表
      const ch = (bk: number, wt: number, gm: number): string | null => {
        if (bk === 0 && wt === 255 && gm === 100) return null;
        const span = Math.max(1, wt - bk);
        const inv = 100 / Math.max(1, gm);
        return tableOf((x) => clamp01(Math.pow(clamp01((x * 255 - bk) / span), inv)));
      };
      const r = ch(p.rBlack ?? 0, p.rWhite ?? 255, p.rGamma ?? 100);
      const g = ch(p.gBlack ?? 0, p.gWhite ?? 255, p.gGamma ?? 100);
      const b = ch(p.bBlack ?? 0, p.bWhite ?? 255, p.bGamma ?? 100);
      if (r || g || b) {
        const idn = tableOf((x) => x);
        parts.push(register(layerId, rgbTransfer(r ?? idn, g ?? idn, b ?? idn)));
      }
      break;
    }
    case "shadowhighlight": {
      const s = (p.shadow ?? 0) / 100;
      const h = (p.highlight ?? 0) / 100;
      if (s || h) {
        parts.push(
          register(
            layerId,
            uniTransfer(
              tableOf((x) => {
                // 阴影权重峰在 1/3 处、高光权重峰在 2/3 处，两端都归零，
                // 所以黑点白点不动；系数 1.5 让导数最小仍为 0.25 > 0，
                // 两段叠加后整体严格单调，不会在暗部压出色带。
                const lift = 1.5 * s * x * (1 - x) * (1 - x);
                const drop = 1.5 * h * x * x * (1 - x);
                return clamp01(x + lift - drop);
              }),
            ),
          ),
        );
      }
      break;
    }

    /* ---------------------------------------------------------- 色彩 */
    case "hs": {
      const h = p.hue ?? 0;
      const s = p.saturate ?? 0;
      if (h) parts.push(`hue-rotate(${h}deg)`);
      if (s) parts.push(`saturate(${(1 + s / 100).toFixed(3)})`);
      break;
    }
    case "colorbalance": {
      const cr = [p.shcr ?? 0, p.mdcr ?? 0, p.hicr ?? 0];
      const mg = [p.shmg ?? 0, p.mdmg ?? 0, p.himg ?? 0];
      const yb = [p.shyb ?? 0, p.mdyb ?? 0, p.hiyb ?? 0];
      if (cr.some(Boolean) || mg.some(Boolean) || yb.some(Boolean)) {
        // 与 GIMP 的色彩平衡同构：主通道加上去，另外两个通道各减一半
        const K = 0.4 / 100;
        const shift = (v: readonly number[], x: number) => {
          const [ws, wm, wh] = balanceWeights(x);
          return v[0] * ws + v[1] * wm + v[2] * wh;
        };
        const table = (own: readonly number[], otherA: readonly number[], otherB: readonly number[]) =>
          tableOf((x) => x + K * (shift(own, x) - 0.5 * shift(otherA, x) - 0.5 * shift(otherB, x)));
        parts.push(
          register(
            layerId,
            rgbTransfer(table(cr, mg, yb), table(mg, cr, yb), table(yb, cr, mg)),
          ),
        );
      }
      break;
    }
    case "bw": {
      const a = p.amount ?? 0;
      if (a) parts.push(`grayscale(${(a / 100).toFixed(3)})`);
      break;
    }
    case "gradientmap": {
      const stops = state.stops;
      if (stops && stops.length >= 2 && !isIdentityStops(stops)) {
        const ch = (i: number) => tableOf((x) => sampleStops(stops, x)[i]);
        parts.push(
          register(
            layerId,
            lumaMatrixMarkup("luma") + rgbTransfer(ch(0), ch(1), ch(2), "luma"),
          ),
        );
      }
      break;
    }
    case "channelmixer": {
      const k = (id: string, d: number) => (p[id] ?? d) / 100;
      const rows = [
        k("rr", 100), k("rg", 0), k("rb", 0), 0, k("rc", 0),
        k("gr", 0), k("gg", 100), k("gb", 0), 0, k("gc", 0),
        k("br", 0), k("bg", 0), k("bb", 100), 0, k("bc", 0),
        0, 0, 0, 1, 0,
      ];
      if (rows.some((v, i) => Math.abs(v - MIXER_IDENTITY[i]) > 1e-6)) {
        parts.push(register(layerId, colorMatrixMarkup(rows)));
      }
      break;
    }
    case "invert": {
      const a = p.amount ?? 0;
      if (a) parts.push(`invert(${(a / 100).toFixed(3)})`);
      break;
    }
    case "colortemp": {
      const t = (p.temp ?? 0) / 100;
      const ti = (p.tint ?? 0) / 100;
      if (t || ti) {
        // 暖：抬红压蓝；冷：反过来。色调轴走绿—洋红，与 PS 的「色温 / 色调」一致。
        const gr = 1 + 0.32 * t + 0.14 * ti;
        const gg = 1 - 0.2 * ti;
        const gb = 1 - 0.32 * t + 0.14 * ti;
        parts.push(
          register(
            layerId,
            rgbTransfer(
              tableOf((x) => clamp01(x * gr)),
              tableOf((x) => clamp01(x * gg)),
              tableOf((x) => clamp01(x * gb)),
            ),
          ),
        );
      }
      break;
    }
    case "photofilter": {
      const a = (p.strength ?? 0) / 100;
      if (a > 0) {
        const [fr, fg, fb] = hueRgb01((p.hue ?? 40) / 360);
        // 以 0.5 为不动点求各通道增益：滤镜色越浓，增益偏得越多。
        let gr = 1 + a * (2 * fr - 1);
        let gg = 1 + a * (2 * fg - 1);
        let gb = 1 + a * (2 * fb - 1);
        // 保留明度：把三通道增益按 Rec.709 亮度归一到 1，浓度只改色、不改亮。
        const keep = (p.preserve ?? 100) / 100;
        if (keep > 0) {
          const scale = 1 + keep * (luma01(gr, gg, gb) - 1);
          if (scale > 1e-6) {
            gr /= scale;
            gg /= scale;
            gb /= scale;
          }
        }
        parts.push(
          register(
            layerId,
            rgbTransfer(
              tableOf((x) => clamp01(x * gr)),
              tableOf((x) => clamp01(x * gg)),
              tableOf((x) => clamp01(x * gb)),
            ),
          ),
        );
      }
      break;
    }

    /* ---------------------------------------------------------- 效果 */
    case "blur": {
      const r = p.radius ?? 0;
      if (r > 0) parts.push(`blur(${r}px)`);
      break;
    }
    case "motionblur": {
      const d = p.distance ?? 0;
      if (d > 0) parts.push(register(layerId, motionMarkup(p.angle ?? 0, d)));
      break;
    }
    case "sharpen": {
      const k = (p.amount ?? 0) / 100;
      if (k > 0) {
        // 中心 1+4k、四邻 −k，核和恒为 1，锐化不会顺手把亮度抬起来
        parts.push(
          register(layerId, convolveMarkup([0, -k, 0, -k, 1 + 4 * k, -k, 0, -k, 0])),
        );
      }
      break;
    }
    case "grain": {
      const amount = (p.amount ?? 0) / 100;
      if (amount > 0) {
        parts.push(
          register(
            layerId,
            noiseMarkup({
              size: p.size ?? 3,
              amount,
              mono: true,
              mode: "soft-light",
              sharp: false,
              seed: 11,
            }),
          ),
        );
      }
      break;
    }
    case "noise": {
      const amount = (p.amount ?? 0) / 100;
      if (amount > 0) {
        parts.push(
          register(
            layerId,
            noiseMarkup({
              size: p.size ?? 1,
              amount,
              mono: false,
              mode: "overlay",
              sharp: true,
              seed: 5,
            }),
          ),
        );
      }
      break;
    }
  }
  return parts.join(" ");
}

/* ---------------------------------------------------------------- 图层样式 */

/**
 * 图层样式的种类。
 *
 * 只做 Canvas2D 能真实渲染出来的六种，不做假条目。渲染顺序与 PS 一致：
 * 投影 / 外发光画在图层像素之下，内阴影 / 内发光 / 颜色叠加 / 描边盖在其上。
 */
export type StyleId =
  | "dropshadow"
  | "innershadow"
  | "outerglow"
  | "innerglow"
  | "stroke"
  | "coloroverlay";

/** 一种样式的可调范围与默认值。 */
export interface StyleDef {
  id: StyleId;
  label: string;
  /** 是否可调大小 */
  size: boolean;
  sizeLabel: string;
  sizeMax: number;
  /** 是否可调方向（角度 + 距离） */
  offset: boolean;
  /** 是否可调描边位置（外 / 内 / 居中） */
  position: boolean;
  color: string;
  size0: number;
  opacity0: number;
  distance0: number;
  angle0: number;
  blend0: BlendId;
}

/** 样式清单（顺序 = 样式面板里的显示顺序）。 */
export const STYLE_DEFS: readonly StyleDef[] = [
  {
    id: "dropshadow",
    label: "投影",
    size: true,
    sizeLabel: "大小",
    sizeMax: 120,
    offset: true,
    position: false,
    color: "#000000",
    size0: 12,
    opacity0: 65,
    distance0: 8,
    angle0: 135,
    blend0: "multiply",
  },
  {
    id: "innershadow",
    label: "内阴影",
    size: true,
    sizeLabel: "大小",
    sizeMax: 120,
    offset: true,
    position: false,
    color: "#000000",
    size0: 10,
    opacity0: 60,
    distance0: 6,
    angle0: 135,
    blend0: "multiply",
  },
  {
    id: "outerglow",
    label: "外发光",
    size: true,
    sizeLabel: "大小",
    sizeMax: 160,
    offset: false,
    position: false,
    color: "#ffd479",
    size0: 16,
    opacity0: 70,
    distance0: 0,
    angle0: 0,
    blend0: "screen",
  },
  {
    id: "innerglow",
    label: "内发光",
    size: true,
    sizeLabel: "大小",
    sizeMax: 160,
    offset: false,
    position: false,
    color: "#ffffff",
    size0: 12,
    opacity0: 70,
    distance0: 0,
    angle0: 0,
    blend0: "screen",
  },
  {
    id: "stroke",
    label: "描边",
    size: true,
    sizeLabel: "粗细",
    sizeMax: 80,
    offset: false,
    position: true,
    color: "#0f76d6",
    size0: 3,
    opacity0: 100,
    distance0: 0,
    angle0: 0,
    blend0: "normal",
  },
  {
    id: "coloroverlay",
    label: "颜色叠加",
    size: false,
    sizeLabel: "",
    sizeMax: 0,
    offset: false,
    position: false,
    color: "#6fc0ff",
    size0: 0,
    opacity0: 100,
    distance0: 0,
    angle0: 0,
    blend0: "normal",
  },
];

/** 描边位置：外 / 内 / 居中。 */
export const STROKE_POSITIONS = ["外", "内", "居中"] as const;

/** 一条图层样式。 */
export interface LayerStyle {
  id: StyleId;
  enabled: boolean;
  /** #rrggbb */
  color: string;
  /** 0–100 */
  opacity: number;
  /** 描边粗细 / 阴影与发光的模糊大小（px） */
  size: number;
  /** 投影与内阴影的偏移距离（px） */
  distance: number;
  /** 偏移方向（度，PS 习惯：120° 约等于右上） */
  angle: number;
  /** 0–100 */
  spread: number;
  blend: BlendId;
  /** 描边位置下标，见 STROKE_POSITIONS */
  position: number;
}

export function styleDef(id: StyleId): StyleDef {
  return STYLE_DEFS.find((d) => d.id === id) ?? STYLE_DEFS[0];
}

/** 按定义生成一条默认样式。 */
export function newLayerStyle(id: StyleId): LayerStyle {
  const d = styleDef(id);
  return {
    id,
    enabled: true,
    color: d.color,
    opacity: d.opacity0,
    size: d.size0,
    distance: d.distance0,
    angle: d.angle0,
    spread: 0,
    blend: d.blend0,
    position: 0,
  };
}

export function cloneStyle(s: LayerStyle): LayerStyle {
  return { ...s };
}

/**
 * 图层种类。
 *
 * - pixel  自己带像素；
 * - adjust 不带像素，把「它下方已经合成出来的结果」整体过一遍滤镜；
 * - group  不带像素，把「它的一组子层」先合成成一张中间结果，再把这张
 *          中间结果当作自己的像素来画 —— 于是组的混合模式、不透明度、
 *          蒙版、图层样式全部零成本复用，渲染管线一行都不用改。
 */
export type LayerKind = "pixel" | "adjust" | "group";

/** 一个图层。 */
export interface StrataLayer {
  /** 图层唯一标识（进程内唯一） */
  id: string;
  /** 图层名，可重命名 */
  name: string;
  /** 是否可见 */
  visible: boolean;
  /** 不透明度 0–100（界面按 PS 习惯给整数百分比） */
  opacity: number;
  /** 混合模式 */
  blend: BlendId;
  /** 锁定后禁止绘制与变换 */
  locked: boolean;
  /** 像素层承载像素的离屏画布，尺寸恒等于文档尺寸；调整层不占像素 */
  surface: HTMLCanvasElement;
  /** 图层种类 */
  kind: LayerKind;
  /**
   * 所属图层组的 id（顶层图层为 undefined）。
   *
   * 图层栈仍然是一条扁平数组，父子关系只用这个指针表达：组内子层在
   * `doc.layers` 里**紧挨着排在组的下面**（下标连续）。这样既保住了
   * 「数组顺序 = 绘制顺序」这条合成器依赖的不变式，又不必引入递归结构 ——
   * 历史快照、序列化、撤销栈全都照旧走一次性深拷贝。
   */
  parent?: string | null;
  /** kind === "adjust" 时的参数 */
  adjust?: AdjustState;
  /**
   * 图层蒙版：一张只有 alpha 有用的画布，不透明处显示、透明处遮住。
   * 之所以用 alpha 而不是灰度，是为了能直接喂给 destination-in，
   * 一次绘制搞定，不必逐像素换算。未创建时为 null。
   */
  mask: HTMLCanvasElement | null;
  /** 蒙版是否参与合成（停用时按没有蒙版处理，便于对比效果） */
  maskActive: boolean;
  /**
   * 剪贴蒙版：开启后本层只在下层像素的不透明范围内显示。
   * 合成时按下层合成结果的 alpha 做 destination-in，等价于 PS 的「创建剪贴蒙版」。
   */
  clip?: boolean;
  /** 图层样式（投影 / 内阴影 / 外发光 / 内发光 / 描边 / 颜色叠加），未设置时视为空 */
  styles?: LayerStyle[];
}

let layerSeq = 0;

/** 生成一个进程内唯一的图层 id。 */
export function nextLayerId(): string {
  layerSeq += 1;
  return `layer-${Date.now().toString(36)}-${layerSeq}`;
}

/** 新建一个空（或指定底色）的像素图层。 */
export function createLayer(
  width: number,
  height: number,
  name: string,
  fill?: string,
): StrataLayer {
  return {
    id: nextLayerId(),
    name,
    visible: true,
    opacity: 100,
    blend: "normal",
    locked: false,
    surface: createSurface(width, height, fill),
    kind: "pixel",
    mask: null,
    maskActive: false,
    clip: false,
    styles: [],
  };
}

/**
 * 新建一张调整图层。
 *
 * 不占像素，因此不分配整幅画布（24MP 文档一张就是 96MB）；surface 只占位。
 */
export function createAdjustLayer(
  name: string,
  adjust: AdjustState,
): StrataLayer {
  return {
    id: nextLayerId(),
    name,
    visible: true,
    opacity: 100,
    blend: "normal",
    locked: false,
    surface: createSurface(1, 1),
    kind: "adjust",
    adjust,
    mask: null,
    maskActive: false,
    clip: false,
    styles: [],
  };
}

/**
 * 新建一个空的图层组。
 *
 * 组自己不带像素：合成时才把它的子层渲进一张缓冲画布，再把这张缓冲当作
 * 「组的像素」走一遍常规绘制 —— 于是组的混合模式、不透明度、蒙版与图层
 * 样式全部零成本生效，渲染管线一行都不用改。既然不占像素，surface 就只
 * 用 1×1 占位（与调整层同一套省内存策略，24MP 文档一张省 96MB）。
 */
export function createGroupLayer(name: string): StrataLayer {
  return {
    id: nextLayerId(),
    name,
    visible: true,
    opacity: 100,
    blend: "normal",
    locked: false,
    surface: createSurface(1, 1),
    kind: "group",
    parent: null,
    mask: null,
    maskActive: false,
    clip: false,
    styles: [],
  };
}

/**
 * 新建一张空蒙版（全部隐藏）。
 *
 * 蒙版按 alpha 存储：不透明处显示、透明处遮住。因此「全黑 = 看不见」就等价
 * 于整张透明，不必存灰度再换算，合成时一次 destination-in 即可。
 */
export function createMask(width: number, height: number): HTMLCanvasElement {
  return createSurface(width, height);
}

/** 由一张位图建图层（打开图片时用）。 */
export function layerFromBitmap(bitmap: ImageBitmap, name: string): StrataLayer {
  const layer = createLayer(bitmap.width, bitmap.height, name);
  mustCtx(layer.surface).drawImage(bitmap, 0, 0);
  return layer;
}

/** 深拷贝一个图层，用于「复制图层」与历史栈快照。 */
export function cloneLayer(layer: StrataLayer): StrataLayer {
  return {
    ...layer,
    id: nextLayerId(),
    surface: cloneSurface(layer.surface),
    mask: layer.mask ? cloneSurface(layer.mask) : null,
    adjust: layer.adjust ? cloneAdjust(layer.adjust) : undefined,
    styles: layer.styles?.map(cloneStyle),
  };
}

/** 保留原 id 深拷贝（历史栈回填时用，不能换 id，否则面板选中态会漂）。 */
export function dupLayer(layer: StrataLayer): StrataLayer {
  return {
    ...layer,
    surface: cloneSurface(layer.surface),
    mask: layer.mask ? cloneSurface(layer.mask) : null,
    adjust: layer.adjust ? cloneAdjust(layer.adjust) : undefined,
    styles: layer.styles?.map(cloneStyle),
  };
}
