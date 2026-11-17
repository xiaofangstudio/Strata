/**
 * Select Subject：SLIC 超像素显著性 + GrabCut。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/segment/subject.rs), MIT / Apache-2.0。
 * Zhu et al. "Saliency Optimization from Robust Background Detection" CVPR 2014：
 * 边界连通度给背景概率，背景加权对比度给前景线索，最小二乘 + 邻域平滑求显著图；
 * 再混 Achanta 的频率调谐显著性，Otsu 阈值播 GrabCut trimap。
 * 纯函数：只吃 RGBA 字节，不碰 DOM。
 */
import { BG, FG, grabcut, PR_BG, PR_FG } from "./grabcut";
import { rgbaToLabPlanes, slicLab } from "./slic";
import type { RgbaBuffer } from "../filters/kernels";

/** Otsu 阈值（0..1，256 bin）。 */
export function otsu(values: Float32Array): number {
  const hist = new Float64Array(256);
  let total = 0;
  let sum = 0;
  for (const v of values) {
    const b = Math.min(255, Math.max(0, Math.round(v * 255)));
    hist[b] += 1;
    total += 1;
    sum += b;
  }
  if (total === 0) return 0.5;
  let wb = 0;
  let sb = 0;
  let best = -1;
  let bt = 0;
  for (let t = 0; t < 256; t += 1) {
    wb += hist[t];
    if (wb === 0) continue;
    const wf = total - wb;
    if (wf === 0) break;
    sb += t * hist[t];
    const mb = sb / wb;
    const mf = (sum - sb) / wf;
    const between = wb * wf * (mb - mf) ** 2;
    if (between > best) {
      best = between;
      bt = t;
    }
  }
  return (bt + 0.5) / 255;
}

function dist3(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 2× 盒式模糊 Lab 图（频率调谐显著性用）。 */
function blurLab(lab: Float32Array, w: number, h: number): Float32Array {
  let cur = lab.slice();
  for (let pass = 0; pass < 2; pass += 1) {
    const tmp = cur.slice();
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const li = (y * w + Math.max(0, x - 1)) * 3;
        const ci = (y * w + x) * 3;
        const ri = (y * w + Math.min(w - 1, x + 1)) * 3;
        for (let c = 0; c < 3; c += 1) tmp[ci + c] = (cur[li + c] + 2 * cur[ci + c] + cur[ri + c]) / 4;
      }
    }
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const ui = (Math.max(0, y - 1) * w + x) * 3;
        const ci = (y * w + x) * 3;
        const di = (Math.min(h - 1, y + 1) * w + x) * 3;
        for (let c = 0; c < 3; c += 1) cur[ci + c] = (tmp[ui + c] + 2 * tmp[ci + c] + tmp[di + c]) / 4;
      }
    }
  }
  return cur;
}

