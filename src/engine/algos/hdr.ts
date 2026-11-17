/**
 * HDR 合并纯函数内核：相对曝光估计 + Debevec 响应曲线 + hat 加权辐射合并
 * + ghost removal + 8 位色调映射。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/hdr.rs), MIT / Apache-2.0。
 * 输入显示编码的 RGBA 缓冲（0..255 字节），输出线性辐射结构与显示域结果；
 * 纯函数，不碰 DOM / Canvas，不依赖 strata_raw 解码。
 *
 * 参考：Debevec & Malik SIGGRAPH 1997（响应曲线 + 加权合并）、
 * Ward JGT 2003（曝光估计）、Reinhard et al. SIGGRAPH 2002（全局高光压缩）。
 */
import { linearToSrgb, srgbToLinear } from "../filters";
import type { RgbaBuffer } from "../filters/kernels";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Code value 上的三角帽权重（0..255）。 */
export function hatWeight(z: number): number {
  return Math.max(0, z <= 127.5 ? z : 255 - z);
}

/* -------------------------------------------------------- 曝光估计 */

/**
 * 从多张图自身估计相对曝光（线性倍数，最暗的那张 = 1）。
 * 按平均亮度排序，相邻两张只在"两张都曝光良好"的像素上取 sRGB 线性亮度比的中位数。
 */
export function estimateExposures(imgs: readonly RgbaBuffer[]): number[] {
  const n = imgs.length;
  if (n === 0) return [];
  const mean = imgs.map((img) => {
    const d = img.data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += luma(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    return s / Math.max(1, d.length / 4);
  });
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => mean[a] - mean[b]);
  const ex = new Array<number>(n).fill(1);
  for (let k = 1; k < n; k += 1) {
    const a = order[k - 1];
    const b = order[k];
    const da = imgs[a].data;
    const db = imgs[b].data;
    const len = Math.min(da.length, db.length) / 4;
    const ratios: number[] = [];
    for (let i = 0; i < len; i += 7) {
      const p = i * 4;
      const la = luma(da[p] / 255, da[p + 1] / 255, da[p + 2] / 255);
      const lb = luma(db[p] / 255, db[p + 1] / 255, db[p + 2] / 255);
      if (la > 0.08 && la < 0.92 && lb > 0.08 && lb < 0.92) {
        ratios.push(srgbToLinear(lb) / Math.max(1e-6, srgbToLinear(la)));
      }
    }
    ratios.sort((x, y) => x - y);
    ex[b] = ex[a] * (ratios.length ? Math.max(1, ratios[ratios.length >> 1]) : 2);
  }
  return ex;
}

/* -------------------------------------------------------- 响应曲线 */

