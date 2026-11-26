/**
 * 内容识别填充增强：多尺度 coarse-to-fine + 洋葱剥离 + Image Melding。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/inpaint.rs), MIT / Apache-2.0
 * 的算法描述（本地快照缺 5 个子源文件，不逐行照搬）。
 *
 * 单一分辨率的 PatchMatch 有两个老毛病：细长划痕会被 Poisson 膜在洞心留轮廓；
 * 大洞的匹配场容易被局部极小值困住。这里先按洞的"厚度"决定金字塔层数，
 * 粗层给结构、细层只 refine 匹配；最后从洞边一圈圈向内收敛，让已填好的
 * 外环变成内环的真实样本。颜色适应交给 inpaint() 里的 gain/bias 投票。
 */
import { createRaster, type Raster } from "../raster";
import { inpaint, type InpaintOptions } from "../inpaint";

export interface CompleteOptions extends InpaintOptions {
  /** 金字塔层数，默认按洞厚自动决定（最多 3 层）。 */
  levels?: number;
  /** 是否在最细层做洋葱剥离，默认 true。 */
  onion?: boolean;
}

/** 洞内像素到最近已知像素的倒角距离；返回的是最大厚度（直径）。 */
export function holeThickness(mask: Uint8Array, w: number, h: number): number {
  const inf = 1e6;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] ? inf : 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const step = dx !== 0 && dy !== 0 ? 1.4142 : 1;
          best = Math.min(best, d[ny * w + nx] + step);
        }
      }
      d[i] = best;
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const step = dx !== 0 && dy !== 0 ? 1.4142 : 1;
          best = Math.min(best, d[ny * w + nx] + step);
        }
      }
      d[i] = best;
    }
  }
  let max = 0;
  for (let i = 0; i < d.length; i += 1) if (mask[i] && d[i] < inf) max = Math.max(max, d[i]);
  return Math.max(1, Math.round(max * 2 + 1));
}

/** 掩膜向内腐蚀若干像素（只保留离边界更远的洞心）。 */
export function erodeMask(mask: Uint8Array, w: number, h: number, passes = 1): Uint8Array {
  let cur = Uint8Array.from(mask);
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (!cur[i]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
        next[i] =
          cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w] ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}

function any(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) return true;
  return false;
}

function downsample(
  src: Raster,
  mask: Uint8Array,
  sample: Uint8Array | undefined,
  factor: number,
): { img: Raster; mask: Uint8Array; sample: Uint8Array } {
  const w = Math.max(1, Math.ceil(src.width / factor));
  const h = Math.max(1, Math.ceil(src.height / factor));
  const img = createRaster(w, h);
  const outMask = new Uint8Array(w * h);
  // 取样区在粗层取交集：只要有一个子像素被笔刷排除，整块就不可借。
  const outSample = new Uint8Array(w * h).fill(1);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      let hole = 0;
      let canSample = 1;
      for (let dy = 0; dy < factor; dy += 1) {
        const sy = Math.min(src.height - 1, y * factor + dy);
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = Math.min(src.width - 1, x * factor + dx);
          const i = sy * src.width + sx;
          const p = i * 4;
          r += src.data[p];
          g += src.data[p + 1];
          b += src.data[p + 2];
          a += src.data[p + 3];
          hole = Math.max(hole, mask[i]);
          if (sample && !sample[i]) canSample = 0;
          n += 1;
        }
      }
      img.data[o] = r / n;
      img.data[o + 1] = g / n;
      img.data[o + 2] = b / n;
      img.data[o + 3] = a / n;
      outMask[y * w + x] = hole;
      outSample[y * w + x] = canSample;
    }
  }
  return { img, mask: outMask, sample: outSample };
}

function upsample(src: Raster, w: number, h: number): Raster {
  const out = createRaster(w, h);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const si = (sy * src.width + sx) * 4;
      out.data.set(src.data.subarray(si, si + 4), (y * w + x) * 4);
    }
  }
  return out;
}

/** 从洞边向内逐环重建，让外环已填好的像素成为内环的真实样本。 */
function onionPeel(
  cur: Raster,
  mask: Uint8Array,
  sample: Uint8Array | undefined,
  opts: InpaintOptions,
): Raster {
  const w = cur.width;
  const h = cur.height;
  const thickness = holeThickness(mask, w, h);
  const step = Math.max(1, Math.floor(thickness / 6));
  let out = cur;
  let active = mask;
  for (let pass = 0; pass < 6 && any(active); pass += 1) {
    const inner = erodeMask(active, w, h, step);
    if (!any(inner)) break;
    // sample 在进入本函数前已扣掉整个洞，外环刚填出来的像素本来就不在允许源里。
    out = inpaint(out, inner, { ...opts, sample, skipBase: true, meld: true });
    active = inner;
  }
  return out;
}

