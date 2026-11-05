/**
 * Strata BlendId（kebab-case，见 src/core/layer.ts 的 BLEND_MODES）→
 * compose.wgsl 里的 u32 混合模式编号。
 *
 * 编号沿用 ArtCraft PhotoCraft gpu crate compose.wgsl 的 mode 常量（1..27），
 * 与那份 WGSL 的 blend_channel switch 逐项对应，方便核对数值语义；0 是保留值，
 * 任何未知 id 都映射到 0，WGSL 把它当 normal 处理。
 *
 * 纯函数、零依赖，可在 node 环境下单测（不碰 WebGPU / DOM）。
 */

/** 27 种 BlendId → shader id。用 Map 而非对象字面量，避免 __proto__ 等原型键污染兜底。 */
const BLEND_IDS = new Map<string, number>([
  ["normal", 1],
  ["dissolve", 2],
  ["darken", 3],
  ["multiply", 4],
  ["color-burn", 5],
  ["linear-burn", 6],
  ["darker-color", 7],
  ["lighten", 8],
  ["screen", 9],
  ["color-dodge", 10],
  ["linear-dodge", 11],
  ["lighter-color", 12],
  ["overlay", 13],
  ["soft-light", 14],
  ["hard-light", 15],
  ["vivid-light", 16],
  ["linear-light", 17],
  ["pin-light", 18],
  ["hard-mix", 19],
  ["difference", 20],
  ["exclusion", 21],
  ["subtract", 22],
  ["divide", 23],
  ["hue", 24],
  ["saturation", 25],
  ["color", 26],
  ["luminosity", 27],
]);

/**
 * compose.wgsl 逐像素正确实现了公式的全部 27 种混合模式（与 BLEND_IDS 同序）。
 *
 * 早期版本只实现 11 种，其余 16 种在 WGSL 里退化为 normal 并被诊断位掩码标注；
 * 现在可分离 / 非分离 / 溶解全部按 CPU 语义补齐，SUPPORTED_GPU_BLENDS 因此扩到全套。
 * 导出名与类型保持不变，供 gpuFlatten 接线方判断某模式是否可走 GPU 路径。
 */
export const SUPPORTED_GPU_BLENDS: readonly string[] = [
  "normal",
  "dissolve",
  "darken",
  "multiply",
  "color-burn",
  "linear-burn",
  "darker-color",
  "lighten",
  "screen",
  "color-dodge",
  "linear-dodge",
  "lighter-color",
  "overlay",
  "soft-light",
  "hard-light",
  "vivid-light",
  "linear-light",
  "pin-light",
  "hard-mix",
  "difference",
  "exclusion",
  "subtract",
  "divide",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

/** BlendId → WGSL u32 编号；未知 id 一律返回 0（= normal）。 */
export function blendToShaderId(blend: string): number {
  return BLEND_IDS.get(blend) ?? 0;
}
