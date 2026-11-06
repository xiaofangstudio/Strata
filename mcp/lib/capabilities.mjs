/**
 * Strata 真实能力清单。
 *
 * 本文件是 MCP 侧对 Strata 编辑能力的「单一事实来源」，数值与中文名严格抄自
 * 仓库内既有实现，不新增条目、不编造：
 *   · 混合模式 / 调整类型 / 图层样式 —— src/core/layer.ts
 *   · 工具目录（id / 快捷键 / 分组）—— src/tools/catalog.ts
 *   · 工具与分组中文名、选区模式、菜单文案 —— src/i18n/zh-CN.ts
 *   · 画布尺寸边界与预设 —— src/core/presets.ts
 *   · 导出与可导入格式 —— src/engine/image.ts
 *   · .strata 工程格式 —— src/engine/project.ts
 * 改动以上任一文件后，这里必须同步。
 */

import {
  FILTER_DEFS,
  GRADE_PARAMS,
  GRADE_WHEELS,
  PROFILE_LABELS,
  SLICER_RANGES,
} from "./engines.gen.mjs";
import { ADJUSTERS } from "./imageOps.mjs";

/** 调色台参数键：直接从内核的 GRADE_PARAMS 派生，不手抄。 */
const GRADE_PARAM_SPEC = GRADE_PARAMS.map((d) => ({
  id: d.id,
  label: d.label,
  min: d.min,
  max: d.max,
  def: d.def,
  group: d.group,
}));

/**
 * 滤镜目录直接从引擎包派生 —— 与界面共用同一份 FILTER_DEFS，
 * 所以界面上新加一个滤镜，MCP 这边不需要手抄任何清单。
 */
export const FILTERS = FILTER_DEFS.map((d) => ({
  id: d.id,
  label: d.label,
  group: d.group,
  params: d.params.map((p) => ({
    id: p.id,
    label: p.label,
    min: p.min,
    max: p.max,
    def: p.def,
    unit: p.unit ?? "",
    choices: p.choices ? p.choices.map((c) => c.label) : undefined,
  })),
}));

/** 颜色模式（src/core/colorMode.ts）。 */
export const COLOR_MODES = [
  { id: "bitmap", label: "位图", note: "阈值二值，可选半调网点" },
  { id: "duotone", label: "双色调", note: "深色墨 → 浅色墨的双色渐变" },
  { id: "indexed", label: "索引颜色", note: "中位切分量化 + 可选抖动，返回调色板" },
  { id: "cmyk", label: "CMYK", note: "真实 RGB→CMYK→RGB，含油墨总量与 UCR" },
  { id: "lab", label: "Lab", note: "sRGB↔XYZ(D65)↔Lab，可限彩度" },
  { id: "multichannel", label: "多通道", note: "灰度化并分别导出 R/G/B 通道" },
];

/** 智能选区判定方式（src/core/smartSelect.ts）。 */
export const SMART_SELECTS = [
  { id: "colorRange", label: "色彩范围", params: ["color", "tolerance"] },
  { id: "subject", label: "选取主体", params: [] },
  { id: "sky", label: "选取天空", params: [] },
  { id: "focus", label: "焦点区域", params: ["threshold"] },
];

/** 色彩配置（src/core/colorProfile.ts）。 */
export const COLOR_PROFILES = Object.entries(PROFILE_LABELS).map(([id, label]) => ({ id, label }));

/** MCP 协议版本（本服务器声明支持）。 */
export const PROTOCOL_VERSION = "2024-11-05";

/** ServerInfo 名称与版本。 */
export const SERVER_NAME = "strata";
export const SERVER_VERSION = "2.6.2";

/* ------------------------------------------------ .strata 工程格式常量 */

/** 工程文件魔数（src/engine/project.ts）。 */
export const MAGIC = "STRATA-PROJECT";
/** 当前工程格式版本（v5：Alpha 通道；v4：图层组；v3：文档选区）。 */
export const PROJECT_VERSION = 5;
/** 工程文件扩展名（小写，不含点）。 */
export const PROJECT_EXTENSION = "strata";

/* ------------------------------------------------ 画布尺寸边界（presets.ts） */

export const CANVAS_LIMITS = {
  minSide: 1,
  maxSide: 16384,
  minDpi: 1,
  maxDpi: 2400,
  defaultDpi: 72,
};