/**
 * 自动给修复画笔找源偏移：在洞边取样本，搜索哪个位移能把已知纹理对得最齐。
 * 返回 dx/dy 与平均绝对误差，纯函数，不碰画布。
 */
export function bestOffset(
  src: Raster,
  mask: Uint8Array,
  maxOffset = 32,
): { dx: number; dy: number; score: number } {
  const { width: w, height: h, data } = src;
  // 探针取洞边**已知**像素：拿洞里的待删物体去比颜色只会找到"最像那个物体"的偏移。
  // 真正要对齐的是洞周围的上下文纹理。
  const probes: number[] = [];
  const seen = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      if (!mask[i]) continue;
      for (const n of [i - 1, i + 1, i - w, i + w]) {
        if (mask[n] || seen[n]) continue;
        seen[n] = 1;
        probes.push(n);
      }
    }
  }
  if (!probes.length) return { dx: 0, dy: 0, score: Infinity };
  const stride = Math.max(1, Math.floor(probes.length / 256));
  let best: { dx: number; dy: number; score: number } = { dx: 0, dy: 0, score: Infinity };
  for (let dy = -maxOffset; dy <= maxOffset; dy += 2) {
    for (let dx = -maxOffset; dx <= maxOffset; dx += 2) {
      if (dx === 0 && dy === 0) continue;
      let sum = 0;
      let n = 0;
      for (let k = 0; k < probes.length; k += stride) {
        const i = probes[k];
        const x = i % w;
        const y = (i / w) | 0;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || mask[ny * w + nx]) continue;
        const p = i * 4;
        const q = (ny * w + nx) * 4;
        sum += Math.abs(data[p] - data[q]) + Math.abs(data[p + 1] - data[q + 1]) + Math.abs(data[p + 2] - data[q + 2]);
        n += 1;
      }
      if (n < probes.length / stride / 4) continue;
      const score = sum / n;
      if (score < best.score) best = { dx, dy, score };
    }
  }
  return best;
}

/** 完整填充：粗层定结构 → 细层 refine → 洋葱剥离收口。 */
export function completeInpaint(src: Raster, mask: Uint8Array, opts: CompleteOptions = {}): Raster {
  const w = src.width;
  const h = src.height;
  if (mask.length !== w * h) throw new Error("completeInpaint: mask size mismatch");
  if (!any(mask)) return createRaster(w, h);
  const thickness = holeThickness(mask, w, h);
  const auto = Math.min(3, Math.floor(Math.log2(Math.max(2, Math.min(thickness, Math.min(w, h))))));
  const levels = Math.max(1, Math.min(4, opts.levels ?? auto));
  const pyramid: { img: Raster; mask: Uint8Array; sample: Uint8Array; factor: number }[] = [];
  for (let i = 0; i < levels; i += 1) {
    const factor = 2 ** i;
    if (Math.ceil(w / factor) < 8 || Math.ceil(h / factor) < 8) break;
    pyramid.push({ ...downsample(src, mask, opts.sample, factor), factor });
  }
  if (!pyramid.length) {
    return inpaint(src, mask, { ...opts, meld: opts.meld ?? true });
  }

  let base: Raster | null = null;
  for (let li = pyramid.length - 1; li >= 0; li -= 1) {
    const level = pyramid[li];
    let input = level.img;
    if (base) {
      input = upsample(base, level.img.width, level.img.height);
      // 已知像素必须保留原始值，只用粗层结果覆盖洞内。
      for (let i = 0; i < level.mask.length; i += 1) {
        if (level.mask[i]) continue;
        input.data.set(level.img.data.subarray(i * 4, i * 4 + 4), i * 4);
      }
    }
    let filled = inpaint(input, level.mask, {
      patch: opts.patch,
      iterations: opts.iterations,
      search: opts.search,
      seed: opts.seed,
      sample: level.sample,
      skipBase: base !== null,
      meld: opts.meld ?? true,
    });
    if (li === 0 && (opts.onion ?? true)) filled = onionPeel(filled, level.mask, level.sample, opts);
    base = filled;
  }
  return base ?? createRaster(w, h);
}
