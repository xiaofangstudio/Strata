/**
 * 全景输出融合：最小代价接缝 + 拉普拉斯金字塔多频段混合。
 *
 * 移植自 PhotoCraft `crates/algo/src/panorama/blend.rs`（MIT / Apache-2.0）。
 * 算法出处：
 * - 接缝：A. Shamir, S. Avidan, *Seam Carving for Content-Aware Image Resizing*, SIGGRAPH 2007
 *   —— 在重叠区跑最小代价路径（代价 = 颜色差异），让接缝绕开视差/移动物体。
 * - 多频段：P. Burt, E. Adelson, *A Multiresolution Spline with Application to Image Mosaics*,
 *   ACM TOG 1983 —— 金字塔逐层混合，低频大范围过渡、高频局部细节，接缝不可见。
 *
 * 全部为纯函数：只吃 Float32Array / 数字，不碰 DOM、不碰 canvas。
 * 颜色在 0..1 线性尺度，ch 通道逐像素交错存储（RGB 或 RGBA 由调用方决定）。
 */

/** 金字塔层数：短边降到 ≤16 为止，最多 7 层。 */
export function blendLevels(w: number, h: number): number {
  let s = Math.min(w, h);
  let n = 1;
  while (s > 16 && n < 7) {
    s = Math.floor(s / 2);
    n += 1;
  }
  return n;
}

/**
 * 5-tap 二项核 [1,4,6,4,1]/16 可分离降采样（边缘夹取），输出 ceil(w/2)×ceil(h/2)。
 * src 布局为 (w*h) 个像素 × ch 通道交错。
 */
export function reducePlane(
  w: number,
  h: number,
  ch: number,
  src: Float32Array,
): { w: number; h: number; data: Float32Array } {
  const nw = Math.ceil(w / 2);
  const nh = Math.ceil(h / 2);
  const k = [1, 4, 6, 4, 1];
  // 列索引只依赖 x 与 w，预计算一次；避免在每行每列反复分配 5 元数组（实测提速一个数量级）
  const xsCache = new Int32Array(nw * 5);
  for (let x = 0; x < nw; x += 1) {
    for (let t = 0; t < 5; t += 1) {
      xsCache[x * 5 + t] = Math.min(w - 1, Math.max(0, 2 * x + t - 2)) * ch;
    }
  }
  const tmp = new Float32Array(nw * h * ch);
  // 水平：每行对每个输出列取 5 个夹取源列
  for (let y = 0; y < h; y += 1) {
    const base = y * w * ch;
    const rowOut = y * nw * ch;
    for (let x = 0; x < nw; x += 1) {
      const xs = x * 5;
      for (let c = 0; c < ch; c += 1) {
        let s = 0;
        for (let t = 0; t < 5; t += 1) s += k[t] * src[base + xsCache[xs + t] + c];
        tmp[rowOut + x * ch + c] = s / 16;
      }
    }
  }
  // 垂直：对每行累加 5 行（与参考实现同样的 tap 顺序，结果逐位一致）
  const out = new Float32Array(nw * nh * ch);
  for (let y = 0; y < nh; y += 1) {
    const rowOut = y * nw * ch;
    for (let t = 0; t < 5; t += 1) {
      const yy = Math.min(h - 1, Math.max(0, 2 * y + t - 2));
      const rowIn = yy * nw * ch;
      for (let i = 0; i < nw * ch; i += 1) out[rowOut + i] += k[t] * tmp[rowIn + i];
    }
    for (let i = 0; i < nw * ch; i += 1) out[rowOut + i] /= 16;
  }
  return { w: nw, h: nh, data: out };
}

/** 双线性上采样（半像素对齐），从 sw×sh 放到 w×h。 */
export function expandPlane(
  sw: number,
  sh: number,
  ch: number,
  src: Float32Array,
  w: number,
  h: number,
): Float32Array {
  const out = new Float32Array(w * h * ch);
  const cols: [number, number, number][] = [];
  for (let x = 0; x < w; x += 1) {
    const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
    const x0 = Math.floor(fx);
    cols.push([x0 * ch, Math.min(sw - 1, x0 + 1) * ch, fx - x0]);
  }
  for (let y = 0; y < h; y += 1) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const y1 = Math.min(sh - 1, y0 + 1);
    const r0 = y0 * sw * ch;
    const r1 = y1 * sw * ch;
    const row = y * w * ch;
    for (let x = 0; x < w; x += 1) {
      const [x0, x1, tx] = cols[x];
      for (let c = 0; c < ch; c += 1) {
        const top = src[r0 + x0 + c] + (src[r0 + x1 + c] - src[r0 + x0 + c]) * tx;
        const bot = src[r1 + x0 + c] + (src[r1 + x1 + c] - src[r1 + x0 + c]) * tx;
        out[row + x * ch + c] = top + (bot - top) * ty;
      }
    }
  }
  return out;
}

