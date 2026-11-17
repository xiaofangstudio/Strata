/**
 * GrabCut 交互式前景提取。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/segment/grabcut.rs), MIT / Apache-2.0。
 * Rother, Kolmogorov & Blake, "GrabCut: Interactive Foreground Extraction using
 * Iterated Graph Cuts", SIGGRAPH 2004：5 分量 GMM + 对比敏感平滑项 + 迭代最小割。
 */
import type { RgbaBuffer } from "../filters/kernels";
import { Gmm, subsample, type Rgb } from "./gmm";
import { BG, FG, gridMinCut, HARD_BG, HARD_FG, PR_BG, PR_FG, FREE } from "./maxflow";

export { BG, FG, PR_BG, PR_FG };

export interface GrabCutResult {
  trimap: Uint8Array;
  fg: Gmm | null;
  bg: Gmm | null;
}

function toRgbPlanes(img: RgbaBuffer): Rgb[] {
  const n = img.width * img.height;
  const out: Rgb[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    out[i] = [img.data[p] / 255, img.data[p + 1] / 255, img.data[p + 2] / 255];
  }
  return out;
}

/** 从相邻像素均方色差估对比度参数 β。 */
export function contrastBeta(img: RgbaBuffer): number {
  const { width: w, height: h, data } = img;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      for (const [nx, ny] of [[x + 1, y], [x, y + 1]]) {
        if (nx >= w || ny >= h) continue;
        const j = (ny * w + nx) * 4;
        const dr = (data[i] - data[j]) / 255;
        const dg = (data[i + 1] - data[j + 1]) / 255;
        const db = (data[i + 2] - data[j + 2]) / 255;
        sum += dr * dr + dg * dg + db * db;
        count += 1;
      }
    }
  }
  const mean = count > 0 ? sum / count : 0;
  return mean > 1e-6 ? 1 / (2 * mean) : 50;
}

/** 运行 GrabCut；trimap 中的 probable 标签原地更新为新的 probable 标签。 */
export function grabcut(img: RgbaBuffer, trimap: Uint8Array, iters = 5): GrabCutResult {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  if (trimap.length !== n) throw new Error("grabcut: trimap size mismatch");
  const planes = toRgbPlanes(img);
  const beta = contrastBeta(img);
  let fg: Gmm | null = null;
  let bg: Gmm | null = null;

  for (let iter = 0; iter < Math.max(1, iters); iter += 1) {
    const fs: Rgb[] = [];
    const bs: Rgb[] = [];
    for (let i = 0; i < n; i += 1) {
      const t = trimap[i];
      if (t === FG || t === PR_FG) fs.push(planes[i]);
      else bs.push(planes[i]);
    }
    const fSamples = subsample(fs, 40000);
    const bSamples = subsample(bs, 40000);
    fg = fg ? fg.refit(fSamples) : Gmm.fit(fSamples, 5);
    bg = bg ? bg.refit(bSamples) : Gmm.fit(bSamples, 5);
    if (!fg || !bg) break;

    const fgCost = new Float32Array(n);
    const bgCost = new Float32Array(n);
    let min = Infinity;
    for (let i = 0; i < n; i += 1) {
      const f = -fg.logLikelihood(planes[i]);
      const b = -bg.logLikelihood(planes[i]);
      fgCost[i] = f;
      bgCost[i] = b;
      if (Number.isFinite(f)) min = Math.min(min, f);
      if (Number.isFinite(b)) min = Math.min(min, b);
    }
    const offset = Number.isFinite(min) ? -min + 1 : 1;
    for (let i = 0; i < n; i += 1) {
      fgCost[i] = (Number.isFinite(fgCost[i]) ? fgCost[i] : 0) + offset;
      bgCost[i] = (Number.isFinite(bgCost[i]) ? bgCost[i] : 0) + offset;
    }

    const fixed = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      fixed[i] = trimap[i] === FG ? HARD_FG : trimap[i] === BG ? HARD_BG : FREE;
    }
    const cut = gridMinCut(w, h, {
      fgCost,
      bgCost,
      fixed,
      smooth: (a, b) => {
        const ca = planes[a];
        const cb = planes[b];
        const d2 = (ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2 + (ca[2] - cb[2]) ** 2;
        return 50 * Math.exp(-beta * d2);
      },
    });

    let changed = 0;
    for (let i = 0; i < n; i += 1) {
      if (trimap[i] !== FG && trimap[i] !== BG) {
        const next = cut[i] ? PR_FG : PR_BG;
        if (next !== trimap[i]) changed += 1;
        trimap[i] = next;
      }
    }
    if (changed * 2000 < n) break;
  }
  return { trimap, fg, bg };
}

/** 矩形对象选择：框外硬背景、框内可能前景，跑 GrabCut 后返回 0/1 掩码。 */
export function objectSelectMask(img: RgbaBuffer, rect: { x: number; y: number; width: number; height: number }): Uint8Array {
  const w = img.width;
  const h = img.height;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(w, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(h, Math.ceil(rect.y + rect.height));
  const trimap = new Uint8Array(w * h).fill(BG);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) trimap[y * w + x] = PR_FG;
  }
  const result = grabcut(img, trimap, 5);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) out[i] = result.trimap[i] === FG || result.trimap[i] === PR_FG ? 1 : 0;
  return out;
}