/** Dijkstra（超像素图，节点数约几十到几百）。 */
function dijkstra(src: number, adj: number[][], wt: (a: number, b: number) => number): Float32Array {
  const d = new Float32Array(adj.length).fill(Infinity);
  d[src] = 0;
  const done = new Uint8Array(adj.length);
  for (let iter = 0; iter < adj.length; iter += 1) {
    let u = -1;
    let bd = Infinity;
    for (let i = 0; i < d.length; i += 1) if (!done[i] && d[i] < bd) { bd = d[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (const v of adj[u]) {
      const nd = d[u] + wt(u, v);
      if (nd < d[v]) d[v] = nd;
    }
  }
  return d;
}

/** 逐像素显著性（0..1）。 */
export function saliency(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const lab = rgbaToLabPlanes(d, w, h);
  const target = Math.min(400, Math.max(16, Math.floor((w * h) / 150)));
  const sp = slicLab(lab, w, h, target, 10, 8);
  const n = sp.count;
  if (n <= 1) return new Float32Array(w * h).fill(1);

  const mean = Array.from({ length: n }, () => [0, 0, 0]);
  const pos = Array.from({ length: n }, () => [0, 0]);
  const cnt = new Float64Array(n);
  const border = new Uint8Array(n);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      const l = sp.labels[p];
      if (l < 0 || l >= n) continue;
      for (let c = 0; c < 3; c += 1) mean[l][c] += lab[p * 3 + c];
      pos[l][0] += x / w;
      pos[l][1] += y / h;
      cnt[l] += 1;
      if (x === 0 || y === 0 || x + 1 === w || y + 1 === h) border[l] = 1;
    }
  }
  for (let l = 0; l < n; l += 1) {
    const k = Math.max(1, cnt[l]);
    for (let c = 0; c < 3; c += 1) mean[l][c] /= k;
    pos[l][0] /= k;
    pos[l][1] /= k;
  }
  const dapp = (a: number, b: number) => dist3(mean[a], mean[b]);

  const adj: number[][] = Array.from({ length: n }, () => []);
  const link = (a: number, b: number) => {
    if (a === b || a < 0 || b < 0 || adj[a].includes(b)) return;
    adj[a].push(b);
    adj[b].push(a);
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const l = sp.labels[y * w + x];
      if (x + 1 < w) link(l, sp.labels[y * w + x + 1]);
      if (y + 1 < h) link(l, sp.labels[(y + 1) * w + x]);
    }
  }

  // BndCon：背景连通越强的区域，背景概率越高。
  const wbg = new Float32Array(n);
  for (let p = 0; p < n; p += 1) {
    const geo = dijkstra(p, adj, dapp);
    let area = 0;
    let len = 0;
    for (let q = 0; q < n; q += 1) {
      const s = Math.exp((-geo[q] * geo[q]) / (2 * 10 * 10));
      area += s;
      if (border[q]) len += s;
    }
    const bnd = len / Math.max(1e-6, Math.sqrt(area));
    wbg[p] = 1 - Math.exp((-bnd * bnd) / 2);
  }
  // 背景加权对比度 → 前景线索。
  const wctr = new Float32Array(n);
  for (let p = 0; p < n; p += 1) {
    let s = 0;
    for (let q = 0; q < n; q += 1) {
      const dx = pos[p][0] - pos[q][0];
      const dy = pos[p][1] - pos[q][1];
      s += dapp(p, q) * Math.exp(-(dx * dx + dy * dy) / (2 * 0.25 * 0.25)) * wbg[q];
    }
    wctr[p] = s;
  }
  const mx = Math.max(1e-6, ...Array.from(wctr));
  const wfg = Array.from(wctr, (v) => v / mx);

  // 显著图最优化：min Σ wbg s² + Σ wfg(s−1)² + Σ wij(si−sj)²（Gauss–Seidel）。
  const wij: number[][] = adj.map((ns, p) => ns.map((q) => Math.exp(-(dapp(p, q) ** 2) / 200) + 0.1));
  const s = wfg.slice();
  for (let iter = 0; iter < 200; iter += 1) {
    for (let p = 0; p < n; p += 1) {
      let num = wfg[p];
      let den = wbg[p] + wfg[p];
      for (let k = 0; k < adj[p].length; k += 1) {
        num += wij[p][k] * s[adj[p][k]];
        den += wij[p][k];
      }
      s[p] = num / Math.max(1e-6, den);
    }
  }

  const blurred = blurLab(lab, w, h);
  const meanAll = [0, 0, 0];
  for (let i = 0; i < w * h; i += 1) for (let c = 0; c < 3; c += 1) meanAll[c] += lab[i * 3 + c] / (w * h);
  const ft = new Float32Array(w * h);
  let ftMax = 1e-6;
  for (let i = 0; i < w * h; i += 1) {
    ft[i] = dist3([blurred[i * 3], blurred[i * 3 + 1], blurred[i * 3 + 2]], meanAll);
    ftMax = Math.max(ftMax, ft[i]);
  }
  const smin = Math.min(...s);
  const srange = Math.max(1e-6, Math.max(...s) - smin);
  const out = new Float32Array(w * h);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < w * h; i += 1) {
    const l = sp.labels[i];
    out[i] = 0.75 * ((s[l] - smin) / srange) + 0.25 * (ft[i] / ftMax);
    lo = Math.min(lo, out[i]);
    hi = Math.max(hi, out[i]);
  }
  const r = Math.max(1e-6, hi - lo);
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] - lo) / r;
  return out;
}

/** 连通域标号（4 邻域），sizes[0] 是背景。 */
export function components(mask: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  const queue: number[] = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || labels[i]) continue;
    const label = sizes.length;
    sizes.push(0);
    labels[i] = label;
    queue.length = 0;
    queue.push(i);
    for (let head = 0; head < queue.length; head += 1) {
      const p = queue[head];
      sizes[label] += 1;
      const x = p % w;
      const y = (p / w) | 0;
      const ns = [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1];
      for (const q of ns) if (q >= 0 && mask[q] && !labels[q]) { labels[q] = label; queue.push(q); }
    }
  }
  return { labels, sizes };
}