/**
 * Push-pull：用权重有效区域的颜色填充权重为 0 的洞，
 * 防止金字塔层把图像外的黑色拉进接缝附近。原地修改 px。
 */
export function pushPull(
  w: number,
  h: number,
  ch: number,
  px: Float32Array,
  wt: Float32Array,
): void {
  if (w <= 1 && h <= 1) return;
  const nw = Math.ceil(w / 2);
  const nh = Math.ceil(h / 2);
  const cw = new Float32Array(nw * nh);
  const cpx = new Float32Array(nw * nh * ch);
  for (let cy = 0; cy < nh; cy += 1) {
    for (let y = 2 * cy; y < Math.min(2 * cy + 2, h); y += 1) {
      for (let x = 0; x < w; x += 1) cw[cy * nw + Math.floor(x / 2)] += wt[y * w + x];
    }
  }
  for (let cy = 0; cy < nh; cy += 1) {
    for (let y = 2 * cy; y < Math.min(2 * cy + 2, h); y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        const j = Math.floor(x / 2);
        const a = wt[i];
        for (let c = 0; c < ch; c += 1) cpx[(cy * nw + j) * ch + c] += a * px[i * ch + c];
      }
    }
  }
  for (let j = 0; j < nw * nh; j += 1) {
    if (cw[j] > 0) for (let c = 0; c < ch; c += 1) cpx[j * ch + c] /= cw[j];
  }
  const cw2 = cw.map((v) => (v > 0 ? 1 : 0));
  if (cw2.includes(0) && cw2.some((v) => v > 0)) pushPull(nw, nh, ch, cpx, cw2);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (wt[i] >= 1) continue;
      const j = Math.floor(y / 2) * nw + Math.floor(x / 2);
      const a = wt[i];
      for (let c = 0; c < ch; c += 1) {
        px[i * ch + c] = a * px[i * ch + c] + (1 - a) * cpx[j * ch + c];
      }
    }
  }
}

/** 一张图被 warp 到全景画布后的轴对齐区域，颜色 ch 通道 + coverage 0..1。 */
export interface RoiImage {
  x0: number;
  y0: number;
  w: number;
  h: number;
  ch: number;
  /** 长度 w*h*ch，0..1 */
  px: Float32Array;
  /** 长度 w*h，0..1 */
  alpha: Float32Array;
}

/**
 * 最小代价接缝标签：图像按 order 依次加入，每张新图通过重叠区里代价最低的路径
 * （代价 = 它与已有合成图的颜色差）取得自己那一侧的重叠像素。
 * luma[i] / cover[i] 是 i 号图在全画布 w×h 上的灰度(0..1)/覆盖布尔。
 * 返回每像素归属的图像索引，-1 = 无图覆盖。
 */
