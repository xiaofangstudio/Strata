/**
 * 堆栈模式（Layer > Smart Objects > Stack Mode）。
 *
 * 把同一批参与层按**逐像素统计**合成为一层：会做天文摄影的人最熟的一招 ——
 * 多张连拍里用「平均值」降噪、「中间值」去闪光/去路人、「最大值」抓星轨。
 *
 * 全部是纯函数（RgbaBuffer 进、RgbaBuffer 出），node 里可直接断言。
 * 统计量定义与 Photoshop 一致：在 N 层同一像素的 N 个样本上算。
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

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 对一列样本算出统计量；返回 0~255 的灰度值。 */
function statistic(values: number[], mode: StackMode): number {
  const n = values.length;
  if (n === 0) return 0;
  switch (mode) {
    case "maximum":
      return Math.max(...values);
    case "minimum":
      return Math.min(...values);
    case "summation":
      return clamp255(values.reduce((a, b) => a + b, 0));
    case "mean":
      return values.reduce((a, b) => a + b, 0) / n;
    case "median": {
      const s = values.slice().sort((a, b) => a - b);
      return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    }
    case "range":
      return Math.max(...values) - Math.min(...values);
    default:
      break;
  }
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const m2 = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(m2);
  switch (mode) {
    case "variance":
      // 方差量级远小于 255，放大 16 倍才看得见（与 PS 的观感一致）
      return clamp255(m2 * 16);
    case "standardDeviation":
      return clamp255(sd * 4);
    case "skewness": {
      if (sd < 1e-6) return 128;
      const m3 = values.reduce((a, b) => a + (b - mean) ** 3, 0) / n;
      // 偏度归一到 0~255，128 = 对称
      return clamp255(128 + (m3 / sd ** 3) * 64);
    }
    case "kurtosis": {
      if (sd < 1e-6) return 128;
      const m4 = values.reduce((a, b) => a + (b - mean) ** 4, 0) / n;
      return clamp255(128 + ((m4 / sd ** 4) - 3) * 32);
    }
    case "entropy": {
      // 把 N 个样本按 16 桶直方图统计香农熵，归一到 0~255
      const bins = new Array(16).fill(0);
      for (const v of values) bins[Math.min(15, Math.floor(v / 16))] += 1;
      let h = 0;
      for (const c of bins) {
        if (c === 0) continue;
        const p = c / n;
        h -= p * Math.log2(p);
      }
      const maxH = Math.log2(Math.min(16, n));
      return maxH > 0 ? clamp255((h / maxH) * 255) : 0;
    }
    default:
      return mean;
  }
}

/**
 * 把多层按堆栈模式合成一层。
 * 尺寸取所有层的交集区域（以第一层为基准），alpha 取各层的平均覆盖率。
 */
export function applyStackMode(layers: RgbaBuffer[], mode: StackMode): RgbaBuffer {
  if (layers.length === 0) return makeBuffer(1, 1);
  const w = Math.min(...layers.map((l) => l.width));
  const h = Math.min(...layers.map((l) => l.height));
  const out = makeBuffer(w, h);
  const n = layers.length;
  const vals: number[] = new Array(n);
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    for (let c = 0; c < 3; c += 1) {
      for (let i = 0; i < n; i += 1) vals[i] = layers[i].data[p * 4 + c];
      out.data[o + c] = statistic(vals, mode);
    }
    // alpha 用平均：统计量模式下透明度不该被放大成噪声
    let a = 0;
    for (let i = 0; i < n; i += 1) a += layers[i].data[o + 3];
    out.data[o + 3] = a / n;
  }
  return out;
}
