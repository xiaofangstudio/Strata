/**
 * 内容识别填充内核（Poisson 调和打底 + PatchMatch 样本块合成）。
 *
 * 目标：把一块选中的像素"抹掉"，再用**图里别处的纹理**把洞补上 ——
 * 不是模糊、不是拉伸边缘，而是真的搬一块长得像的图案过来。
 *
 * 分两步，缺一不可：
 *
 *   第一步「打底」：用 Poisson 膜的调和插值（Δv=0，洞外像素是 Dirichlet 边界）
 *   把洞里填成由边界向内过渡的平滑色。没有这一步，洞的正中央周围一个已知
 *   像素都没有，相似度无从计算，那些像素就只能原封不动留着 —— 于是"填充"
 *   完洞里还是原来那坨东西。这一步保证无论洞多大，每个像素都有个像样的起点。
 *
 *   第二步「长纹理」：PatchMatch。
 *     a. 给洞里每个像素先随便认一个"参考位置"（随机初始化，种子固定，
 *        所以同样的图同样的选区必得同样的结果）。
 *     b. 反复扫图：一个像素的好参考，它的左右邻居往往也有好参考 ——
 *        于是把邻居的参考平移一格拿来试（传播）。
 *     c. 同时在附近随机撒点试（随机搜索，半径逐轮减半）。
 *     d. 谁的块最像就留谁。几轮之后相似的纹理自然连成一片。
 *     e. 最后不是"一个像素抄一个像素"，而是**投票**：洞里每个像素被周围
 *        众多参考块各投一票，取加权平均。逐像素硬抄会有明显颗粒感，
 *        投票出来的填充既保纹理又不见缝。
 *
 * 相似度里，目标侧的已知像素算满分权重，调和打底出来的像素只算 0.35 ——
 * 后者是猜的，不该和真实像素平起平坐，但也不能当它不存在。
 *
 * 与 `liquify.ts` / `auto.ts` 一致：只认「RGBA 字节 + 宽高」，不碰画布与 DOM。
 */
import { membraneFillRgba } from "./algos/poisson";
import { createRaster, type Raster } from "./raster";

export interface InpaintOptions {
  /** 补丁半径（像素）。3 表示 7×7。越大越懂结构，越慢。 */
  patch?: number;
  /** 迭代轮数（每轮含正反两遍扫描） */
  iterations?: number;
  /** 随机搜索的初始半径上限（像素） */
  search?: number;
  /** 随机种子；固定后同样的输入必得同样的输出 */
  seed?: number;
  /** true = 源图洞内已有粗层结果，不再用 Poisson 调和覆盖它（多尺度细层用） */
  skipBase?: boolean;
  /** Image Melding：按洞边已知像素做 gain/bias 颜色适应后再投票 */
  meld?: boolean;
}

const DEFAULTS = { patch: 3, iterations: 4, search: 64, seed: 0x5eed };

/** 扩散打底像素在相似度里的权重（真实像素为 1）。 */
const BASE_WEIGHT = 0.35;

/** 确定性伪随机（mulberry32）—— 用 `Math.random` 会让结果每次都不一样。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由矩形生成掩膜（1 = 要填）。 */
export function rectMask(
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
): Uint8Array {
  const m = new Uint8Array(width * height);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) m[y * width + x] = 1;
  }
  return m;
}

/**
 * 面积表（summed-area table）：用来 O(1) 判断「某个补丁里是不是一个已知像素都没有」。
 * 逐像素扫补丁在图大、补丁大时会成为瓶颈，这一步把它降成一次加减。
 */
function buildSat(mask: Uint8Array, w: number, h: number): Int32Array {
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < w; x += 1) {
      rowSum += mask[y * w + x];
      sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return sat;
}

/**
 * 打底改为 Poisson 调和插值（crates/algo/src/poisson.rs 的 membrane_fill）：
 * 以洞外像素为 Dirichlet 边界解 Δv=0，比逐轮扩散更准确，细长划痕不会
 * 在洞心留下“原物体的模糊轮廓”。后续 PatchMatch 仍负责长纹理。
 */

/**
 * 内容识别填充。
 *
 * `mask` 长度必须是 width × height，非 0 表示该像素要被填掉。
 * 返回一张新图；原图不动（界面要拿原图做「取消」）。
 */
