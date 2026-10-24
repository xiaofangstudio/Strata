/**
 * 滤镜注册表（FilterDef）。
 *
 * 每个滤镜 = 一份参数表 + 一个纯像素内核（kernels.ts）。菜单、参数弹窗、
 * 实时预览、落盘应用全部读这份表，新增滤镜只改这里，不碰 UI 代码。
 *
 * 试点三件（高斯模糊 / USM 锐化 / 添加杂色）与第一批模糊、锐化、杂色、
 * 像素化滤镜都注册在此；内核算法 Ported from ArtCraft PhotoCraft
 * (crates/algo/src/{blur,sharpen,noise,pixelate}.rs)，MIT / Apache-2.0。
 */
import {
  addNoise,
  boxBlur,
  convolve3x3,
  crystallize,
  dustAndScratch,
  emboss,
  findEdges,
  fragment,
  gaussianBlur,
  grain,
  halftone,
  median,
  mezzotint,
  motionBlur,
  mosaic,
  oilPaint,
  patchwork,
  pinch,
  radialSpin,
  radialZoom,
  reduceNoise,
  ripple,
  sharpenKernel,
  solarize,
  surfaceBlur,
  twirl,
  unsharpMask,
  wave,
  watercolor,
  wind,
  type RgbaBuffer,
} from "./kernels";

/** 一个滤镜参数。与调整层的 AdjustParam 字段语义一致，弹窗直接复用样式。 */
export interface FilterParam {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  unit?: string;
  /** 显示保留的小数位，默认 0 */
  dec?: number;
  /** 离散选项（径向模糊的「旋转/缩放」等），有此项时弹窗渲染 <select> */
  choices?: readonly { label: string; value: number }[];
}

export type FilterGroup =
  | "blur"
  | "sharpen"
  | "noise"
  | "pixelate"
  | "distort"
  | "stylize"
  | "sketch"
  | "texture"
  | "artistic";

export interface FilterDef {
  /** 全局唯一 id，同时是菜单 id（filter.blur.gaussianBlur 等） */
  id: string;
  label: string;
  group: FilterGroup;
  params: FilterParam[];
  apply(src: RgbaBuffer, p: Record<string, number>): RgbaBuffer;
}

/** 按滤镜定义生成一份默认参数。 */
export function filterParams(def: FilterDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.id] = p.def;
  return out;
}

/** 按菜单 id 找滤镜定义。 */
export function filterDef(id: string): FilterDef | undefined {
  return FILTER_DEFS.find((d) => d.id === id);
}

/* ---------------------------------------------------------------- 模糊 */

const BLUR_DEFS: FilterDef[] = [
  {
    id: "filter.blur.gaussianBlur",
    label: "高斯模糊",
    group: "blur",
    params: [
      { id: "radius", label: "半径", min: 0.1, max: 250, step: 0.1, def: 4, dec: 1, unit: " 像素" },
    ],
    apply: (b, p) => gaussianBlur(b, p.radius),
  },
  {
    id: "filter.blur.blur",
    label: "模糊",
    group: "blur",
    params: [
      { id: "radius", label: "半径", min: 1, max: 100, step: 1, def: 3, unit: " 像素" },
    ],
    apply: (b, p) => boxBlur(b, p.radius),
  },
  {
    id: "filter.blur.boxBlur",
    label: "方框模糊",
    group: "blur",
    params: [
      { id: "radius", label: "半径", min: 1, max: 250, step: 1, def: 8, unit: " 像素" },
    ],
    apply: (b, p) => boxBlur(b, p.radius),
  },
  {
    id: "filter.blur.blurMore",
    label: "进一步模糊",
    group: "blur",
    params: [
      { id: "radius", label: "半径", min: 1, max: 100, step: 1, def: 6, unit: " 像素" },
    ],
    apply: (b, p) => boxBlur(boxBlur(b, p.radius), p.radius),
  },
  {
    id: "filter.blur.motionBlur",
    label: "动感模糊",
    group: "blur",
    params: [
      { id: "angle", label: "角度", min: -90, max: 90, step: 1, def: 0, unit: "°" },
      { id: "distance", label: "距离", min: 1, max: 999, step: 1, def: 20, unit: " 像素" },
    ],
    apply: (b, p) => motionBlur(b, p.angle, p.distance),
  },
  {
    id: "filter.blur.radialBlur",
    label: "径向模糊",
    group: "blur",
    params: [
      {
        id: "method",
        label: "方法",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "旋转", value: 0 },
          { label: "缩放", value: 1 },
        ],
      },
      { id: "amount", label: "数量", min: 1, max: 100, step: 1, def: 20, unit: "%" },
      { id: "quality", label: "品质（采样步数）", min: 2, max: 32, step: 1, def: 10 },
    ],
    apply: (b, p) =>
      p.method === 1
        ? radialZoom(b, p.amount, p.quality)
        : radialSpin(b, p.amount, p.quality),
  },
  {
    id: "filter.blur.surfaceBlur",
    label: "特殊模糊（表面）",
    group: "blur",
    params: [
      { id: "radius", label: "半径", min: 1, max: 100, step: 1, def: 5, unit: " 像素" },
      { id: "threshold", label: "阈值", min: 1, max: 255, step: 1, def: 24, unit: " 色阶" },
    ],
    apply: (b, p) => surfaceBlur(b, p.radius, p.threshold),
  },
];