/** 常用画布预设（presets.ts: PRESETS）。 */
export const CANVAS_PRESETS = [
  { key: "fhd", label: "全高清", w: 1920, h: 1080 },
  { key: "square", label: "方形", w: 1080, h: 1080 },
  { key: "portrait", label: "竖版", w: 1080, h: 1920 },
  { key: "uhd", label: "4K", w: 3840, h: 2160 },
  { key: "a4", label: "A4 印刷", w: 2480, h: 3508, dpi: 300 },
];

/* ------------------------------------------------ 混合模式（layer.ts: BLEND_MODES） */

export const BLEND_MODES = [
  { id: "normal", label: "正常", op: "source-over" },
  { id: "dissolve", label: "溶解", op: "source-over", soft: true },
  { id: "darken", label: "变暗", op: "darken" },
  { id: "multiply", label: "正片叠底", op: "multiply" },
  { id: "color-burn", label: "颜色加深", op: "color-burn" },
  { id: "linear-burn", label: "线性加深", op: "source-over", soft: true },
  { id: "darker-color", label: "深色", op: "source-over", soft: true },
  { id: "lighten", label: "变亮", op: "lighten" },
  { id: "screen", label: "滤色", op: "screen" },
  { id: "color-dodge", label: "颜色减淡", op: "color-dodge" },
  { id: "linear-dodge", label: "线性减淡", op: "source-over", soft: true },
  { id: "lighter-color", label: "浅色", op: "source-over", soft: true },
  { id: "overlay", label: "叠加", op: "overlay" },
  { id: "soft-light", label: "柔光", op: "soft-light" },
  { id: "hard-light", label: "强光", op: "hard-light" },
  { id: "vivid-light", label: "亮光", op: "source-over", soft: true },
  { id: "linear-light", label: "线性光", op: "source-over", soft: true },
  { id: "pin-light", label: "点光", op: "source-over", soft: true },
  { id: "hard-mix", label: "实色混合", op: "source-over", soft: true },
  { id: "difference", label: "差值", op: "difference" },
  { id: "exclusion", label: "排除", op: "exclusion" },
  { id: "subtract", label: "减去", op: "source-over", soft: true },
  { id: "divide", label: "划分", op: "source-over", soft: true },
  { id: "hue", label: "色相", op: "hue" },
  { id: "saturation", label: "饱和度", op: "saturation" },
  { id: "color", label: "颜色", op: "color" },
  { id: "luminosity", label: "明度", op: "luminosity" },
];

export const BLEND_IDS = BLEND_MODES.map((b) => b.id);

/* ------------------------------------------------ 调整类型（layer.ts: ADJUST_DEFS） */

/** 调整类型族别 → 中文（i18n.zh.layers.adjustFamily*）。 */
export const ADJUST_FAMILIES = {
  tone: "明暗",
  color: "色彩",
  effect: "效果",
};

/**
 * 调整类型定义清单。
 * 每个参数含：id / label / min / max / step / def（新建时的中性值）/ unit / dec / group。
 * curves 与 gradientmap 无标量参数，改用 curve / stops 结构（见 DEFAULT_* ）。
 */
