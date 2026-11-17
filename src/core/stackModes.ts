/**
 * 堆栈模式（Layer > Smart Objects > Stack Mode）。
 *
 * 把同一批参与层按**逐像素统计**合成为一层：多张连拍里用「平均值」降噪、
 * 「中间值」去闪光/去路人、「最大值」抓星轨。
 *
 * 统计口径对齐 PhotoCraft `crates/algo/src/stack.rs`（MIT / Apache-2.0）：
 * - 只有 alpha > 0 的层参与样本；输出 alpha 取各层最大值（不是平均）；
 * - 颜色样本归一到 0..1 算矩，再映射回 0..255；
 * - 偏度/峰度标准化后映到 0..1 显示（对称=0.5，正态峰度≈3）；
 * - 熵取 8 位 256 桶香农熵 / log2(N)。
 *
 * 全部纯函数（RgbaBuffer 进、RgbaBuffer 出），node 里可直接断言。
 */
import { makeBuffer, type RgbaBuffer } from "../engine/filters/kernels";

export type StackMode =
  | "entropy"
  | "kurtosis"
  | "maximum"
  | "mean"
  | "median"
  | "minimum"
  | "range"
  | "skewness"
  | "standardDeviation"
  | "summation"
  | "variance";

export const STACK_MODE_LABELS: Record<StackMode, string> = {
  entropy: "熵",
  kurtosis: "峰度",
  maximum: "最大值",
  mean: "平均值",
  median: "中间值",
  minimum: "最小值",
  range: "范围",
  skewness: "偏度",
  standardDeviation: "标准偏差",
  summation: "总和",
  variance: "方差",
};

/** 0..1 的统计量映射回 0..255。 */
const toByte = (v: number): number => Math.max(0, Math.min(255, v * 255));

/** 对一列 0..1 样本算统计量，返回 0..1。 */
function statistic(values: Float64Array, mode: StackMode): number {
  const n = values.length;
  if (n === 0) return 0;
  switch (mode) {
    case "maximum": {
      let m = -Infinity;
      for (const v of values) m = Math.max(m, v);
      return m;
    }
    case "minimum": {
      let m = Infinity;
      for (const v of values) m = Math.min(m, v);
      return m;
    }
    case "summation": {
      let s = 0;
      for (const v of values) s += v;
      return Math.min(1, Math.max(0, s));
    }
    case "range": {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      return hi - lo;
    }
    case "median": {
      const s = Array.from(values).sort((a, b) => a - b);
      return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    }
    case "entropy": {
      if (n < 2) return 0;
      const bins = new Int32Array(256);
      for (const v of values) bins[Math.min(255, Math.max(0, Math.round(v * 255)))] += 1;
      let h = 0;
      for (const c of bins) {
        if (c === 0) continue;
        const p = c / n;
        h -= p * Math.log2(p);
      }
      return h / Math.log2(n);
    }
    default:
      break;
  }
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  const moment = (k: number): number => {
    let s = 0;
    for (const v of values) s += (v - mean) ** k;
    return s / n;
  };
  const variance = moment(2);
  switch (mode) {
    case "mean":
      return mean;
    case "variance":
      return Math.min(1, variance);
    case "standardDeviation":
      return Math.min(1, Math.sqrt(variance));
    case "skewness": {
      const sd = Math.sqrt(variance);
      if (sd < 1e-6) return 0.5;
      return Math.max(0, Math.min(1, moment(3) / sd ** 3 / 4 + 0.5));
    }
    case "kurtosis": {
      if (variance < 1e-12) return 0;
      return Math.max(0, Math.min(1, moment(4) / (variance * variance) / 10));
    }
    default:
      return mean;
  }
}

/**
 * 把多层按堆栈模式合成一层。尺寸取所有层的交集（以左上角对齐）。
 * 只有 alpha > 0 的层贡献颜色样本，输出 alpha 为最大输入 alpha。
 */
export function applyStackMode(layers: RgbaBuffer[], mode: StackMode): RgbaBuffer {
  if (layers.length === 0) return makeBuffer(1, 1);
  const w = Math.min(...layers.map((l) => l.width));
  const h = Math.min(...layers.map((l) => l.height));
  const out = makeBuffer(w, h);
  const samples = new Float64Array(layers.length);
  const visible: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let alpha = 0;
      visible.length = 0;
      for (let i = 0; i < layers.length; i += 1) {
        const layer = layers[i];
        if (x >= layer.width || y >= layer.height) continue;
        const li = (y * layer.width + x) * 4;
        const a = layer.data[li + 3];
        if (a <= 0) continue; // 透明样本不参与统计
        visible.push(i);
        alpha = Math.max(alpha, a);
      }
      if (visible.length === 0) continue;
      const k = visible.length;
      for (let c = 0; c < 3; c += 1) {
        for (let j = 0; j < k; j += 1) {
          const layer = layers[visible[j]];
          samples[j] = layer.data[(y * layer.width + x) * 4 + c] / 255;
        }
        out.data[o + c] = toByte(statistic(samples.subarray(0, k), mode));
      }
      out.data[o + 3] = alpha;
    }
  }
  return out;
}
