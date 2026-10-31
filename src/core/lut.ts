/**
 * 3D 查找表（.cube）导出与批处理用的「把一层调整套到任意图上」。
 *
 * 两件事共同的难点：调整层是文档结构的一部分，不能直接作用到一张裸图上。
 * 但合成器 `composeDoc` 只要求「宽高 + 图层数组」，所以只要临时拼一份
 * 「目标图 + 那几个调整层」的文档，就能得到与原文档完全一致的调色结果。
 *
 * 纯逻辑部分（LUT 网格排布、.cube 文本）在 node 里可断言。
 */

/** .cube 的默认网格边长（33 是行业惯例，够平滑又不太大）。 */
export const CUBE_SIZE = 33;

/**
 * 生成「恒等 LUT」的像素数据。
 *
 * 排布（与多数工具一致的横向铺法）：
 * - 画布宽 = n × n，高 = n
 * - 列 x 对应 b 块里的 r（x % n = r，floor(x / n) = b）
 * - 行 y 对应 g
 * 这样把调整合成为一条横图之后，读回来就是一张 LUT 切片图。
 */
export function identityLut(size: number): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const width = size * size;
  const height = size;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const x = b * size + r;
        const y = g;
        const i = (y * width + x) * 4;
        data[i] = Math.round((r / (size - 1)) * 255);
        data[i + 1] = Math.round((g / (size - 1)) * 255);
        data[i + 2] = Math.round((b / (size - 1)) * 255);
        data[i + 3] = 255;
      }
    }
  }
  return { data, width, height };
}

/**
 * 把「已合成过的 LUT 切片图」写成 .cube 文本。
 *
 * 顺序：r 变化最快、其次 g、最后 b —— 这是 .cube 规范要求的顺序，
 * 也是我们横向铺法的自然读法（列优先取 r）。
 */
export function lutToCube(
  data: Uint8ClampedArray,
  width: number,
  size: number,
  title = "Strata LUT",
): string {
  const lines: string[] = [];
  lines.push(`TITLE "${title.replace(/"/g, "'")}"`);
  lines.push(`LUT_3D_SIZE ${size}`);
  lines.push("DOMAIN_MIN 0.0 0.0 0.0");
  lines.push("DOMAIN_MAX 1.0 1.0 1.0");
  const fmt = (v: number): string => (v / 255).toFixed(6);
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const x = b * size + r;
        const i = (g * width + x) * 4;
        lines.push(`${fmt(data[i])} ${fmt(data[i + 1])} ${fmt(data[i + 2])}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** 恒等 LUT 的 .cube（没有调整层时导出它，等于「不做任何改变」）。 */
export function identityCube(size: number): string {
  const { data, width } = identityLut(size);
  return lutToCube(data, width, size, "Identity");
}