/* ---------------------------------------------------------------- 锐化 */

const SHARPEN_DEFS: FilterDef[] = [
  {
    id: "filter.sharpen.sharpen",
    label: "锐化",
    group: "sharpen",
    params: [],
    apply: (b) => convolve3x3(b, sharpenKernel(1)),
  },
  {
    id: "filter.sharpen.sharpenMore",
    label: "进一步锐化",
    group: "sharpen",
    params: [],
    apply: (b) => convolve3x3(b, sharpenKernel(2)),
  },
  {
    id: "filter.sharpen.sharpenEdges",
    label: "锐化边缘",
    group: "sharpen",
    params: [
      { id: "strength", label: "强度", min: 1, max: 10, step: 1, def: 2 },
    ],
    apply: (b, p) => convolve3x3(b, sharpenKernel(p.strength)),
  },
  {
    id: "filter.sharpen.unsharpMask",
    label: "USM 锐化",
    group: "sharpen",
    params: [
      { id: "amount", label: "数量", min: 0, max: 500, step: 1, def: 100, unit: "%" },
      { id: "radius", label: "半径", min: 0.1, max: 100, step: 0.1, def: 2, dec: 1, unit: " 像素" },
      { id: "threshold", label: "阈值", min: 0, max: 255, step: 1, def: 3, unit: " 色阶" },
    ],
    apply: (b, p) => unsharpMask(b, p.radius, p.amount, p.threshold),
  },
  {
    id: "filter.sharpen.smartSharpen",
    label: "智能锐化",
    group: "sharpen",
    params: [
      { id: "amount", label: "数量", min: 0, max: 300, step: 1, def: 100, unit: "%" },
      { id: "radius", label: "半径", min: 0.1, max: 50, step: 0.1, def: 1.5, dec: 1, unit: " 像素" },
      { id: "threshold", label: "减少杂色（阈值）", min: 0, max: 100, step: 1, def: 12, unit: "%" },
    ],
    apply: (b, p) => {
      // 先轻降噪再 USM，即 PS「减少杂色」+ USM 的组合语义
      const denoised = reduceNoise(b, p.threshold * 0.5);
      return unsharpMask(denoised, p.radius, p.amount, 2);
    },
  },
];

/* ---------------------------------------------------------------- 杂色 */