export function seamLabels(
  w: number,
  h: number,
  luma: Float32Array[],
  cover: Uint8Array[],
  order: number[],
): Int32Array {
  const label = new Int32Array(w * h).fill(-1);
  for (const img of order) {
    const cov = cover[img];
    const overlap = new Uint8Array(w * h);
    let sx = 0, sy = 0, no = 0, nx = 0, ny = 0, nn = 0;
    for (let i = 0; i < w * h; i += 1) {
      if (!cov[i]) continue;
      nx += i % w;
      ny += Math.floor(i / w);
      nn += 1;
      if (label[i] >= 0) {
        overlap[i] = 1;
        sx += i % w;
        sy += Math.floor(i / w);
        no += 1;
      } else {
        label[i] = img;
      }
    }
    if (no === 0) continue;
    const cx = nx / nn;
    const cy = ny / nn;
    const contained = nn === no;
    let ox: number, oy: number;
    if (contained) {
      // 整张图完全落在已有合成图内：取它相对合成图重心的方向作为「它那一侧」
      let px = 0, py = 0, pn = 0;
      for (let i = 0; i < w * h; i += 1) {
        if (label[i] >= 0) {
          px += i % w;
          py += Math.floor(i / w);
          pn += 1;
        }
      }
      px /= Math.max(1, pn);
      py /= Math.max(1, pn);
      if (Math.abs(cx - px) < 0.5 && Math.abs(cy - py) < 0.5) continue;
      ox = px;
      oy = py;
    } else {
      ox = sx / no;
      oy = sy / no;
    }
    const vertical = Math.abs(cx - ox) >= Math.abs(cy - oy);
    const positive = vertical ? cx > ox : cy > oy;
    const preferHigh = contained && !positive;
    const cost = (i: number) => 0.002 + Math.abs(luma[img][i] - luma[label[i]][i]);
    const lines = vertical ? h : w;
    const len = vertical ? w : h;
    const idx = (line: number, k: number) => (vertical ? line * w + k : k * w + line);
    const acc = new Float32Array(w * h).fill(Infinity);
    const from = new Int32Array(w * h).fill(-1);
    let prevLine = -1;
    for (let line = 0; line < lines; line += 1) {
      let any = false;
      for (let k2 = 0; k2 < len; k2 += 1) if (overlap[idx(line, k2)]) { any = true; break; }
      if (!any) continue;
      for (let k2 = 0; k2 < len; k2 += 1) {
        const i = idx(line, k2);
        if (!overlap[i]) continue;
        let best = 0;
        let bestFrom = -1;
        if (prevLine === line - 1) {
          best = Infinity;
          const dks = preferHigh ? [1, 0, -1] : [-1, 0, 1];
          for (const dk of dks) {
            const kk = k2 + dk;
            if (kk < 0 || kk >= len) continue;
            const j = idx(prevLine, kk);
            if (acc[j] < best) { best = acc[j]; bestFrom = kk; }
          }
          if (bestFrom === -1) { best = 0; bestFrom = -1; }
        }
        acc[i] = best + cost(i);
        from[i] = bestFrom;
      }
      prevLine = line;
    }
    // 回溯：每行从代价最小的端点往回走
    const seam = new Int32Array(lines).fill(-1);
    for (let line = lines; line > 0; line -= 1) {
      const li = line - 1;
      if (seam[li] !== -1) continue;
      let bestK = -1;
      let bestVal = Infinity;
      for (let k2 = 0; k2 < len; k2 += 1) {
        const i = idx(li, k2);
        if (!overlap[i]) continue;
        const v = acc[i];
        if (v < bestVal || (v === bestVal && (preferHigh ? k2 > bestK : k2 < bestK))) {
          bestVal = v;
          bestK = k2;
        }
      }
      if (bestK === -1) continue;
      let l = li;
      let k2 = bestK;
      for (;;) {
        seam[l] = k2;
        const f = from[idx(l, k2)];
        if (f === -1 || l === 0) break;
        l -= 1;
        if (seam[l] !== -1) break;
        k2 = f;
      }
    }
    for (let line = 0; line < lines; line += 1) {
      const s = seam[line];
      if (s === -1) continue;
      const onSide = (k2: number) => (positive ? k2 > s : k2 < s);
      let hasSide = false;
      for (let k2 = 0; k2 < len; k2 += 1) {
        if (overlap[idx(line, k2)] && onSide(k2)) { hasSide = true; break; }
      }
      const takeSeam = contained && !hasSide;
      for (let k2 = 0; k2 < len; k2 += 1) {
        const i = idx(line, k2);
        if (overlap[i] && (onSide(k2) || (takeSeam && k2 === s))) label[i] = img;
      }
    }
  }
  return label;
}

/**
 * 拉普拉斯金字塔多频段融合。imgs[i] 是已 warp 到全景图局部区域的图，
 * weights[i] 与 imgs[i].px 同网格（每像素权重，通常来自 seamLabels）。
 * 返回全景颜色（w*h*ch，0..1）与总覆盖（w*h，0..1）。
 */
