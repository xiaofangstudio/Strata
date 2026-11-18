/**
 * 基于特征的图层对齐：Harris 角点 + BRIEF + RANSAC 求相似变换，
 * 把移动层旋转 / 缩放 / 平移到参考层。
 *
 * 与 core/stackOps 的 SAD 平移对齐互补：那个只能求 (dx,dy)，
 * 这个能处理手持拍摄的旋转与轻微变焦 —— 全景拼接与连拍对齐的正确地基。
 *
 * 性能：在 ≤320px 的降采样图上做配准（角点 ≤80、RANSAC ≤80 次），
 * 再把求得的变换按原图比例放大应用到全分辨率图层。纯计算部分在
 * engine/algos/features.ts，可单测；这里只负责降采样与 canvas 落版。
 */
import { readPixels, createSurface, mustCtx } from "../engine/surface";
import type { StrataDoc } from "./document";
import type { StrataLayer } from "./layer";
import {
  harris,
  describe as describeBrief,
  matchDescriptors,
  ransac,
  type Pt2,
  type Homography,
} from "../engine/algos/features";
import type { RgbaBuffer } from "../engine/filters/kernels";

/** 亮度平面（0..1），从 RGBA 降采样到 sw×sh。 */
function lumaDownsample(img: RgbaBuffer, sw: number, sh: number): Float32Array {
  const out = new Float32Array(sw * sh);
  const kx = img.width / sw;
  const ky = img.height / sh;
  for (let y = 0; y < sh; y += 1) {
    const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * ky));
    for (let x = 0; x < sw; x += 1) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * kx));
      const i = (sy * img.width + sx) * 4;
      out[y * sw + x] = (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) / 255;
    }
  }
  return out;
}

export interface FeatureAlignResult {
  /** 相似变换（移动图坐标 → 参考图坐标，原图像素尺度）：移动图的特征点在参考系里的位置。 */
  h: Homography;
  inliers: number;
  /** 降采样比例（原图 px / 工作图 px）。 */
  scale: number;
}

/**
 * 在两张同尺寸 RGBA 图上求「移动图 → 参考图」的相似变换。
 * 返回的 h 把移动图坐标映到参考图坐标；把它作为绘制变换即可校正移动图。
 * 求不出（角点不足 / 内点太少）返回 null。
 */
export function estimateFeatureTransform(
  reference: RgbaBuffer,
  moving: RgbaBuffer,
): FeatureAlignResult | null {
  if (reference.width !== moving.width || reference.height !== moving.height) return null;
  const scale = Math.max(1, Math.max(reference.width, reference.height) / 320);
  const sw = Math.max(64, Math.round(reference.width / scale));
  const sh = Math.max(64, Math.round(reference.height / scale));
  const ref = lumaDownsample(reference, sw, sh);
  const mov = lumaDownsample(moving, sw, sh);
  const maxCorners = 80;
  const minDist = Math.min(16, Math.max(4, Math.max(sw, sh) / 40));
  const ca = harris(sw, sh, ref, maxCorners, minDist);
  const cb = harris(sw, sh, mov, maxCorners, minDist);
  if (ca.length < 6 || cb.length < 6) return null;
  const da = describeBrief(sw, sh, ref, ca, true);
  const db = describeBrief(sw, sh, mov, cb, true);
  const matches = matchDescriptors(db, da, 0.85);
  if (matches.length < 6) return null;
  const src: Pt2[] = matches.map(([i]) => [cb[i].x, cb[i].y]);
  const dst: Pt2[] = matches.map(([, j]) => [ca[j].x, ca[j].y]);
  const threshold = Math.min(3, Math.max(1.5, Math.max(sw, sh) / 160));
  const r = ransac("similarity", src, dst, 80, threshold, 7);
  if (!r || r.inliers.length < 6) return null;
  // r.model 把移动图坐标映到参考图坐标；按 scale 放大平移项回原图尺度
  const [a, b, tx, , , ty] = r.model;
  const full: Homography = [a, b, tx * scale, -b, a, ty * scale, 0, 0, 1];
  return { h: full, inliers: r.inliers.length, scale };
}

/** 把相似变换 [a,-b,tx; b,a,ty] 应用到图层 surface（画布坐标）。
 * canvas 的 transform(m11,m12,m21,m22,dx,dy)：x'=m11·x+m21·y+dx，y'=m12·x+m22·y+dy，
 * 与 h 的 [h0,h1,h2; h3,h4,h5] 对应关系是 transform(h0, h3, h1, h4, h2, h5)。 */
export function applySimilarityToLayer(
  layer: StrataLayer,
  h: Homography,
  w: number,
  hgt: number,
): HTMLCanvasElement {
  const out = createSurface(w, hgt);
  const ctx = mustCtx(out);
  const [h0, h1, h2, h3, h4, h5] = h;
  ctx.save();
  ctx.transform(h0, h3, h1, h4, h2, h5);
  ctx.drawImage(layer.surface, 0, 0);
  ctx.restore();
  return out;
}

/** 文档级：把选中（或全部可见）像素层用特征配准到参考层。 */
export function alignLayersByFeatures(
  doc: StrataDoc,
  referenceId = doc.activeLayerId,
): { doc: StrataDoc; transforms: { id: string; inliers: number }[] } {
  const targetIds = new Set(doc.selectedLayerIds ?? []);
  const candidates = doc.layers.filter(
    (l) => l.kind === "pixel" && l.id !== referenceId && (targetIds.size === 0 ? l.visible : targetIds.has(l.id)),
  );
  const ref = doc.layers.find((l) => l.id === referenceId);
  if (!ref || ref.kind !== "pixel" || candidates.length === 0) return { doc, transforms: [] };
  const refImg = readPixels(ref.surface);
  const refBuf: RgbaBuffer = { data: refImg.data, width: refImg.width, height: refImg.height };
  const transforms: { id: string; inliers: number }[] = [];
  const layers = doc.layers.map((l) => {
    if (l.kind !== "pixel" || l.id === referenceId) return l;
    if (!candidates.some((c) => c.id === l.id)) return l;
    const img = readPixels(l.surface);
    const mv: RgbaBuffer = { data: img.data, width: img.width, height: img.height };
    const res = estimateFeatureTransform(refBuf, mv);
    if (!res) return l;
    transforms.push({ id: l.id, inliers: res.inliers });
    // res.h 把移动图映到参考图，正是要应用的校正
    return { ...l, surface: applySimilarityToLayer(l, res.h, doc.width, doc.height) };
  });
  return { doc: { ...doc, layers, dirty: true }, transforms };
}