const NOISE_DEFS: FilterDef[] = [
  {
    id: "filter.noise.addNoise",
    label: "添加杂色",
    group: "noise",
    params: [
      { id: "amount", label: "数量", min: 0, max: 100, step: 1, def: 5, unit: "%" },
      {
        id: "monochrome",
        label: "分布",
        min: 0,
        max: 1,
        step: 1,
        def: 1,
        choices: [
          { label: "彩色", value: 0 },
          { label: "单色", value: 1 },
        ],
      },
    ],
    apply: (b, p) => addNoise(b, p.amount, p.monochrome === 1),
  },
  {
    id: "filter.noise.despeckle",
    label: "去斑",
    group: "noise",
    params: [],
    apply: (b) => median(b, 1),
  },
  {
    id: "filter.noise.median",
    label: "中间值",
    group: "noise",
    params: [
      { id: "radius", label: "半径", min: 1, max: 16, step: 1, def: 2, unit: " 像素" },
    ],
    apply: (b, p) => median(b, p.radius),
  },
  {
    id: "filter.noise.dustAndScratches",
    label: "蒙尘与划痕",
    group: "noise",
    params: [
      { id: "radius", label: "半径", min: 1, max: 16, step: 1, def: 2, unit: " 像素" },
      { id: "threshold", label: "阈值", min: 0, max: 128, step: 1, def: 20, unit: " 色阶" },
    ],
    apply: (b, p) => dustAndScratch(b, p.radius, p.threshold),
  },
  {
    id: "filter.noise.reduceNoise",
    label: "减少杂色",
    group: "noise",
    params: [
      { id: "strength", label: "强度", min: 0, max: 100, step: 1, def: 50, unit: "%" },
    ],
    apply: (b, p) => reduceNoise(b, p.strength),
  },
];

/* ---------------------------------------------------------------- 像素化 */

const PIXELATE_DEFS: FilterDef[] = [
  {
    id: "filter.pixelate.mosaic",
    label: "彩块化",
    group: "pixelate",
    params: [
      { id: "size", label: "单元格大小", min: 2, max: 200, step: 1, def: 12, unit: " 像素" },
    ],
    apply: (b, p) => mosaic(b, p.size),
  },
  {
    id: "filter.pixelate.crystallize",
    label: "晶格化",
    group: "pixelate",
    params: [
      { id: "size", label: "单元格大小", min: 2, max: 200, step: 1, def: 16, unit: " 像素" },
    ],
    apply: (b, p) => crystallize(b, p.size),
  },
  {
    id: "filter.pixelate.fragment",
    label: "碎片",
    group: "pixelate",
    params: [
      { id: "offset", label: "偏移", min: 1, max: 20, step: 1, def: 4, unit: " 像素" },
    ],
    apply: (b, p) => fragment(b, p.offset),
  },
  {
    id: "filter.pixelate.mezzotint",
    label: "铜版雕刻",
    group: "pixelate",
    params: [
      { id: "density", label: "密度", min: 1, max: 100, step: 1, def: 25, unit: "%" },
    ],
    apply: (b, p) => mezzotint(b, p.density),
  },
];

/* ---------------------------------------------------------------- 扭曲 */

const DISTORT_DEFS: FilterDef[] = [
  {
    id: "filter.distort.twirl",
    label: "旋转扭曲",
    group: "distort",
    params: [
      { id: "angle", label: "角度", min: -999, max: 999, step: 1, def: 180, unit: "°" },
      { id: "radius", label: "半径", min: 1, max: 100, step: 1, def: 100, unit: "%" },
    ],
    apply: (b, p) => twirl(b, p.angle, p.radius),
  },
  {
    id: "filter.distort.wave",
    label: "波浪",
    group: "distort",
    params: [
      { id: "amplitude", label: "波幅", min: 0, max: 100, step: 1, def: 8, unit: " 像素" },
      { id: "wavelength", label: "波长", min: 2, max: 400, step: 1, def: 60, unit: " 像素" },
    ],
    apply: (b, p) => wave(b, p.amplitude, p.wavelength),
  },
  {
    id: "filter.distort.ripple",
    label: "波纹",
    group: "distort",
    params: [
      { id: "amount", label: "数量", min: 0, max: 200, step: 1, def: 40, unit: "%" },
      { id: "size", label: "波纹间距", min: 2, max: 400, step: 1, def: 48, unit: " 像素" },
    ],
    apply: (b, p) => ripple(b, p.amount, p.size),
  },
  {
    id: "filter.distort.pinch",
    label: "挤压",
    group: "distort",
    params: [
      { id: "amount", label: "数量", min: -100, max: 100, step: 1, def: 50, unit: "%" },
    ],
    apply: (b, p) => pinch(b, p.amount),
  },
  {
    id: "filter.distort.spherize",
    label: "球面化",
    group: "distort",
    params: [
      { id: "amount", label: "数量", min: -100, max: 100, step: 1, def: -50, unit: "%" },
    ],
    apply: (b, p) => pinch(b, p.amount),
  },
];

