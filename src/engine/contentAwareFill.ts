/**
 * Content-Aware Fill 工作区的计划 → 预览 → 落库薄壳。
 *
 * 工作区里的三张平面在这里收口：选区是洞，用户笔刷 + 自动窗口是取样区，两者取交后
 * 作为 `sample` 传给 `completeInpaint`。预览走代理分辨率（最长边默认 640，与
 * PhotoCraft 的 PROXY_SIDE 思路一致），确定时用同一份取样平面在全分辨率重算一次，
 * 所以「窗口里看到什么、落库就是什么」，不存在只改预览不改像素的假按钮。
 */
import {
  downsampleMasks,
  maskBounds,
  samplingWindow,
  windowSamplingMask,
  restrictSampling,
  type PixelRect,
} from "../core/contentAwareSampling";
import { activeLayer, type StrataDoc } from "../core/document";
import { selectionBounds } from "../core/selection";
import { completeInpaint } from "./algos/inpaintComplete";
import { createRaster, type Raster } from "./raster";
import { cloneSurface, mustCtx } from "./surface";

export interface CafParams {
  seed: number;
  patch: number;
  iterations: number;
  search: number;
  /** 自动取样窗口在洞外扩的像素数。 */
  padding: number;
}

export const DEFAULT_CAF_PARAMS: CafParams = {
  seed: 7,
  patch: 3,
  iterations: 4,
  search: 64,
  padding: 24,
};

export interface CafPlan {
  layerId: string;
  x0: number;
  y0: number;
  rw: number;
  rh: number;
  /** rw / 文档宽；1 表示全分辨率。 */
  scale: number;
  src: Raster;
  hole: Uint8Array;
  sample: Uint8Array;
}

/** 从选区 alpha 生成全分辨率洞掩码（半透明按 128 等值线判定，和蚂蚁线一致）。 */
export function selectionToHole(doc: StrataDoc): { hole: Uint8Array; box: PixelRect } | null {
  if (!doc.selection) return null;
  const box = selectionBounds(doc.selection);
  if (!box) return null;
  const data = mustCtx(doc.selection).getImageData(0, 0, doc.width, doc.height).data;
  const hole = new Uint8Array(doc.width * doc.height);
  for (let i = 0; i < hole.length; i += 1) if (data[i * 4 + 3] >= 128) hole[i] = 1;
  return { hole, box };
}

/**
 * 自动取样区：洞外接框外扩 padding 形成窗口，扣掉洞本身。
 * 工作区的笔刷在这个基础上 Add / Subtract。
 */
export function autoSamplingMask(doc: StrataDoc, hole: Uint8Array, padding: number): Uint8Array {
  const rect = samplingWindow(hole, doc.width, doc.height, padding);
  if (!rect) return new Uint8Array(doc.width * doc.height);
  return restrictSampling(windowSamplingMask(doc.width, doc.height, rect), hole);
}