/** 高斯消元解稠密线性方程组 A x = b（A、b 会被原地修改）。 */
function solveDense(A: Float64Array, b: Float64Array, size: number): Float64Array | null {
  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < size; r += 1) {
      if (Math.abs(A[r * size + col]) > Math.abs(A[pivot * size + col])) pivot = r;
    }
    if (Math.abs(A[pivot * size + col]) < 1e-12) return null;
    if (pivot !== col) {
      for (let c = col; c < size; c += 1) {
        const t = A[col * size + c]; A[col * size + c] = A[pivot * size + c]; A[pivot * size + c] = t;
      }
      const t = b[col]; b[col] = b[pivot]; b[pivot] = t;
    }
    const diag = A[col * size + col];
    for (let r = col + 1; r < size; r += 1) {
      const f = A[r * size + col] / diag;
      if (f === 0) continue;
      A[r * size + col] = 0;
      for (let c = col + 1; c < size; c += 1) A[r * size + c] -= f * A[col * size + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(size);
  for (let r = size - 1; r >= 0; r -= 1) {
    let s = b[r];
    for (let c = r + 1; c < size; c += 1) s -= A[r * size + c] * x[c];
    x[r] = s / A[r * size + r];
  }
  return x;
}

/** sRGB 理论响应曲线（g(128)=0），样本不足或求解失败时用。 */
export function srgbResponseCurve(): Float64Array {
  const base = Math.log(Math.max(1e-5, srgbToLinear(128 / 255)));
  const g = new Float64Array(256);
  for (let k = 0; k < 256; k += 1) g[k] = Math.log(Math.max(1e-5, srgbToLinear(k / 255))) - base;
  return g;
}

/**
 * Debevec–Malik 响应曲线：z[j][i] 是样本 i 在曝光 j 里的 code value（0..255）。
 * 返回 g(0..255)（log 曝光），g(128)=0，由 lambda 做二阶平滑。
 */
export function responseCurve(
  z: readonly (readonly number[])[],
  logDt: readonly number[],
  lambda = 40,
): Float64Array {
  const p = z.length;
  const n = p ? z[0].length : 0;
  const size = 256 + n;
  const A = new Float64Array(size * size);
  const b = new Float64Array(size);
  const add = (idx: readonly (readonly [number, number])[], value: number, weight: number) => {
    const w = weight * weight;
    for (const [ri, rv] of idx) {
      b[ri] += w * rv * value;
      for (const [ci, cv] of idx) A[ri * size + ci] += w * rv * cv;
    }
  };
  for (let j = 0; j < p; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const zz = clamp(Math.round(z[j][i]), 0, 255);
      add([[zz, 1], [256 + i, -1]], logDt[j], hatWeight(zz) + 1);
    }
  }
  add([[128, 1]], 0, 100);
  for (let k = 1; k < 255; k += 1) {
    add([[k - 1, 1], [k, -2], [k + 1, 1]], 0, Math.sqrt(lambda) * (hatWeight(k) + 1));
  }
  const x = solveDense(A, b, size);
  const g = x ? Float64Array.from(x.subarray(0, 256)) : srgbResponseCurve();
  // 强制单调：两端噪声可能把曲线折回去
  for (let k = 127; k >= 0; k -= 1) g[k] = Math.min(g[k], g[k + 1] - 1e-4);
  for (let k = 129; k < 256; k += 1) g[k] = Math.max(g[k], g[k - 1] + 1e-4);
  return g;
}

function gAt(g: Float64Array, v: number): number {
  const x = clamp01(v) * 255;
  const i = Math.min(254, Math.floor(x));
  const t = x - i;
  return g[i] * (1 - t) + g[i + 1] * t;
}

/** 分层采样：空间网格里挑中间曝光局部平坦的像素，按亮度分层轮换。 */
export function samplePixels(w: number, h: number, middle: RgbaBuffer, count = 160): number[] {
  const d = middle.data;
  const byBin: number[][] = Array.from({ length: 32 }, () => []);
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / Math.max(1, count * 40))));
  const pix = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return luma(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
  };
  for (let y = 2; y < h - 2; y += step) {
    for (let x = 2; x < w - 2; x += step) {
      const l = pix(x, y);
      const flat = [pix(x - 2, y), pix(x + 2, y), pix(x, y - 2), pix(x, y + 2)]
        .every((v) => Math.abs(v - l) < 0.04);
      if (flat) byBin[Math.min(31, Math.floor(l * 31.99))].push(y * w + x);
    }
  }
  const out: number[] = [];
  for (let k = 0; out.length < count && byBin.some((bin) => k < bin.length); k += 1) {
    for (const bin of byBin) {
      if (k < bin.length) out.push(bin[(k * 7) % bin.length]);
      if (out.length >= count) break;
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/* -------------------------------------------------------- 辐射合并 */

export type ResponseTriple = [Float64Array, Float64Array, Float64Array];

export interface HdrMergeOptions {
  /** 线性相对曝光，每张一个；缺省用 estimateExposures 估计。 */
  exposures?: readonly number[];
  /** 是否做 ghost removal。 */
  removeGhosts?: boolean;
  /** 每通道响应曲线；缺省从图像恢复。 */
  response?: ResponseTriple;
}

/** 线性辐射场：每个像素 RGB 三个 Float64（未压缩，可 > 1）。 */
export interface HdrRadiance {
  width: number;
  height: number;
  /** 长度 = width*height*3。 */
  rad: Float64Array;
  /** 长度 = width*height。 */
  alpha: Float64Array;
  response: ResponseTriple;
  stops: number;
  ghostFraction: number;
  exposures: number[];
}

function wellExposedCount(img: RgbaBuffer): number {
  const d = img.data;
  let n = 0;
  for (let i = 0; i < d.length; i += 12) {
    const l = luma(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    if (l > 0.1 && l < 0.9) n += 1;
  }
  return n;
}

/** 可分离盒式模糊，用于 ghost mask 羽化。 */
function boxBlurPlane(src: Float64Array, w: number, h: number, radius: number): Float64Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let acc = 0, n = 0;
      for (let k = -r; k <= r; k += 1) {
        const xx = x + k;
        if (xx >= 0 && xx < w) { acc += src[y * w + xx]; n += 1; }
      }
      tmp[y * w + x] = acc / n;
    }
  }
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let acc = 0, n = 0;
      for (let k = -r; k <= r; k += 1) {
        const yy = y + k;
        if (yy >= 0 && yy < h) { acc += tmp[yy * w + x]; n += 1; }
      }
      out[y * w + x] = acc / n;
    }
  }
  return out;
}

