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

/** MCP 协议版本（本服务器声明支持）。 */
export const PROTOCOL_VERSION = "2024-11-05";

/** ServerInfo 名称与版本。 */
export const SERVER_NAME = "strata";
export const SERVER_VERSION = "1.0.0";

/* ------------------------------------------------ .strata 工程格式常量 */

/** 工程文件魔数（src/engine/project.ts）。 */
export const MAGIC = "STRATA-PROJECT";
/** 当前工程格式版本（v3：新增文档选区）。 */
export const PROJECT_VERSION = 3;
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
];

export const STYLE_IDS = STYLE_DEFS.map((s) => s.id);

/** 描边位置（layer.ts: STROKE_POSITIONS）。 */
export const STROKE_POSITIONS = ["外", "内", "居中"];

/* ------------------------------------------------ 图层种类 */

export const LAYER_KINDS = ["pixel", "adjust"];

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
  { id: "paint", label: "绘制" },
  { id: "retouch", label: "修饰" },
  { id: "sample", label: "取样" },
  { id: "crop", label: "裁剪" },
  { id: "nav", label: "导航" },
];

/** 工具目录（id / 中文名 / 快捷键 / 分组 / 是否已接入）。 */
export const TOOLS = [
  { id: "move", label: "移动", shortcut: "V", group: "transform", ready: true },
  { id: "marquee", label: "矩形选框", shortcut: "M", group: "select", ready: true },
  { id: "ellipse", label: "椭圆选框", shortcut: "M", group: "select", ready: true },
  { id: "lasso", label: "套索", shortcut: "L", group: "select", ready: true },
  { id: "wand", label: "魔棒", shortcut: "W", group: "select", ready: true },
  { id: "shapeRect", label: "矩形", shortcut: "U", group: "shape", ready: true },
  { id: "shapeEllipse", label: "椭圆", shortcut: "U", group: "shape", ready: true },
  { id: "shapeLine", label: "直线", shortcut: "U", group: "shape", ready: true },
  { id: "brush", label: "画笔", shortcut: "B", group: "paint", ready: true },
  { id: "eraser", label: "橡皮", shortcut: "E", group: "paint", ready: true },
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
  shape: "{ magic, version, name, width, height, dpi?, active, layers:[FileLayer], selection? }",
  layerKind: LAYER_KINDS,
  layerFields: [
    "name", "visible", "opacity", "blend", "locked", "kind",
    "adjust?", "maskActive", "clip?", "styles?", "surface?", "mask?",
  ],
  surfaceNote: "surface 为像素层的 base64 PNG（不含 data: 前缀）；调整层无 surface；mask 同为 base64 PNG。",
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
      curve: { id: "curves", default: DEFAULT_CURVE, note: "控制点按 x 升序，x/y ∈ [0,1]" },
      stops: { id: "gradientmap", default: DEFAULT_STOPS, note: "色标按 at 升序，at ∈ [0,1]，color 为 #rrggbb" },
    },
    layerStyles: STYLE_DEFS,
    strokePositions: STROKE_POSITIONS,
    selectionModes: SELECTION_MODES,
    selectionOps: SELECTION_EDIT_OPS,
    tools: { groups: TOOL_GROUPS, list: TOOLS },
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
    ],
  };
}
