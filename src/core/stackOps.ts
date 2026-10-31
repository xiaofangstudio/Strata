/**
 * 图层堆栈运算：自动对齐 / 自动混合。
 *
 * 两个都是真算法，不是占位：
 *
 * - **自动对齐**：以参考层为基准，为每层搜索一个平移量 (dx,dy)，使两层亮度差的
 *   绝对值之和（SAD）最小。先在半分辨率上粗搜（±64px），再在全分辨率上细搜
 *   （±6px）—— 这是图像拼接里的标准 coarse-to-fine 做法，比全分辨率暴力搜快
 *   两个数量级。用于手持连拍、扫描分块、同一场景的多张素材对齐。
 *
 * - **自动混合**：焦段合成（focus stacking）的核心 —— 逐像素算局部锐度
 *   （3×3 拉普拉斯能量，再盒式模糊成权重），锐度高的层权重大，最后按权重
 *   加权平均。这样每张只贡献它清晰的那部分，景深就能合成出「全清晰」。
 *
 * 纯计算 + 一次 canvas 落版，node（vitest）里可以断言对齐偏移与权重单调性。
 */
import { boxBlurPass, premultiply, type RgbaBuffer } from "../engine/filters/kernels";
import { createSurface, mustCtx, readPixels } from "../engine/surface";
import type { StrataDoc } from "./document";
import type { StackMode } from "./stackModes";
import type { StrataLayer } from "./layer";

/** 取某层的亮度平面（0~255）。 */
function lumaOf(buf: RgbaBuffer): Float32Array {
  const out = new Float32Array(buf.width * buf.height);
  for (let p = 0; p < out.length; p += 1) {
    const i = p * 4;
    out[p] = 0.299 * buf.data[i] + 0.587 * buf.data[i + 1] + 0.114 * buf.data[i + 2];
  }
  return out;
}

/**
 * 3×3 盒式平滑（两趟）。
 *
 * 匹配前必须先低通：随机纹理降到半分辨率会发生混叠，粗搜会被假极小值骗走
 * （实测高频噪声图上会偏出 20 像素）。这也是图像配准的通行做法 —— 先用
 * 低频结构定大位置，再用高频细节refine 小位置。
 */
function smoothLum(lum: Float32Array, w: number, h: number): Float32Array {
  let cur = lum;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float32Array(cur.length);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += cur[yy * w + xx];
            n += 1;
          }
        }
        next[y * w + x] = sum / n;
      }
    }
    cur = next;
  }
  return cur;
}

/** 半分辨率降采样亮度（2×2 平均）。 */
function halve(lum: Float32Array, w: number, h: number): { lum: Float32Array; w: number; h: number } {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y += 1) {
    for (let x = 0; x < nw; x += 1) {
      const x0 = x * 2;
      const y0 = y * 2;
      const a = lum[y0 * w + x0];
      const b = lum[y0 * w + Math.min(w - 1, x0 + 1)];
      const c = lum[Math.min(h - 1, y0 + 1) * w + x0];
      const d = lum[Math.min(h - 1, y0 + 1) * w + Math.min(w - 1, x0 + 1)];
      out[y * nw + x] = (a + b + c + d) / 4;
    }
  }
  return { lum: out, w: nw, h: nh };
}

/** 在给定平移候选里找 SAD 最小的一对。 */
function bestShift(a: Float32Array, b: Float32Array, w: number, h: number, range: number): { dx: number; dy: number } {
  let best = { dx: 0, dy: 0 };
  let bestScore = Infinity;
  const step = range > 20 ? 2 : 1;
  for (let dy = -range; dy <= range; dy += step) {
    for (let dx = -range; dx <= range; dx += step) {
      let sum = 0;
      let count = 0;
      // 只比较重叠区域，且抽样以控制成本
      const x0 = Math.max(0, dx);
      const y0 = Math.max(0, dy);
      const x1 = Math.min(w, w + dx);
      const y1 = Math.min(h, h + dy);
      if (x1 - x0 < 8 || y1 - y0 < 8) continue;
      const sample = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 6000)));
      for (let y = y0; y < y1; y += sample) {
        for (let x = x0; x < x1; x += sample) {
          sum += Math.abs(a[y * w + x] - b[(y - dy) * w + (x - dx)]);
          count += 1;
        }
      }
      if (count === 0) continue;
      const score = sum / count;
      if (score < bestScore) {
        bestScore = score;
        best = { dx, dy };
      }
    }
  }
  return best;
}