/** 把多张对齐的曝光图合并成线性辐射场。要求所有输入同尺寸。 */
export function mergeHdrExposures(
  imgs: readonly RgbaBuffer[],
  opts: HdrMergeOptions = {},
): HdrRadiance {
  const p = imgs.length;
  if (p === 0) throw new Error("HDR 合并至少需要一张曝光图");
  const w = imgs[0].width;
  const h = imgs[0].height;
  for (const im of imgs) {
    if (im.width !== w || im.height !== h) throw new Error("HDR 合并要求所有曝光图同尺寸");
  }

  const exposures = opts.exposures && opts.exposures.length === p
    ? opts.exposures.map((e) => Math.max(1e-12, e))
    : estimateExposures(imgs);
  const logDt = exposures.map((e) => Math.log(e));
  let best = 0;
  let bestN = -1;
  for (let j = 0; j < p; j += 1) {
    const n = wellExposedCount(imgs[j]);
    if (n > bestN) { bestN = n; best = j; }
  }

  const exposureSpan = Math.max(...exposures) / Math.max(1e-12, Math.min(...exposures));
  const response: ResponseTriple = opts.response
    ? [opts.response[0], opts.response[1], opts.response[2]]
    : (() => {
      // 曝光跨度太小（或只有一张）时响应曲线不可辨识，直接用 sRGB 理论曲线
      if (p < 2 || exposureSpan < 1.5) {
        return [srgbResponseCurve(), srgbResponseCurve(), srgbResponseCurve()];
      }
      const order = Array.from({ length: p }, (_, i) => i).sort((a, b) => exposures[a] - exposures[b]);
      const samples = samplePixels(w, h, imgs[order[p >> 1]], 160);
      if (samples.length < 8) return [srgbResponseCurve(), srgbResponseCurve(), srgbResponseCurve()];
      return [0, 1, 2].map((c) =>
        responseCurve(
          imgs.map((im) => samples.map((i) => Math.round(clamp01(im.data[i * 4 + c] / 255) * 255))),
          logDt,
          40,
        ),
      ) as ResponseTriple;
    })();

  const rad = new Float64Array(w * h * 3);
  const alpha = new Float64Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    let a = 0;
    for (let c = 0; c < 3; c += 1) {
      let num = 0, den = 0;
      for (let j = 0; j < p; j += 1) {
        const v = clamp01(imgs[j].data[i * 4 + c] / 255);
        const wt = hatWeight(v * 255);
        num += wt * (gAt(response[c], v) - logDt[j]);
        den += wt;
      }
      let le: number;
      if (den > 1e-6) {
        le = num / den;
      } else {
        // 全部饱和：亮像素取最短曝光，暗像素取最长曝光
        let sum = 0;
        for (const im of imgs) sum += im.data[i * 4 + c] / 255;
        const bright = sum / p > 0.5;
        let j = 0;
        for (let k = 1; k < p; k += 1) {
          if (bright ? logDt[k] < logDt[j] : logDt[k] > logDt[j]) j = k;
        }
        le = gAt(response[c], clamp01(imgs[j].data[i * 4 + c] / 255)) - logDt[j];
      }
      rad[i * 3 + c] = Math.exp(le);
    }
    for (const im of imgs) a = Math.max(a, im.data[i * 4 + 3] / 255);
    alpha[i] = a;
  }

  // 逐通道归一化：让 base 曝光里曝光良好的像素保住原来的线性值
  for (let c = 0; c < 3; c += 1) {
    const ratios: number[] = [];
    for (let i = 0; i < w * h; i += 37) {
      const v = clamp01(imgs[best].data[i * 4 + c] / 255);
      if (v > 0.15 && v < 0.85 && rad[i * 3 + c] > 0) {
        ratios.push(srgbToLinear(v) / (rad[i * 3 + c] * exposures[best]));
      }
    }
    ratios.sort((a, b) => a - b);
    const k = (ratios.length ? ratios[ratios.length >> 1] : 1) * exposures[best];
    for (let i = 0; i < w * h; i += 1) rad[i * 3 + c] *= k;
  }

  // ghost removal：各曝光 log 辐射估计加权方差大的像素改用 base 曝光
  let ghostFraction = 0;
  if (opts.removeGhosts && p > 1) {
    const r = Math.max(2, Math.round(Math.max(w, h) / 200));
    const score = new Float64Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      let s = 0, s2 = 0, sw = 0;
      for (let j = 0; j < p; j += 1) {
        const d = imgs[j].data;
        const l = luma(d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255);
        const wt = hatWeight(l * 255);
        if (wt < 20) continue;
        let lr = 0;
        for (let c = 0; c < 3; c += 1) {
          lr += (1 / 3) * (gAt(response[c], clamp01(d[i * 4 + c] / 255)) - logDt[j]);
        }
        s += wt * lr; s2 += wt * lr * lr; sw += wt;
      }
      if (sw > 0) {
        const m = s / sw;
        score[i] = Math.sqrt(Math.max(0, s2 / sw - m * m));
      }
    }
    const mask = Float64Array.from(score, (v) => (v > 0.35 ? 1 : 0));
    const blurred = boxBlurPlane(boxBlurPlane(mask, w, h, r), w, h, r);
    let ghosts = 0;
    for (let i = 0; i < w * h; i += 1) {
      const m = Math.min(1, blurred[i] * 3);
      if (m <= 0) continue;
      if (m > 0.5) ghosts += 1;
      const d = imgs[best].data;
      for (let c = 0; c < 3; c += 1) {
        const e = Math.exp(gAt(response[c], clamp01(d[i * 4 + c] / 255)) - logDt[best]);
        rad[i * 3 + c] = rad[i * 3 + c] * (1 - m) + e * m;
      }
    }
    ghostFraction = ghosts / Math.max(1, w * h);
  }

  const ls: number[] = [];
  for (let i = 0; i < w * h; i += 13) {
    if (alpha[i] <= 0) continue;
    ls.push(Math.max(1e-9, luma(rad[i * 3], rad[i * 3 + 1], rad[i * 3 + 2])));
  }
  ls.sort((a, b) => a - b);
  const stops = ls.length
    ? Math.log2(ls[Math.min(ls.length - 1, Math.floor(ls.length * 0.999))] / Math.max(1e-9, ls[Math.floor(ls.length * 0.01)]))
    : 0;

  return { width: w, height: h, rad, alpha, response, stops, ghostFraction, exposures };
}