export const ADJUST_DEFS = [
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
  {
    id: "huesat",
    label: "色相 / 饱和度（全功能）",
    family: "color",
    params: [
      { id: "hue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°", group: "全图" },
      { id: "saturate", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "全图" },
      { id: "lightness", label: "明度", min: -100, max: 100, step: 1, def: 0, group: "全图" },
      { id: "colorize", label: "着色", min: 0, max: 1, step: 1, def: 0, group: "全图" },
      { id: "redHue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°", group: "红色" },
      { id: "redSat", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "红色" },
      { id: "redLight", label: "明度", min: -100, max: 100, step: 1, def: 0, group: "红色" },
      { id: "yellowHue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°", group: "黄色" },
      { id: "yellowSat", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "黄色" },
      { id: "yellowLight", label: "明度", min: -100, max: 100, step: 1, def: 0, group: "黄色" },
      { id: "greenHue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°", group: "绿色" },
      { id: "greenSat", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "绿色" },
      { id: "greenLight", label: "明度", min: -100, max: 100, step: 1, def: 0, group: "绿色" },
      { id: "cyanHue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°", group: "青色" },
      { id: "cyanSat", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "青色" },
      { id: "cyanLight", label: "明度", min: -100, max: 100, step: 1, def: 0, group: "青色" },
      { id: "blueHue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°", group: "蓝色" },
      { id: "blueSat", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "蓝色" },
      { id: "blueLight", label: "明度", min: -100, max: 100, step: 1, def: 0, group: "蓝色" },
      { id: "magentaHue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°", group: "洋红" },
      { id: "magentaSat", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "洋红" },
      { id: "magentaLight", label: "明度", min: -100, max: 100, step: 1, def: 0, group: "洋红" },
    ],
  },
  {
    id: "blackwhite",
    label: "黑白（通道权重）",
    family: "color",
    params: [
      { id: "red", label: "红色", min: 0, max: 100, step: 1, def: 40, unit: "%", group: "通道权重" },
      { id: "yellow", label: "黄色", min: 0, max: 100, step: 1, def: 60, unit: "%", group: "通道权重" },
      { id: "green", label: "绿色", min: 0, max: 100, step: 1, def: 40, unit: "%", group: "通道权重" },
      { id: "cyan", label: "青色", min: 0, max: 100, step: 1, def: 60, unit: "%", group: "通道权重" },
      { id: "blue", label: "蓝色", min: 0, max: 100, step: 1, def: 20, unit: "%", group: "通道权重" },
      { id: "magenta", label: "洋红", min: 0, max: 100, step: 1, def: 80, unit: "%", group: "通道权重" },
    ],
  },
  {
    id: "vibrance",
    label: "自然饱和度",
    family: "color",
    params: [
      { id: "vibrance", label: "自然饱和度", min: -100, max: 100, step: 1, def: 0 },
      { id: "saturation", label: "饱和度", min: -100, max: 100, step: 1, def: 0 },
    ],
  },
  {
    id: "selectivecolor",
    label: "可选颜色",
    family: "color",
    params: [
      { id: "mode", label: "方法", min: 0, max: 1, step: 1, def: 0, group: "模式" },
      { id: "redsC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "红色" },
      { id: "redsM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "红色" },
      { id: "redsY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "红色" },
      { id: "redsK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "红色" },
      { id: "yellowsC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "黄色" },
      { id: "yellowsM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "黄色" },
      { id: "yellowsY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "黄色" },
      { id: "yellowsK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "黄色" },
      { id: "greensC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "绿色" },
      { id: "greensM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "绿色" },
      { id: "greensY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "绿色" },
      { id: "greensK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "绿色" },
      { id: "cyansC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "青色" },
      { id: "cyansM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "青色" },
      { id: "cyansY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "青色" },
      { id: "cyansK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "青色" },
      { id: "bluesC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "蓝色" },
      { id: "bluesM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "蓝色" },
      { id: "bluesY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "蓝色" },
      { id: "bluesK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "蓝色" },
      { id: "magentasC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "洋红" },
      { id: "magentasM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "洋红" },
      { id: "magentasY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "洋红" },
      { id: "magentasK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "洋红" },
      { id: "whitesC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "白色" },
      { id: "whitesM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "白色" },
      { id: "whitesY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "白色" },
      { id: "whitesK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "白色" },
      { id: "neutralsC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "中性色" },
      { id: "neutralsM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "中性色" },
      { id: "neutralsY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "中性色" },
      { id: "neutralsK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "中性色" },
      { id: "blacksC", label: "青色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "黑色" },
      { id: "blacksM", label: "洋红", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "黑色" },
      { id: "blacksY", label: "黄色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "黑色" },
      { id: "blacksK", label: "黑色", min: -100, max: 100, step: 1, def: 0, unit: "%", group: "黑色" },
    ],
  },
  {
    id: "colorlookup",
    label: "颜色查找",
    family: "color",
    params: [
      {
        id: "preset",
        label: "预设",
        min: 0,
        max: 9,
        step: 1,
        def: 0,
        choices: [
          { label: "暖阳", value: 0 },
          { label: "冷冽", value: 1 },
          { label: "胶片", value: 2 },
          { label: "青橙", value: 3 },
          { label: "复古", value: 4 },
          { label: "墨色", value: 5 },
          { label: "薄荷", value: 6 },
          { label: "夜幕", value: 7 },
          { label: "粉彩", value: 8 },
          { label: "高反差", value: 9 },
        ],
      },
      { id: "intensity", label: "强度", min: 0, max: 100, step: 1, def: 100, unit: "%" },
    ],
  },
  {
    id: "equalize",
    label: "均衡",
    family: "tone",
    params: [],
  },
  {
    id: "hdtoning",
    label: "HDR 色调",
    family: "tone",
    params: [
      { id: "radius", label: "半径", min: 1, max: 150, step: 1, def: 40, unit: "px" },
      { id: "strength", label: "强度", min: 0, max: 100, step: 1, def: 30, unit: "%" },
      { id: "detail", label: "细节", min: 0, max: 300, step: 1, def: 80, unit: "%" },
      { id: "gamma", label: "灰度系数", min: 0.5, max: 2, step: 0.01, def: 1, dec: 2 },
      { id: "exposure", label: "曝光", min: -3, max: 3, step: 0.01, def: 0, dec: 2, unit: " EV" },
    ],
  },
  {
    id: "matchcolor",
    label: "匹配颜色",
    family: "color",
    params: [
      { id: "luminance", label: "明亮度", min: 0, max: 200, step: 1, def: 100, unit: "%" },
      { id: "intensity", label: "颜色强度", min: 0, max: 200, step: 1, def: 100, unit: "%" },
      { id: "fade", label: "渐隐", min: 0, max: 100, step: 1, def: 0, unit: "%" },
      { id: "neutralize", label: "中和", min: 0, max: 1, step: 1, def: 0 },
    ],
  },
  {
    id: "replacecolor",
    label: "替换颜色",
    family: "color",
    params: [
      { id: "targetHue", label: "目标色相", min: 0, max: 360, step: 1, def: 0, unit: "°", group: "选区" },
      { id: "fuzziness", label: "颜色容差", min: 0, max: 100, step: 1, def: 40, unit: "%", group: "选区" },
      { id: "hue", label: "色相", min: -180, max: 180, step: 1, def: 0, unit: "°", group: "替换" },
      { id: "saturation", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "替换" },
      { id: "lightness", label: "明度", min: -100, max: 100, step: 1, def: 0, group: "替换" },
    ],
  },
  {
    id: "cameraraw",
    label: "Camera Raw",
    family: "effect",
    params: [
      { id: "temperature", label: "色温", min: -100, max: 100, step: 1, def: 0, group: "白平衡" },
      { id: "tint", label: "色调", min: -100, max: 100, step: 1, def: 0, group: "白平衡" },
      { id: "exposure", label: "曝光", min: -5, max: 5, step: 0.01, def: 0, dec: 2, unit: " EV", group: "影调" },
      { id: "contrast", label: "对比度", min: -100, max: 100, step: 1, def: 0, group: "影调" },
      { id: "highlights", label: "高光", min: -100, max: 100, step: 1, def: 0, group: "影调" },
      { id: "shadows", label: "阴影", min: -100, max: 100, step: 1, def: 0, group: "影调" },
      { id: "whites", label: "白色", min: -100, max: 100, step: 1, def: 0, group: "影调" },
      { id: "blacks", label: "黑色", min: -100, max: 100, step: 1, def: 0, group: "影调" },
      { id: "texture", label: "纹理", min: -100, max: 100, step: 1, def: 0, group: "细节" },
      { id: "clarity", label: "清晰度", min: -100, max: 100, step: 1, def: 0, group: "细节" },
      { id: "dehaze", label: "去薄雾", min: -100, max: 100, step: 1, def: 0, group: "细节" },
      { id: "vibrance", label: "自然饱和度", min: -100, max: 100, step: 1, def: 0, group: "色彩" },
      { id: "saturation", label: "饱和度", min: -100, max: 100, step: 1, def: 0, group: "色彩" },
    ],
  },
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
  {
    /**
     * 调色台（layer.ts 同款）：参数直接从 GRADE_PARAMS 派生，不手抄。
     */
    id: "grade",
    label: "调色台",
    family: "color",
    params: GRADE_PARAMS.map((g) => ({
      id: g.id,
      label: g.label,
      min: g.min,
      max: g.max,
      step: g.step,
      def: g.def,
      dec: g.dec,
      unit: g.unit,
      group: g.group,
    })),
  },
];

export const ADJUST_IDS = ADJUST_DEFS.map((d) => d.id);

/** 曲线默认控制点（layer.ts: DEFAULT_CURVE）—— 对角线 = 不改动。 */
export const DEFAULT_CURVE = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** 渐变映射默认色标（layer.ts: DEFAULT_STOPS）—— 黑 → 白 = 不改动。 */
export const DEFAULT_STOPS = [
  { at: 0, color: "#000000" },
  { at: 1, color: "#ffffff" },
];

/* ------------------------------------------------ 图层样式（layer.ts: STYLE_DEFS） */

export const STYLE_DEFS = [
  { id: "dropshadow", label: "投影", size: true, sizeLabel: "大小", sizeMax: 120, offset: true, position: false, color: "#000000", size0: 12, opacity0: 65, distance0: 8, angle0: 135, blend0: "multiply" },
  { id: "innershadow", label: "内阴影", size: true, sizeLabel: "大小", sizeMax: 120, offset: true, position: false, color: "#000000", size0: 10, opacity0: 60, distance0: 6, angle0: 135, blend0: "multiply" },
  { id: "outerglow", label: "外发光", size: true, sizeLabel: "大小", sizeMax: 160, offset: false, position: false, color: "#ffd479", size0: 16, opacity0: 70, distance0: 0, angle0: 0, blend0: "screen" },
  { id: "innerglow", label: "内发光", size: true, sizeLabel: "大小", sizeMax: 160, offset: false, position: false, color: "#ffffff", size0: 12, opacity0: 70, distance0: 0, angle0: 0, blend0: "screen" },
  { id: "stroke", label: "描边", size: true, sizeLabel: "粗细", sizeMax: 80, offset: false, position: true, color: "#0f76d6", size0: 3, opacity0: 100, distance0: 0, angle0: 0, blend0: "normal" },
  { id: "coloroverlay", label: "颜色叠加", size: false, sizeLabel: "", sizeMax: 0, offset: false, position: false, color: "#6fc0ff", size0: 0, opacity0: 100, distance0: 0, angle0: 0, blend0: "normal" },
  { id: "bevelemboss", label: "斜面和浮雕", size: true, sizeLabel: "大小", sizeMax: 60, offset: true, position: false, color: "#000000", size0: 8, opacity0: 60, distance0: 4, angle0: 135, blend0: "normal" },
  { id: "satin", label: "缎纹", size: true, sizeLabel: "大小", sizeMax: 120, offset: true, position: false, color: "#000000", size0: 12, opacity0: 35, distance0: 12, angle0: 135, blend0: "multiply" },
  { id: "gradientoverlay", label: "渐变叠加", size: false, sizeLabel: "", sizeMax: 0, offset: false, position: false, color: "#ffffff", size0: 0, opacity0: 70, distance0: 0, angle0: 90, blend0: "normal" },
  { id: "patternoverlay", label: "图案叠加", size: true, sizeLabel: "图案大小", sizeMax: 64, offset: false, position: false, color: "#000000", size0: 12, opacity0: 60, distance0: 0, angle0: 0, blend0: "normal" },
];

export const STYLE_IDS = STYLE_DEFS.map((s) => s.id);

/** 描边位置（layer.ts: STROKE_POSITIONS）。 */
export const STROKE_POSITIONS = ["外", "内", "居中"];

/* ------------------------------------------------ 图层种类（layer.ts: LayerKind） */

export const LAYER_KINDS = ["pixel", "adjust", "group"];

/* ------------------------------------------------ 选区模式（selection.ts + i18n） */

export const SELECTION_MODES = [
  { id: "new", label: "新建选区", hint: "重新拉框，替换已有选区" },
  { id: "add", label: "添加到选区", hint: "在已有选区上追加（也可按住 Shift 临时切换）" },
  { id: "subtract", label: "从选区减去", hint: "从已有选区里挖掉（也可按住 Alt 临时切换）" },
  { id: "intersect", label: "与选区交叉", hint: "只保留与已有选区重叠的部分" },
];

/** 选区菜单里的修改操作（i18n.zh.selection）。 */
export const SELECTION_EDIT_OPS = [
  { id: "select-all", label: "全选" },
  { id: "deselect", label: "取消选择" },
  { id: "invert", label: "反选" },
  { id: "feather", label: "羽化选区" },
  { id: "expand", label: "扩展选区" },
  { id: "contract", label: "收缩选区" },
  { id: "trim-to-selection", label: "裁切到选区" },
];

/* ------------------------------------------------ 工具箱（catalog.ts + i18n.tools） */

export const TOOL_GROUPS = [
  { id: "transform", label: "变换" },
  { id: "select", label: "选择" },
  { id: "shape", label: "形状" },
  { id: "text", label: "文字" },
  { id: "paint", label: "绘制" },
  { id: "retouch", label: "修饰" },
  { id: "sample", label: "取样" },
  { id: "crop", label: "裁剪" },
  { id: "nav", label: "导航" },
];

/**
 * 工具目录（id / 中文名 / 快捷键 / 分组 / 是否已接入）。
 * 顺序与条目逐字对齐 src/tools/catalog.ts 的 TOOLS，中文名取自 i18n.zh-CN 的 tools。
 */
export const TOOLS = [
  { id: "move", label: "移动", shortcut: "V", group: "transform", ready: true },
  { id: "marquee", label: "矩形选框", shortcut: "M", group: "select", ready: true },
  { id: "ellipse", label: "椭圆选框", shortcut: "M", group: "select", ready: true },
  { id: "singleRow", label: "单行选框", shortcut: "M", group: "select", ready: true },
  { id: "singleColumn", label: "单列选框", shortcut: "M", group: "select", ready: true },
  { id: "lasso", label: "套索", shortcut: "L", group: "select", ready: true },
  { id: "polyLasso", label: "多边形套索", shortcut: "L", group: "select", ready: true },
  { id: "wand", label: "魔棒", shortcut: "W", group: "select", ready: true },
  { id: "shapeRect", label: "矩形", shortcut: "U", group: "shape", ready: true },
  { id: "shapeEllipse", label: "椭圆", shortcut: "U", group: "shape", ready: true },
  { id: "shapeLine", label: "直线", shortcut: "U", group: "shape", ready: true },
  { id: "text", label: "文字", shortcut: "T", group: "text", ready: true },
  { id: "brush", label: "画笔", shortcut: "B", group: "paint", ready: true },
  { id: "pencil", label: "铅笔", shortcut: "B", group: "paint", ready: true },
  { id: "eraser", label: "橡皮", shortcut: "E", group: "paint", ready: true },
  { id: "magicEraser", label: "魔术橡皮擦", shortcut: "E", group: "paint", ready: true },
  { id: "bucket", label: "油漆桶", shortcut: "G", group: "paint", ready: true },
  { id: "gradient", label: "渐变", shortcut: "G", group: "paint", ready: true },
  { id: "clone", label: "仿制图章", shortcut: "S", group: "retouch", ready: true },
  { id: "heal", label: "修复画笔", shortcut: "J", group: "retouch", ready: true },
  { id: "blur", label: "模糊", shortcut: "R", group: "retouch", ready: true },
  { id: "sharpen", label: "锐化", shortcut: "R", group: "retouch", ready: true },
  { id: "dodge", label: "减淡", shortcut: "O", group: "retouch", ready: true },
  { id: "burn", label: "加深", shortcut: "O", group: "retouch", ready: true },
  { id: "sponge", label: "海绵", shortcut: "O", group: "retouch", ready: true },
  { id: "eyedropper", label: "吸管", shortcut: "I", group: "sample", ready: true },
  { id: "ruler", label: "标尺", shortcut: "I", group: "sample", ready: true },
  { id: "count", label: "计数", shortcut: "N", group: "sample", ready: true },
  { id: "crop", label: "裁剪", shortcut: "C", group: "crop", ready: true },
  { id: "hand", label: "抓手", shortcut: "H", group: "nav", ready: true },
  { id: "zoom", label: "缩放", shortcut: "Z", group: "nav", ready: true },
];

/* ------------------------------------------------ 导出 / 导入格式（image.ts） */

/**
 * 导出格式。真实实现只有 PNG 一条落盘编码路径
 * （image.ts: encodePng → canvas.toBlob("image/png")）。
 * 缩略图另有 WebP data URL（makeThumbnail），但不作为工程导出格式。
 */
export const EXPORT_FORMATS = [
  { id: "png", label: "PNG", mime: "image/png", lossless: true },
];

/** 可打开 / 可导入的图片扩展名（image.ts: IMAGE_EXTENSIONS）。 */
export const IMPORT_FORMATS = [
  { ext: "png", mime: "image/png" },
  { ext: "jpg", mime: "image/jpeg" },
  { ext: "jpeg", mime: "image/jpeg" },
  { ext: "webp", mime: "image/webp" },
  { ext: "tif", mime: "image/tiff" },
  { ext: "tiff", mime: "image/tiff" },
  { ext: "bmp", mime: "image/bmp" },
  { ext: "gif", mime: "image/gif" },
];

/* ------------------------------------------------ 工程格式说明 */

export const PROJECT_FORMAT = {
  magic: MAGIC,
  version: PROJECT_VERSION,
  extension: PROJECT_EXTENSION,
  encoding: "UTF-8（无 BOM）",
  shape: "{ magic, version, name, width, height, dpi?, active, layers:[FileLayer], selection?, alphaChannels? }",
  layerKind: LAYER_KINDS,
  layerFields: [
    "name", "visible", "opacity", "blend", "locked", "kind",
    "adjust?", "maskActive", "clip?", "styles?", "parent?", "surface?", "mask?", "window?", "smart?",
  ],
  surfaceNote:
    "surface 为像素层的 base64 PNG（不含 data: 前缀）；调整层与组无 surface；mask 同为 base64 PNG。" +
    "parent 为所属组在 layers 数组里的下标（顶层省略）；window 为调色范围几何；smart 为智能对象原始像素 data URL。" +
    "组图层的 opened（展开状态）只存在于文档模型与 PSD 往返（engine/psd.ts 桥接），.strata 不落盘。",
};

/** 组装完整能力清单（strata_capabilities 的返回体）。 */
export function buildCapabilities() {
  return {
    server: { name: SERVER_NAME, version: SERVER_VERSION, protocolVersion: PROTOCOL_VERSION },
    product: { name: "Strata", tagline: "修图 · 绘画", author: "小方工作室" },
    projectFormat: PROJECT_FORMAT,
    canvas: { limits: CANVAS_LIMITS, presets: CANVAS_PRESETS },
    layerKinds: LAYER_KINDS,
    blendModes: BLEND_MODES,
    adjustFamilies: ADJUST_FAMILIES,
    adjustTypes: ADJUST_DEFS,
    adjustStructures: {
      curve: {
        id: "curves",
        default: DEFAULT_CURVE,
        note: "控制点按 x 升序，x/y ∈ [0,1]；另有分通道 curveR/curveG/curveB（结构相同，缺省即对角线）",
      },
      stops: { id: "gradientmap", default: DEFAULT_STOPS, note: "色标按 at 升序，at ∈ [0,1]，color 为 #rrggbb" },
    },
    layerStyles: STYLE_DEFS,
    strokePositions: STROKE_POSITIONS,
    selectionModes: SELECTION_MODES,
    selectionOps: SELECTION_EDIT_OPS,
    tools: { groups: TOOL_GROUPS, list: TOOLS },
    imageOps: {
      filters: FILTERS,
      filterCount: FILTERS.length,
      colorModes: COLOR_MODES,
      smartSelects: SMART_SELECTS,
      colorProfiles: COLOR_PROFILES,
      /** 调色台的参数键（AI 得知道能传哪些数字） */
      gradeParams: GRADE_PARAM_SPEC,
      gradeWheels: GRADE_WHEELS,
      gradeSlicerRanges: SLICER_RANGES.map((r) => ({ key: r.key, label: r.label, center: r.center })),
      adjustersList: Object.keys(ADJUSTERS),
      /** 局部调色的范围类型（给 AI 看怎么传 window） */
      gradeWindows: [
        { kind: "ellipse", fields: ["cx", "cy", "rx", "ry", "rot?", "feather"], note: "椭圆，rot 为弧度" },
        {
          kind: "quad",
          fields: ["points: {x,y}×4", "feather", "edges?: [f1,f2,f3,f4]"],
          note: "四边形：四点各自独立，四条边羽化可各不相同",
        },
        { kind: "line", fields: ["x1", "y1", "x2", "y2", "feather"], note: "线性渐变：一侧调、一侧不调" },
        { kind: "poly", fields: ["points: {x,y}…", "feather"], note: "多边形（钢笔）" },
      ],
      engines: [
        { id: "grade", label: "调色台（一级/色轮/切片器/曲线）", tool: "strata_adjust_image · type=grade" },
        { id: "localGrade", label: "局部调色（按范围，Power Window）", tool: "strata_local_grade" },
        { id: "contentAwareScale", label: "内容识别缩放（接缝雕刻）", tool: "strata_content_aware_scale" },
        { id: "meshWarp", label: "木偶变形（MLS 钉点）", tool: "strata_mesh_warp" },
        { id: "smartSelect", label: "智能选区", tool: "strata_smart_select" },
        { id: "colorProfile", label: "色彩配置文件", tool: "strata_color_profile" },
        { id: "cropPhotos", label: "裁正照片（扫描件切分）", tool: "strata_crop_photos" },
        { id: "exportLut", label: "导出 3D LUT（.cube）", tool: "strata_export_lut" },
        { id: "proofread", label: "文字检查（排版/错拼）", tool: "strata_proofread" },
        { id: "exr", label: "OpenEXR 部件读取", tool: "strata_exr_read" },
        { id: "tracePaths", label: "轮廓描迹成 SVG", tool: "strata_trace_paths" },
        { id: "gif", label: "多帧合成 GIF", tool: "strata_make_gif" },
        { id: "droplet", label: "Droplet 配方", tool: "strata_make_droplet" },
        { id: "browse", label: "浏览文件夹", tool: "strata_list_dir" },
        { id: "palette", label: "调色板提取（中位切分）", tool: "strata_extract_palette" },
        { id: "channels", label: "通道拆分（R/G/B/Alpha）", tool: "strata_split_channels" },
        { id: "orient", label: "翻转 / 整倍旋转", tool: "strata_orient_image" },
        { id: "align", label: "自动对齐偏移估计", tool: "strata_align_shift" },
        { id: "pdf", label: "多图合成 PDF", tool: "strata_make_pdf" },
      ],
      /** 工程级批量操作（对齐 src/core/layerOps.ts / transform.ts 的文件形态） */
      projectOps: [
        { id: "deleteHiddenLayers", label: "删除全部隐藏图层", tool: "strata_delete_hidden_layers" },
        { id: "reverseLayerOrder", label: "反转图层顺序", tool: "strata_reverse_layers" },
        { id: "transform", label: "翻转 / 整倍旋转（图层或整份文档）", tool: "strata_transform_layer" },
        { id: "mask", label: "图层蒙版写入 / 清除 / 反相 / 快速新建", tool: "strata_set_layer_mask" },
        { id: "grayscale", label: "灰度文档（像素层去色）", tool: "strata_grayscale_project" },
      ],
    },
    exportFormats: EXPORT_FORMATS,
    importFormats: IMPORT_FORMATS,
    tools_available: [
      "strata_capabilities",
      "strata_read_project",
      "strata_write_project",
      "strata_patch_layer",
      "strata_add_layer",
      "strata_remove_layer",
      "strata_move_layer",
      "strata_duplicate_layer",
      "strata_validate",
      "strata_build_recipe",
      "strata_open_image",
      "strata_image_info",
      "strata_adjust_image",
      "strata_filter_image",
      "strata_color_mode",
      "strata_content_aware_scale",
      "strata_mesh_warp",
      "strata_smart_select",
      "strata_color_profile",
      "strata_crop_photos",
      "strata_export_lut",
      "strata_proofread",
      "strata_exr_parts",
      "strata_exr_read",
      "strata_list_dir",
      "strata_trace_paths",
      "strata_make_gif",
      "strata_make_droplet",
      "strata_local_grade",
      "strata_edit_image",
      "strata_export_image",
      "strata_image_preview",
      "strata_cutout",
      "strata_composite",
      "strata_light",
      "strata_doc_new",
      "strata_doc_add_image",
      "strata_doc_add_text",
      "strata_doc_add_shape",
      "strata_doc_adjust_layer",
      "strata_doc_drop_shadow",
      "strata_doc_preview",
      "strata_doc_export",
      "strata_doc_add_path",
      "strata_doc_transform_layer",
      "strata_doc_add_contour",
      "strata_doc_layer_effect",
      "strata_doc_add_glow",
      "strata_doc_add_glass",
      "strata_doc_save",
      "strata_delete_hidden_layers",
      "strata_reverse_layers",
      "strata_transform_layer",
      "strata_set_layer_mask",
      "strata_grayscale_project",
      "strata_extract_palette",
      "strata_split_channels",
      "strata_orient_image",
      "strata_align_shift",
      "strata_make_pdf",
    ],
  };
}