/** 只保留最大连通块，以及足够大且贴近它的小块（被细脖子断开的头/尾）。 */
export function keepMainAndNearby(mask: Uint8Array, w: number, h: number): Uint8Array {
  const { labels, sizes } = components(mask, w, h);
  let main = 0;
  for (let i = 1; i < sizes.length; i += 1) if (sizes[i] > sizes[main]) main = i;
  if (main === 0) return new Uint8Array(w * h);
  const bbox = Array.from({ length: sizes.length }, () => [w, h, 0, 0]);
  for (let i = 0; i < labels.length; i += 1) {
    const l = labels[i];
    if (!l) continue;
    const b = bbox[l];
    const x = i % w;
    const y = (i / w) | 0;
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }
  const [mx0, my0, mx1, my1] = bbox[main];
  const margin = Math.ceil(Math.max(mx1 - mx0 + 1, my1 - my0 + 1) * 0.15);
  const nx0 = Math.max(0, mx0 - margin);
  const ny0 = Math.max(0, my0 - margin);
  const nx1 = Math.min(w - 1, mx1 + margin);
  const ny1 = Math.min(h - 1, my1 + margin);
  const near = new Uint8Array(sizes.length);
  for (let y = ny0; y <= ny1; y += 1) {
    for (let x = nx0; x <= nx1; x += 1) near[labels[y * w + x]] = 1;
  }
  const big = Math.ceil(sizes[main] * 0.2);
  const speck = Math.max(4, Math.ceil(sizes[main] * 0.005));
  const keep = new Uint8Array(sizes.length);
  keep[main] = 1;
  for (let l = 1; l < sizes.length; l += 1) {
    if (sizes[l] >= big || (sizes[l] >= speck && near[l])) keep[l] = 1;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) out[i] = keep[labels[i]] ? 1 : 0;
  return out;
}

/** 4 邻域全被前景包围的小洞补上。 */
export function fillSmallHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = Uint8Array.from(mask);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      if (out[i]) continue;
      if (out[i - 1] && out[i + 1] && out[i - w] && out[i + w]) out[i] = 1;
    }
  }
  return out;
}

function downsample(img: RgbaBuffer, step: number): RgbaBuffer {
  const w = Math.ceil(img.width / step);
  const h = Math.ceil(img.height / step);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const from = (Math.min(img.height - 1, y * step) * img.width + Math.min(img.width - 1, x * step)) * 4;
      data.set(img.data.subarray(from, from + 4), (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

/** 显著性 + GrabCut 的主体命中表；null 表示没找到主体。 */
export function subjectSaliencyHit(d: Uint8ClampedArray, w: number, h: number): Uint8Array | null {
  if (w < 8 || h < 8) return null;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / 110000)));
  const sw = Math.ceil(w / step);
  const sh = Math.ceil(h / step);
  const small = downsample({ data: d, width: w, height: h }, step);
  const sal = saliency(small.data, sw, sh);
  const t = Math.min(0.85, Math.max(0.15, otsu(sal)));
  const trimap = new Uint8Array(sw * sh);
  let anyFg = false;
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const i = y * sw + x;
      const border = x === 0 || y === 0 || x + 1 === sw || y + 1 === sh;
      if (sal[i] >= t) {
        trimap[i] = PR_FG;
        anyFg = true;
      } else if (border || sal[i] < 0.4 * t) {
        trimap[i] = BG;
      } else {
        trimap[i] = PR_BG;
      }
    }
  }
  if (!anyFg) return null;
  const result = grabcut(small, trimap, 6);
  const raw = new Uint8Array(sw * sh);
  for (let i = 0; i < raw.length; i += 1) if (result.trimap[i] === FG || result.trimap[i] === PR_FG) raw[i] = 1;
  const fg = fillSmallHoles(keepMainAndNearby(raw, sw, sh), sw, sh);
  let count = 0;
  for (const v of fg) count += v;
  if (count < 4) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(sh - 1, Math.floor(y / step));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(sw - 1, Math.floor(x / step));
      out[y * w + x] = fg[sy * sw + sx];
    }
  }
  return out;
}