/* -------------------------------------------------------- 色调映射 */

export type HdrToneMethod = "highlightCompression" | "exposureGamma" | "equalize";

export interface HdrToneOptions {
  exposure?: number;
  gamma?: number;
}

/** 把线性辐射色调映射回 8 位显示域。 */
export function toneMapRadiance(
  hdr: HdrRadiance,
  method: HdrToneMethod = "highlightCompression",
  opts: HdrToneOptions = {},
): RgbaBuffer {
  const { width: w, height: h, rad, alpha } = hdr;
  const out: RgbaBuffer = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  let logMean = 0, count = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (alpha[i] <= 0) continue;
    logMean += Math.log(Math.max(1e-6, luma(rad[i * 3], rad[i * 3 + 1], rad[i * 3 + 2])));
    count += 1;
  }
  const key = 0.18 / Math.max(1e-6, Math.exp(logMean / Math.max(1, count)));

  const cdf = (() => {
    if (method !== "equalize") return null;
    const BINS = 1024;
    const lv = new Float64Array(w * h);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < w * h; i += 1) {
      lv[i] = Math.log(Math.max(1e-7, luma(rad[i * 3], rad[i * 3 + 1], rad[i * 3 + 2])));
      if (alpha[i] > 0) { lo = Math.min(lo, lv[i]); hi = Math.max(hi, lv[i]); }
    }
    const span = Math.max(1e-6, hi - lo);
    const hist = new Float64Array(BINS);
    for (let i = 0; i < w * h; i += 1) {
      if (alpha[i] > 0) hist[Math.min(BINS - 1, Math.floor(((lv[i] - lo) / span) * BINS))] += 1;
    }
    const acc = new Float64Array(BINS);
    let total = 0;
    for (let k = 0; k < BINS; k += 1) { total += hist[k]; acc[k] = total; }
    for (let k = 0; k < BINS; k += 1) acc[k] /= Math.max(1, total);
    return { acc, lo, span, BINS };
  })();

  for (let i = 0; i < w * h; i += 1) {
    const p = i * 4;
    if (alpha[i] <= 0) { out.data[p + 3] = 0; continue; }
    const l = Math.max(1e-9, luma(rad[i * 3], rad[i * 3 + 1], rad[i * 3 + 2]));
    if (method === "exposureGamma") {
      const k = Math.pow(2, opts.exposure ?? 0);
      const g = clamp(opts.gamma ?? 1, 0.1, 10);
      for (let c = 0; c < 3; c += 1) {
        out.data[p + c] = Math.round(clamp01(Math.pow(linearToSrgb(clamp01(rad[i * 3 + c] * k)), 1 / g)) * 255);
      }
    } else if (cdf) {
      const bin = Math.min(cdf.BINS - 1, Math.floor(((Math.log(Math.max(1e-7, l)) - cdf.lo) / cdf.span) * cdf.BINS));
      const mapped = cdf.acc[bin];
      for (let c = 0; c < 3; c += 1) {
        out.data[p + c] = Math.round(clamp01(linearToSrgb(clamp01(mapped * (rad[i * 3 + c] / l)))) * 255);
      }
    } else {
      // Reinhard 全局高光压缩：l' = l/(1+l)，按通道等比缩放
      const lk = l * key;
      const r = ((lk / (1 + lk)) / lk) * key;
      for (let c = 0; c < 3; c += 1) {
        out.data[p + c] = Math.round(clamp01(linearToSrgb(clamp01(rad[i * 3 + c] * r))) * 255);
      }
    }
    out.data[p + 3] = Math.round(alpha[i] * 255);
  }
  return out;
}

/** 一站式：多曝光 → 8 位显示图。 */
export function mergeAndTone(
  imgs: readonly RgbaBuffer[],
  mergeOpts: HdrMergeOptions = {},
  tone: HdrToneMethod = "highlightCompression",
  toneOpts: HdrToneOptions = {},
): {
  image: RgbaBuffer;
  hdr: HdrRadiance;
} {
  const hdr = mergeHdrExposures(imgs, mergeOpts);
  return { image: toneMapRadiance(hdr, tone, toneOpts), hdr };
}