function unionRect(a: PixelRect | null, b: PixelRect | null): PixelRect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function downsampleRaster(src: Raster, nw: number, nh: number): Raster {
  const out = createRaster(nw, nh);
  for (let y = 0; y < nh; y += 1) {
    const sy0 = Math.floor((y * src.height) / nh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / nh));
    for (let x = 0; x < nw; x += 1) {
      const sx0 = Math.floor((x * src.width) / nw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / nw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const i = (Math.min(src.height - 1, sy) * src.width + Math.min(src.width - 1, sx)) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n += 1;
        }
      }
      const o = (y * nw + x) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

/**
 * 建立填充计划。`sample` 是全分辨率取样掩码；maxSide > 0 时生成代理分辨率预览计划。
 * 裁剪窗口取「洞 ∪ 取样区」再留 8px 给补丁边界，不做整图 PatchMatch。
 */
export function planCaf(doc: StrataDoc, sample: Uint8Array, maxSide = 0): CafPlan | null {
  const layer = activeLayer(doc);
  if (!layer || layer.kind !== "pixel" || layer.locked) return null;
  const picked = selectionToHole(doc);
  if (!picked) return null;
  const { hole: holeFull } = picked;

  const pad = 8;
  const holeBox = maskBounds(holeFull, doc.width, doc.height);
  const sampleBox = maskBounds(sample, doc.width, doc.height);
  const area = unionRect(holeBox, sampleBox);
  if (!area) return null;
  const x0 = Math.max(0, area.x - pad);
  const y0 = Math.max(0, area.y - pad);
  const x1 = Math.min(doc.width, area.x + area.width + pad);
  const y1 = Math.min(doc.height, area.y + area.height + pad);
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 4 || rh < 4) return null;

  const full = readRegion(layer.surface, x0, y0, rw, rh);
  let src: Raster = full;
  let hole: Uint8Array = new Uint8Array(rw * rh);
  let usable: Uint8Array = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const srcI = (y + y0) * doc.width + (x + x0);
      const dstI = y * rw + x;
      hole[dstI] = holeFull[srcI];
      usable[dstI] = sample[srcI] && !holeFull[srcI] ? 1 : 0;
    }
  }

  let scale = 1;
  if (maxSide > 0 && Math.max(rw, rh) > maxSide) {
    const k = maxSide / Math.max(rw, rh);
    const nw = Math.max(4, Math.floor(rw * k));
    const nh = Math.max(4, Math.floor(rh * k));
    src = downsampleRaster(full, nw, nh);
    const small = downsampleMasks(hole, usable, rw, rh, nw, nh);
    hole = small.hole;
    usable = small.sample;
    scale = nw / rw;
  }

  return { layerId: layer.id, x0, y0, rw, rh, scale, src, hole, sample: usable };
}

function readRegion(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): Raster {
  const data = mustCtx(canvas).getImageData(x, y, w, h).data;
  const out = createRaster(w, h);
  out.data.set(data);
  return out;
}

/** 预览与确定共用同一个内核和同一份取样平面。 */
export function computeCaf(plan: CafPlan, params: CafParams): Raster {
  return completeInpaint(plan.src, plan.hole, {
    seed: params.seed,
    patch: params.patch,
    iterations: params.iterations,
    search: params.search,
    meld: true,
    sample: plan.sample,
  });
}

/** 把结果贴回图层。只写洞内像素，洞外逐位不动；整步只进一次历史。 */
export function applyCaf(doc: StrataDoc, plan: CafPlan, filled: Raster): StrataDoc {
  const layer = doc.layers.find((l) => l.id === plan.layerId);
  if (!layer || layer.kind !== "pixel" || layer.locked) return doc;
  // 绝不把代理预览写回像素：掩码和结果都是降采样尺寸，写回会错位。
  // 调用方确定时必须用 planCaf(doc, sample) 的全分辨率计划重算一次。
  if (plan.scale !== 1 || filled.width !== plan.rw || filled.height !== plan.rh) return doc;
  const patch = filled;
  const next = cloneSurface(layer.surface);
  const ctx = mustCtx(next);
  const image = ctx.createImageData(plan.rw, plan.rh);
  for (let i = 0; i < plan.hole.length; i += 1) {
    const o = i * 4;
    image.data[o] = patch.data[o];
    image.data[o + 1] = patch.data[o + 1];
    image.data[o + 2] = patch.data[o + 2];
    // 洞外 alpha 置 0，合成时不会盖住原像素；洞内保留填充结果自己的 alpha。
    image.data[o + 3] = plan.hole[i] ? patch.data[o + 3] : 0;
  }
  ctx.putImageData(image, plan.x0, plan.y0);
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.id === layer.id ? { ...l, surface: next } : l)),
    dirty: true,
  };
}

/** 把 Raster 画成画布，供窗口内的结果预览使用。 */
export function cafPreviewCanvas(filled: Raster): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = filled.width;
  canvas.height = filled.height;
  mustCtx(canvas).putImageData(new ImageData(new Uint8ClampedArray(filled.data), filled.width, filled.height), 0, 0);
  return canvas;
}
