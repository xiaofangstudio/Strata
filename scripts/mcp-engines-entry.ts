/**
 * MCP 引擎包的入口（只做 re-export，不打业务逻辑）。
 *
 * 这里的每个模块都是**不依赖 DOM**的纯函数（RGBA 字节数组进、字节数组出），
 * 所以可以原样打包给 Node 侧的 MCP 服务器用 —— 界面与 MCP 共用同一份算法，
 * 不会出现「界面里效果一样、MCP 里另一套」的漂移。
 *
 * 由 scripts/build-mcp-engines.mjs 用 esbuild 打包成 mcp/lib/engines.gen.mjs。
 * 新增纯算法模块时，记得在这里补一行导出并重新执行 npm run mcp:engines。
 */

/* 滤镜注册表：100+ 个滤镜的参数表 + 内核（params 里有中文名、范围、默认值） */
export { FILTER_DEFS, filterDef, filterParams } from "../src/engine/filters/defs";
export type { FilterDef, FilterGroup, FilterParam } from "../src/engine/filters/defs";

/* 颜色模式：位图 / 双色调 / 索引 / CMYK / Lab / 多通道 */
export {
  applyPalette,
  colorHalftone,
  medianCutPalette,
  quantizeTo8,
  splitChannels,
  toBitmap,
  toCmyk,
  toDuotone,
  toIndexed,
  toLab,
} from "../src/core/colorMode";

/* 内容识别缩放（接缝雕刻） */
export {
  contentAwareScale,
  energyMap,
  findHorizontalSeam,
  findVerticalSeam,
  insertHorizontalSeam,
  insertVerticalSeam,
  removeHorizontalSeam,
  removeVerticalSeam,
} from "../src/core/seamCarve";

/* 木偶变形（MLS） */
export { mlsWarp } from "../src/engine/meshWarp";

/* 智能选区：纯判定函数（吃 RGBA 吐 0/1 表） */
export { colorRangeHit, growHit, subjectHit, skyHit, focusHit } from "../src/core/smartSelect";

/* 自动对齐的偏移估计 + 锐度权重 */
export { estimateShift, sharpnessWeights } from "../src/core/stackOps";

/* 色彩配置文件换算 */
export { convertProfile, PROFILE_LABELS } from "../src/core/colorProfile";

/* 裁正照片：背景估计 + 连通域找照片矩形（纯函数） */
export { findPhotoRegions } from "../src/core/photoCrop";

/* 3D LUT：恒等表生成与 .cube 文本（纯函数） */
export { CUBE_SIZE, identityCube, identityLut, lutToCube } from "../src/core/lut";

/* 文字检查：可确证的排版/错拼问题（纯函数） */
export { applyFixes, checkText, ISSUE_LABEL } from "../src/core/proofread";

/* 极简 PDF 写出器（Node 里有 TextEncoder，可直接用） */
export { buildPdf, countPdfPages, pdfHead } from "../src/core/pdf";