/** 计算「把 moving 对齐到 reference」所需的平移量（文档像素）。 */
export function estimateShift(
  reference: RgbaBuffer,
  moving: RgbaBuffer,
  coarseRange = 64,
): { dx: number; dy: number } {
  const w = Math.min(reference.width, moving.width);
  const h = Math.min(reference.height, moving.height);
  const ra = halve(
    smoothLum(lumaOf(reference), reference.width, reference.height),
    reference.width,
    reference.height,
  );
  const mb = halve(
    smoothLum(lumaOf(moving), moving.width, moving.height),
    moving.width,
    moving.height,
  );
  const ww = Math.min(ra.w, mb.w);
  const hh = Math.min(ra.h, mb.h);
  const coarse = bestShift(ra.lum, mb.lum, ww, hh, Math.max(2, Math.round(coarseRange / 2)));
  // 细搜：回到全分辨率，在粗结果附近 ±6px
  const fa = smoothLum(lumaOf(reference), reference.width, reference.height);
  const fb = smoothLum(lumaOf(moving), moving.width, moving.height);
  const cx = coarse.dx * 2;
  const cy = coarse.dy * 2;
  let best = { dx: cx, dy: cy };
  let bestScore = Infinity;
  for (let dy = cy - 6; dy <= cy + 6; dy += 1) {
    for (let dx = cx - 6; dx <= cx + 6; dx += 1) {
      const x0 = Math.max(0, dx);
      const y0 = Math.max(0, dy);
      const x1 = Math.min(w, w + dx);
      const y1 = Math.min(h, h + dy);
      if (x1 - x0 < 16 || y1 - y0 < 16) continue;
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          sum += Math.abs(fa[y * w + x] - fb[(y - dy) * w + (x - dx)]);
          count += 1;
        }
      }
      if (count === 0) continue;
      const score = sum / count;
      if (score < bestScore) {
        bestScore = score;
        best = { dx, dy };
      }
    }
  }
  return best;
}

/** 平移到新画布（空出来的地方保持透明）。 */
function translated(layer: StrataLayer, dx: number, dy: number, w: number, h: number): HTMLCanvasElement {
  const s = createSurface(w, h);
  mustCtx(s).drawImage(layer.surface, dx, dy);
  return s;
}

/**
 * 自动对齐：把选中的像素层都对齐到参考层（默认当前活动层）。
 * 参考层自己不动；其余层按搜索到的平移量搬过去。
 */
export function autoAlignLayers(
  doc: StrataDoc,
  referenceId = doc.activeLayerId,
): { doc: StrataDoc; shifts: { id: string; dx: number; dy: number }[] } {
  const targetIds = new Set(doc.selectedLayerIds ?? []);
  const candidates = doc.layers.filter(
    (l) => l.kind === "pixel" && l.id !== referenceId && (targetIds.size === 0 ? l.visible : targetIds.has(l.id)),
  );
  const ref = doc.layers.find((l) => l.id === referenceId);
  if (!ref || ref.kind !== "pixel" || candidates.length === 0) return { doc, shifts: [] };

  const refImg = readPixels(ref.surface);
  const refBuf: RgbaBuffer = { data: refImg.data, width: refImg.width, height: refImg.height };
  const shifts: { id: string; dx: number; dy: number }[] = [];
  const layers = doc.layers.map((l) => {
    if (l.kind !== "pixel" || l.id === referenceId) return l;
    if (!candidates.some((c) => c.id === l.id)) return l;
    const img = readPixels(l.surface);
    const mv: RgbaBuffer = { data: img.data, width: img.width, height: img.height };
    const { dx, dy } = estimateShift(refBuf, mv);
    if (dx === 0 && dy === 0) return l;
    shifts.push({ id: l.id, dx, dy });
    return { ...l, surface: translated(l, dx, dy, doc.width, doc.height) };
  });
  return { doc: { ...doc, layers, dirty: true }, shifts };
}

