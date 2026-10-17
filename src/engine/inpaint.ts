/**
 * 内容识别填充内核（扩散打底 + PatchMatch 样本块合成）。
 *
 * 目标：把一块选中的像素"抹掉"，再用**图里别处的纹理**把洞补上 ——
 * 不是模糊、不是拉伸边缘，而是真的搬一块长得像的图案过来。
 *
 * 分两步，缺一不可：
 *
 *   第一步「打底」：先用扩散（Gauss–Seidel 反复求邻域平均）把洞里填成一片
 *   由边界向内过渡的平滑色。没有这一步，洞的正中央周围一个已知像素都没有，
 *   相似度无从计算，那些像素就只能原封不动留着 —— 于是"填充"完洞里还是
 *   原来那坨东西。这一步保证无论洞多大，每个像素都有个像样的起点。
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
 * 相似度里，目标侧的已知像素算满分权重，扩散打底出来的像素只算 0.35 ——
 * 后者是猜的，不该和真实像素平起平坐，但也不能当它不存在。
 *
 * 与 `liquify.ts` / `auto.ts` 一致：只认「RGBA 字节 + 宽高」，不碰画布与 DOM。
 */
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
 * 扩散打底：把洞内像素反复替换成四邻均值，直到从边界"渗"到洞心。
 * 用 Gauss–Seidel 正反两遍扫，一次横扫就能把边界信息推进一整行/列，
 * 所以轮数取「洞的最大厚度」即可，无需等到完全收敛。
 */
function diffuseBase(
  out: Raster,
  mask: Uint8Array,
  w: number,
  h: number,
  rounds: number,
): void {
  const d = out.data;
  const at = (x: number, y: number) => (y * w + x) * 4;
  for (let r = 0; r < rounds; r += 1) {
    // 正向：左上 → 右下。左邻 / 上邻必是「已知像素或本轮的更早结果」，
    // 所以一次横扫就能把边界色往洞里推进一整行。
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const l = x > 0 ? at(x - 1, y) : at(x, y);
        const u = y > 0 ? at(x, y - 1) : at(x, y);
        const o = at(x, y);
        for (let c = 0; c < 4; c += 1) {
          d[o + c] = (d[l + c] + d[u + c]) * 0.5;
        }
      }
    }
    // 反向：右下 → 左上
    for (let y = h - 1; y >= 0; y -= 1) {
      for (let x = w - 1; x >= 0; x -= 1) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const rr = x < w - 1 ? at(x + 1, y) : at(x, y);
        const dn = y < h - 1 ? at(x, y + 1) : at(x, y);
        const o = at(x, y);
        for (let c = 0; c < 4; c += 1) {
          d[o + c] = (d[o + c] + d[rr + c] + d[dn + c]) / 3;
        }
      }
    }
  }
}

/**
 * 洞内像素到最近已知像素的曼哈顿距离（BFS），返回洞的最大厚度。
 * 厚度用来决定扩散打底要扫几轮：横扫一次推进一行/列，够厚就够用。
 */
function holeThickness(
  mask: Uint8Array,
  w: number,
  h: number,
  targets: readonly number[],
): number {
  const dist = new Int32Array(w * h);
  const queue = new Int32Array(targets.length);
  let head = 0;
  let tail = 0;
  for (const i of targets) dist[i] = -1;
  // 种子：与已知像素相邻的洞像素，距离为 1
  for (const i of targets) {
    const x = i % w;
    const y = (i / w) | 0;
    const nb = [
      x > 0 ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y > 0 ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ];
    for (const n of nb) {
      if (n >= 0 && !mask[n]) {
        dist[i] = 1;
        queue[tail] = i;
        tail += 1;
        break;
      }
    }
  }
  let max = 1;
  while (head < tail) {
    const i = queue[head];
    head += 1;
    const x = i % w;
    const y = (i / w) | 0;
    const cur = dist[i];
    if (cur > max) max = cur;
    const nb = [
      x > 0 ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y > 0 ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ];
    for (const n of nb) {
      if (n < 0 || !mask[n] || dist[n] !== -1) continue;
      dist[n] = cur + 1;
      queue[tail] = n;
      tail += 1;
    }
  }
  return max;
}

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

  // ---- 第一步：扩散打底 ----
  // 轮数取「洞的最大厚度」：横扫一次推进一行/列，厚度够了就能渗到洞心。
  const thickness = holeThickness(mask, w, h, targets);
  diffuseBase(out, mask, w, h, Math.min(192, Math.max(12, thickness)));

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
        accR[ti] += sd[si] * wgt;
        accG[ti] += sd[si + 1] * wgt;
        accB[ti] += sd[si + 2] * wgt;
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