export function multiband(
  w: number,
  h: number,
  imgs: RoiImage[],
  weights: Float32Array[],
  levels = blendLevels(w, h),
): { color: Float32Array; coverage: Float32Array } {
  const ch = imgs[0]?.ch ?? 1;
  const L = Math.max(1, Math.min(16, levels));
  const sizes: [number, number][] = [[w, h]];
  for (let l = 1; l < L; l += 1) {
    const [pw, ph] = sizes[sizes.length - 1];
    sizes.push([Math.ceil(pw / 2), Math.ceil(ph / 2)]);
  }
  const acc = sizes.map(([lw, lh]) => new Float32Array(lw * lh * ch));
  const wsum = sizes.map(([lw, lh]) => new Float32Array(lw * lh));

  for (let k = 0; k < imgs.length; k += 1) {
    const im = imgs[k];
    const align = 1 << (L - 1);
    const margin = align * 4;
    const gx0 = Math.max(0, Math.floor((im.x0 - margin) / align) * align);
    const gy0 = Math.max(0, Math.floor((im.y0 - margin) / align) * align);
    const gx1 = Math.min(w, im.x0 + im.w + margin);
    const gy1 = Math.min(h, im.y0 + im.h + margin);
    const gw = Math.max(1, gx1 - gx0);
    const gh = Math.max(1, gy1 - gy0);

    let px = new Float32Array(gw * gh * ch);
    let wt = new Float32Array(gw * gh);
    const bin = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy += 1) {
      for (let gx = 0; gx < gw; gx += 1) {
        const x = gx + gx0 - im.x0;
        const y = gy + gy0 - im.y0;
        if (x < 0 || y < 0 || x >= im.w || y >= im.h) continue;
        const i = y * im.w + x;
        for (let c = 0; c < ch; c += 1) px[(gy * gw + gx) * ch + c] = im.px[i * ch + c];
        wt[gy * gw + gx] = weights[k][i] * Math.min(1, im.alpha[i]);
        bin[gy * gw + gx] = im.alpha[i] > 0.5 ? 1 : 0;
      }
    }
    pushPull(gw, gh, ch, px, bin);

    // 拉普拉斯（颜色）/ 高斯（权重）金字塔
    const lap: { w: number; h: number; data: Float32Array }[] = [];
    const gau: Float32Array[] = [];
    let cw = gw;
    let chh = gh;
    let cur: Float32Array = px;
    let cwt: Float32Array = wt;
    for (let l = 0; l < L; l += 1) {
      if (l + 1 === L) {
        lap.push({ w: cw, h: chh, data: cur });
        gau.push(cwt);
        break;
      }
      const down = reducePlane(cw, chh, ch, cur);
      const up = expandPlane(down.w, down.h, ch, down.data, cw, chh);
      for (let i = 0; i < cur.length; i += 1) cur[i] -= up[i];
      lap.push({ w: cw, h: chh, data: cur });
      const wdown = reducePlane(cw, chh, 1, cwt);
      gau.push(cwt);
      cw = down.w;
      chh = down.h;
      cur = down.data;
      cwt = wdown.data;
    }

    // 逐层累加（按图像顺序，故结果与图像加入顺序有关，符合参考实现）
    for (let l = 0; l < L; l += 1) {
      const [pw, ph] = sizes[l];
      const ox = gx0 >> l;
      const oy = gy0 >> l;
      const band = lap[l];
      const g = gau[l];
      for (let py = 0; py < ph; py += 1) {
        const y = py - oy;
        if (y < 0 || y >= band.h) continue;
        const rowW = y * band.w;
        const rowA = py * pw;
        for (let x2 = 0; x2 < band.w; x2 += 1) {
          const px2 = ox + x2;
          if (px2 >= pw) break;
          const k2 = g[rowW + x2];
          if (k2 <= 0) continue;
          wsum[l][rowA + px2] += k2;
          const from = (rowW + x2) * ch;
          const to = (rowA + px2) * ch;
          for (let c = 0; c < ch; c += 1) acc[l][to + c] += k2 * band.data[from + c];
        }
      }
    }
  }

  // 归一化 + 由粗到细折叠
  for (let l = 0; l < L; l += 1) {
    const [pw] = sizes[l];
    for (let i = 0; i < pw * sizes[l][1]; i += 1) {
      const k2 = wsum[l][i];
      if (k2 <= 1e-8) continue;
      for (let c = 0; c < ch; c += 1) acc[l][i * ch + c] /= k2;
    }
  }
  let cur = acc[L - 1];
  for (let l = L - 2; l >= 0; l -= 1) {
    const [pw, ph] = sizes[l];
    const [sw, sh] = sizes[l + 1];
    const up = expandPlane(sw, sh, ch, cur, pw, ph);
    for (let i = 0; i < pw * ph * ch; i += 1) acc[l][i] += up[i];
    cur = acc[l];
  }

  // 覆盖 = 各图 alpha 的并集
  const coverage = new Float32Array(w * h);
  for (const im of imgs) {
    for (let y = 0; y < im.h; y += 1) {
      const py = im.y0 + y;
      if (py < 0 || py >= h) continue;
      for (let x = 0; x < im.w; x += 1) {
        const px = im.x0 + x;
        if (px < 0 || px >= w) continue;
        const i = py * w + px;
        coverage[i] = Math.max(coverage[i], im.alpha[y * im.w + x]);
      }
    }
  }
  return { color: cur, coverage };
}