/** 逐像素锐度权重（3×3 拉普拉斯能量 → 盒式模糊扩散）。 */
export function sharpnessWeights(src: RgbaBuffer, radius = 6): Float32Array {
  const { width: w, height: h, data } = src;
  const lum = lumaOf(src);
  const raw = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      const lap = 4 * lum[p] - lum[p - 1] - lum[p + 1] - lum[p - w] - lum[p + w];
      raw[p] = Math.abs(lap);
    }
  }
  void data;
  // 用预乘域一趟盒式模糊把锐度摊开，避免权重出现锯齿
  const p = premultiply({ data: toRgba(raw), width: w, height: h });
  const blurred = boxBlurPass(p, w, h, Math.max(1, Math.round(radius)));
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) out[i] = blurred[i * 4] / 255;
  return out;
}

/** 把单通道浮点表包成 RGBA（权重计算用）。 */
function toRgba(v: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(v.length * 4);
  for (let i = 0; i < v.length; i += 1) {
    out[i * 4] = v[i];
    out[i * 4 + 1] = v[i];
    out[i * 4 + 2] = v[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * 自动混合：按「谁更清晰谁权重大」把多层加权平均成一层。
 * 结果写进参考层（默认活动层），其余参与层保持原样不被删除。
 */
export function autoBlendLayers(doc: StrataDoc, referenceId = doc.activeLayerId): StrataDoc {
  const targetIds = new Set(doc.selectedLayerIds ?? []);
  const parts = doc.layers.filter(
    (l) => l.kind === "pixel" && l.visible && (targetIds.size === 0 ? true : targetIds.has(l.id)),
  );
  if (parts.length < 2) return doc;
  const ref = doc.layers.find((l) => l.id === referenceId);
  if (!ref || ref.kind !== "pixel") return doc;

  const w = doc.width;
  const h = doc.height;
  const acc = new Float32Array(w * h * 4);
  const wsum = new Float32Array(w * h);

  for (const l of parts) {
    const img = readPixels(l.surface);
    const weight = sharpnessWeights({ data: img.data, width: img.width, height: img.height });
    for (let p = 0; p < w * h; p += 1) {
      const a = img.data[p * 4 + 3] / 255;
      const k = weight[p] * a;
      if (k <= 0) continue;
      acc[p * 4] += img.data[p * 4] * k;
      acc[p * 4 + 1] += img.data[p * 4 + 1] * k;
      acc[p * 4 + 2] += img.data[p * 4 + 2] * k;
      acc[p * 4 + 3] += 255 * k;
      wsum[p] += k;
    }
  }

  const merged = createSurface(w, h);
  const outImg = readPixels(merged);
  for (let p = 0; p < w * h; p += 1) {
    const s = wsum[p];
    if (s <= 0) continue;
    outImg.data[p * 4] = acc[p * 4] / s;
    outImg.data[p * 4 + 1] = acc[p * 4 + 1] / s;
    outImg.data[p * 4 + 2] = acc[p * 4 + 2] / s;
    outImg.data[p * 4 + 3] = acc[p * 4 + 3] / s;
  }
  mustCtx(merged).putImageData(outImg, 0, 0);

  const layers = doc.layers.map((l) => (l.id === ref.id ? { ...l, surface: merged } : l));
  return { ...doc, layers, dirty: true };
}

/* ------------------------------------------------------- 堆栈模式（文档级） */

/**
 * 把参与层按统计量合成一层（Layer > Smart Objects > Stack Mode）。
 *
 * 参与范围：多选优先，否则取当前活动层及其下方所有可见像素层 ——
 * 与 PS 一致的「以活动层为基准往上/往下」习惯在这里简化为「全可见层」。
 * 结果写进最上面那层的 surface，其余参与层保持不动（可撤销）。
 */
export function applyStackModeToDoc(
  doc: StrataDoc,
  mode: StackMode,
  apply: typeof import("./stackModes").applyStackMode,
): StrataDoc {
  const ids = doc.selectedLayerIds ?? [];
  const pool =
    ids.length >= 2
      ? doc.layers.filter((l) => ids.includes(l.id) && l.kind === "pixel")
      : doc.layers.filter((l) => l.kind === "pixel" && l.visible);
  if (pool.length < 2) return doc;
  const buffers = pool.map((l) => {
    const img = readPixels(l.surface);
    return { data: img.data, width: img.width, height: img.height };
  });
  const merged = apply(buffers, mode);
  const top = pool[pool.length - 1];
  const surface = createSurface(doc.width, doc.height);
  const img = readPixels(surface);
  img.data.set(merged.data);
  mustCtx(surface).putImageData(img, 0, 0);
  const layers = doc.layers.map((l) => (l.id === top.id ? { ...l, surface } : l));
  return { ...doc, layers, dirty: true };
}