/* ---------------------------------------------------------------- 风格化 */

const STYLIZE_DEFS: FilterDef[] = [
  {
    id: "filter.stylize.findEdges",
    label: "查找边缘",
    group: "stylize",
    params: [],
    apply: (b) => findEdges(b),
  },
  {
    id: "filter.stylize.emboss",
    label: "浮雕效果",
    group: "stylize",
    params: [
      { id: "angle", label: "角度", min: -180, max: 180, step: 1, def: 135, unit: "°" },
      { id: "height", label: "高度", min: 1, max: 20, step: 1, def: 3, unit: " 像素" },
      { id: "amount", label: "数量", min: 1, max: 300, step: 1, def: 100, unit: "%" },
    ],
    apply: (b, p) => emboss(b, p.angle, p.height, p.amount),
  },
  {
    id: "filter.stylize.solarize",
    label: "曝光过度",
    group: "stylize",
    params: [],
    apply: (b) => solarize(b),
  },
  {
    id: "filter.stylize.wind",
    label: "风",
    group: "stylize",
    params: [
      { id: "strength", label: "强度", min: 1, max: 80, step: 1, def: 20, unit: " 像素" },
    ],
    apply: (b, p) => wind(b, p.strength),
  },
  {
    id: "filter.stylize.oilPaint",
    label: "油画",
    group: "stylize",
    params: [
      { id: "radius", label: "笔触半径", min: 1, max: 6, step: 1, def: 3, unit: " 像素" },
    ],
    apply: (b, p) => oilPaint(b, p.radius),
  },
];

/* ---------------------------------------------------------------- 素描 */

const SKETCH_DEFS: FilterDef[] = [
  {
    id: "filter.sketch.halftone",
    label: "半调图案",
    group: "sketch",
    params: [
      { id: "size", label: "单元格大小", min: 2, max: 64, step: 1, def: 8, unit: " 像素" },
    ],
    apply: (b, p) => halftone(b, p.size),
  },
];

/* ---------------------------------------------------------------- 纹理 */

const TEXTURE_DEFS: FilterDef[] = [
  {
    id: "filter.texture.grain",
    label: "颗粒",
    group: "texture",
    params: [
      { id: "amount", label: "强度", min: 1, max: 100, step: 1, def: 12, unit: "%" },
    ],
    apply: (b, p) => grain(b, p.amount),
  },
  {
    id: "filter.texture.patchwork",
    label: "拼缀图",
    group: "texture",
    params: [
      { id: "size", label: "方块大小", min: 2, max: 100, step: 1, def: 12, unit: " 像素" },
    ],
    apply: (b, p) => patchwork(b, p.size),
  },
];

/* ---------------------------------------------------------------- 艺术效果 */

const ARTISTIC_DEFS: FilterDef[] = [
  {
    id: "filter.artistic.watercolor",
    label: "水彩",
    group: "artistic",
    params: [
      { id: "smoothing", label: "画笔细节", min: 1, max: 6, step: 1, def: 2, unit: " 像素" },
    ],
    apply: (b, p) => watercolor(b, p.smoothing),
  },
];

/** 全部已注册滤镜（试点 3 件 + 第一批 + 二三批）。 */
export const FILTER_DEFS: readonly FilterDef[] = [
  ...BLUR_DEFS,
  ...SHARPEN_DEFS,
  ...NOISE_DEFS,
  ...PIXELATE_DEFS,
  ...DISTORT_DEFS,
  ...STYLIZE_DEFS,
  ...SKETCH_DEFS,
  ...TEXTURE_DEFS,
  ...ARTISTIC_DEFS,
];