export function inpaint(src: Raster, mask: Uint8Array, opts: InpaintOptions = {}): Raster {
  const w = src.width;
  const h = src.height;
  const out = createRaster(w, h);
  out.data.set(src.data);

  const patch = Math.max(1, Math.round(opts.patch ?? DEFAULTS.patch));
  const iters = Math.max(0, Math.round(opts.iterations ?? DEFAULTS.iterations));
  const search = Math.max(4, Math.round(opts.search ?? DEFAULTS.search));
  const rnd = mulberry32(opts.seed ?? DEFAULTS.seed);

  // 洞（要填的）与源（可以借的）
  const targets: number[] = [];
  for (let i = 0; i < w * h; i += 1) if (mask[i]) targets.push(i);
  if (targets.length === 0) return out;
  if (targets.length >= w * h) return out; // 整张都选上了，没有可借的样本
  const isMask = (i: number) => mask[i] !== 0;

  // ---- 第一步：Poisson 调和打底 ----
  // 以洞外像素为边界解 Δv=0；cascadic multigrid 让大洞/细长洞都有稳定起点。
  if (!opts.skipBase) {
    const base = membraneFillRgba(out, mask);
    out.data.set(base.data);
  }

  // ---- 第二步：PatchMatch 长纹理 ----
  const sat = buildSat(mask, w, h);
  /** 补丁范围内一个已知像素都没有？ */
  const patchAllMasked = (x: number, y: number): boolean => {
    const x0 = x - patch;
    const y0 = y - patch;
    const x1 = x + patch + 1;
    const y1 = y + patch + 1;
    if (x0 < 0 || y0 < 0 || x1 > w || y1 > h) return true;
    const a = sat[y0 * (w + 1) + x0];
    const b = sat[y0 * (w + 1) + x1];
    const c = sat[y1 * (w + 1) + x0];
    const d = sat[y1 * (w + 1) + x1];
    return d - b - c + a === (x1 - x0) * (y1 - y0);
  };

  /** 合法的参考中心：整块补丁都在图内，且补丁里至少有真实像素。 */
  const sources: number[] = [];
  for (let y = patch; y < h - patch; y += 1) {
    for (let x = patch; x < w - patch; x += 1) {
      const i = y * w + x;
      if (!isMask(i) && !patchAllMasked(x, y)) sources.push(i);
    }
  }
  if (sources.length === 0) return out;

  const nnx = new Int32Array(w * h);
  const nny = new Int32Array(w * h);
  const nnc = new Float64Array(w * h);

  const pickSource = () => sources[(rnd() * sources.length) | 0];

  /**
   * 补丁差异度。目标侧用 `out`（洞内是扩散打底的结果），参考侧用 `src`
   * （参考中心保证落在真实像素上）。
   */
  const patchDist = (tx: number, ty: number, sx: number, sy: number): number => {
    let sum = 0;
    let n = 0;
    const td = out.data;
    const sd = src.data;
    for (let dy = -patch; dy <= patch; dy += 1) {
      const tyy = ty + dy;
      if (tyy < 0 || tyy >= h) continue;
      const syy = sy + dy;
      for (let dx = -patch; dx <= patch; dx += 1) {
        const txx = tx + dx;
        if (txx < 0 || txx >= w) continue;
        const ti = tyy * w + txx;
        const si = (syy * w + sx + dx) * 4;
        const tj = ti * 4;
        const wt = isMask(ti) ? BASE_WEIGHT : 1;
        const dr = td[tj] - sd[si];
        const dg = td[tj + 1] - sd[si + 1];
        const db = td[tj + 2] - sd[si + 2];
        const da = td[tj + 3] - sd[si + 3];
        sum += wt * (dr * dr + dg * dg + db * db + da * da);
        n += wt;
      }
    }
    return n === 0 ? Infinity : sum / n;
  };

  // 初始化：随机撒几处，挑最像的那个当起点
  for (const i of targets) {
    const x = i % w;
    const y = (i / w) | 0;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let k = 0; k < 3; k += 1) {
      const s = pickSource();
      const sx = s % w;
      const sy = (s / w) | 0;
      const d = patchDist(x, y, sx, sy);
      if (d < best) {
        best = d;
        bx = sx;
        by = sy;
      }
    }
    nnx[i] = bx;
    nny[i] = by;
    nnc[i] = best;
  }

  // ---- 迭代：传播 + 随机搜索 ----
  const tryCandidate = (i: number, x: number, y: number, sx: number, sy: number): void => {
    if (sx < patch || sy < patch || sx >= w - patch || sy >= h - patch) return;
    if (isMask(sy * w + sx)) return;
    const d = patchDist(x, y, sx, sy);
    if (d < nnc[i]) {
      nnc[i] = d;
      nnx[i] = sx;
      nny[i] = sy;
    }
  };

  for (let it = 0; it < iters; it += 1) {
    const forward = it % 2 === 0;
    for (let t = 0; t < targets.length; t += 1) {
      const i = targets[forward ? t : targets.length - 1 - t];
      const x = i % w;
      const y = (i / w) | 0;

      // 传播：把左右 / 上下邻居的参考平移一格
      const nx = forward ? x - 1 : x + 1;
      const ny = forward ? y - 1 : y + 1;
      if (nx >= 0 && nx < w && isMask(y * w + nx)) {
        tryCandidate(i, x, y, nnx[y * w + nx] + (forward ? 1 : -1), nny[y * w + nx]);
      }
      if (ny >= 0 && ny < h && isMask(ny * w + x)) {
        tryCandidate(i, x, y, nnx[ny * w + x], nny[ny * w + x] + (forward ? 1 : -1));
      }

      // 随机搜索：以当前解为中心，半径逐轮减半
      let rad = search;
      while (rad > 0.5) {
        const sx = nnx[i] + Math.round((rnd() * 2 - 1) * rad);
        const sy = nny[i] + Math.round((rnd() * 2 - 1) * rad);
        tryCandidate(i, x, y, sx, sy);
        rad *= 0.5;
      }
    }
  }

  // ---- 投票合成：洞内每个像素取所有覆盖它的参考块的加权平均 ----
  const accR = new Float64Array(w * h);
  const accG = new Float64Array(w * h);
  const accB = new Float64Array(w * h);
  const accA = new Float64Array(w * h);
  const accW = new Float64Array(w * h);
  const sd = src.data;

  for (const i of targets) {
    const x = i % w;
    const y = (i / w) | 0;
    const sx = nnx[i];
    const sy = nny[i];

    // Image Melding：用补丁里「目标侧已知像素 vs 对应源像素」做最小二乘，
    // 得到局部 gain/bias，把借来的纹理adapt到洞边的明暗与色温上。
    let gain = 1;
    let bias = 0;
    if (opts.meld) {
      let nk = 0;
      let sumX = 0;
      let sumY = 0;
      let sumXX = 0;
      let sumXY = 0;
      for (let dy = -patch; dy <= patch; dy += 1) {
        const tyy = y + dy;
        if (tyy < 0 || tyy >= h) continue;
        for (let dx = -patch; dx <= patch; dx += 1) {
          const txx = x + dx;
          if (txx < 0 || txx >= w) continue;
          const ti = tyy * w + txx;
          if (isMask(ti)) continue;
          const si = ((sy + dy) * w + sx + dx) * 4;
          const tj = ti * 4;
          const sv = (sd[si] + sd[si + 1] + sd[si + 2]) / 3;
          const tv = (out.data[tj] + out.data[tj + 1] + out.data[tj + 2]) / 3;
          nk += 1;
          sumX += sv;
          sumY += tv;
          sumXX += sv * sv;
          sumXY += sv * tv;
        }
      }
      if (nk >= 4) {
        const den = sumXX - (sumX * sumX) / nk;
        if (den > 1) {
          gain = (sumXY - (sumX * sumY) / nk) / den;
          gain = Math.max(0.7, Math.min(1.3, Number.isFinite(gain) ? gain : 1));
          bias = (sumY - gain * sumX) / nk;
          bias = Math.max(-48, Math.min(48, Number.isFinite(bias) ? bias : 0));
        }
      }
    }

    // 置信度：均方差越小这一票越算数（+8 防止除零，也压住逆天权重）
    const wgt = 1 / (nnc[i] + 8);
    if (!(wgt > 0)) continue;
    for (let dy = -patch; dy <= patch; dy += 1) {
      const tyy = y + dy;
      if (tyy < 0 || tyy >= h) continue;
      for (let dx = -patch; dx <= patch; dx += 1) {
        const txx = x + dx;
        if (txx < 0 || txx >= w) continue;
        const ti = tyy * w + txx;
        if (!isMask(ti)) continue;
        const si = ((sy + dy) * w + sx + dx) * 4;
        accR[ti] += (gain * sd[si] + bias) * wgt;
        accG[ti] += (gain * sd[si + 1] + bias) * wgt;
        accB[ti] += (gain * sd[si + 2] + bias) * wgt;
        accA[ti] += sd[si + 3] * wgt;
        accW[ti] += wgt;
      }
    }
  }

  for (const i of targets) {
    const k = accW[i];
    if (!(k > 0)) continue; // 没人投票：保留扩散打底的结果
    const o = i * 4;
    const inv = 1 / k;
    out.data[o] = accR[i] * inv;
    out.data[o + 1] = accG[i] * inv;
    out.data[o + 2] = accB[i] * inv;
    out.data[o + 3] = accA[i] * inv;
  }
  return out;
}

/** 矩形区域的便捷填充。 */
export function inpaintRect(
  src: Raster,
  rect: { x: number; y: number; width: number; height: number },
  opts?: InpaintOptions,
): Raster {
  return inpaint(src, rectMask(src.width, src.height, rect), opts);
}
