/**
 * 批量 / 自动化操作（文件 > 脚本、文件 > 自动）。
 *
 * 全都建立在既有能力上，不新造像素通路：
 * - 删除空图层：内容外接框为空即视为空
 * - 拼合所有图层效果：对每层 bakeStyledLayer
 * - 拼合所有蒙版：对每层 applyMask
 * - 适配图像：等比缩放到指定长边
 * - 置入图像：把磁盘图当智能对象放进来（内嵌 / 链接）
 */
import { cloneSurface, createSurface, mustCtx, readPixels } from "../engine/surface";
import { contentBounds } from "../engine/warp";
import { applyMask, bakeStyledLayer } from "./layerOps";
import type { StrataDoc } from "./document";
import type { StrataLayer } from "./layer";

/** 内容全透明的图层视为空。 */
export function isEmptyLayer(layer: StrataLayer): boolean {
  if (layer.kind !== "pixel") return false;
  const b = contentBounds(layer.surface);
  return b === null;
}

/** 删除所有空像素层（至少留一层）。 */
export function deleteEmptyLayers(doc: StrataDoc): { doc: StrataDoc; removed: number } {
  const keep = doc.layers.filter((l) => !isEmptyLayer(l));
  if (keep.length === doc.layers.length) return { doc, removed: 0 };
  if (keep.length === 0) return { doc, removed: 0 };
  const active = keep.some((l) => l.id === doc.activeLayerId) ? doc.activeLayerId : keep[keep.length - 1].id;
  return { doc: { ...doc, layers: keep, activeLayerId: active, dirty: true }, removed: doc.layers.length - keep.length };
}

/** 把每一层的图层样式烘焙进像素。 */
export function flattenAllStyles(doc: StrataDoc): { doc: StrataDoc; count: number } {
  let next = doc;
  let count = 0;
  for (const l of doc.layers) {
    if (l.kind !== "pixel" || !l.styles?.length) continue;
    // bakeStyledLayer 只认活动层：逐层切活动层再烘焙
    const switched: StrataDoc = { ...next, activeLayerId: l.id };
    const baked = bakeStyledLayer(switched);
    if (baked !== switched) {
      count += 1;
      next = baked;
    }
  }
  return { doc: next, count };
}

/** 把每一层的蒙版应用到像素并移除蒙版。 */
export function flattenAllMasks(doc: StrataDoc): { doc: StrataDoc; count: number } {
  let next = doc;
  let count = 0;
  for (const l of doc.layers) {
    if (l.kind !== "pixel" || !l.mask) continue;
    const switched: StrataDoc = { ...next, activeLayerId: l.id };
    const applied = applyMask(switched);
    if (applied !== switched) {
      count += 1;
      next = applied;
    }
  }
  return { doc: next, count };
}

/** 等比缩放到「长边 = maxSide」（不放大）。 */
export function fitImage(doc: StrataDoc, maxSide: number): StrataDoc {
  const side = Math.max(1, Math.round(maxSide));
  const longest = Math.max(doc.width, doc.height);
  if (longest <= side) return doc;
  const k = side / longest;
  const w = Math.max(1, Math.round(doc.width * k));
  const h = Math.max(1, Math.round(doc.height * k));
  const layers = doc.layers.map((l) => {
    if (l.kind !== "pixel") return l;
    const s = createSurface(w, h);
    const ctx = mustCtx(s);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(l.surface, 0, 0, w, h);
    let mask = l.mask;
    if (mask) {
      const m = createSurface(w, h);
      mustCtx(m).drawImage(mask, 0, 0, w, h);
      mask = m;
    }
    return { ...l, surface: s, mask };
  });
  let selection = doc.selection;
  if (selection) {
    const m = createSurface(w, h);
    mustCtx(m).drawImage(selection, 0, 0, w, h);
    selection = m;
  }
  return { ...doc, width: w, height: h, layers, selection, dirty: true };
}

/**
 * 置入一张图当智能对象。
 * linked=true 时记下磁盘路径（链接型），否则只内嵌像素。
 */
export function placeAsSmart(
  doc: StrataDoc,
  img: HTMLCanvasElement | ImageBitmap,
  name: string,
  linkedPath?: string,
): StrataLayer {
  const surface = createSurface(doc.width, doc.height);
  const ctx = mustCtx(surface);
  const iw = "width" in img ? img.width : doc.width;
  const ih = "height" in img ? img.height : doc.height;
  // 超过画布就等比缩进来，小图保持原尺寸居中
  const k = Math.min(1, Math.min(doc.width / iw, doc.height / ih));
  const w = Math.round(iw * k);
  const h = Math.round(ih * k);
  ctx.drawImage(img as CanvasImageSource, Math.round((doc.width - w) / 2), Math.round((doc.height - h) / 2), w, h);
  return {
    id: `plc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    visible: true,
    opacity: 100,
    blend: "normal",
    locked: false,
    kind: "pixel",
    surface,
    mask: null,
    maskActive: true,
    smart: surface.toDataURL("image/png"),
    ...(linkedPath ? { smartPath: linkedPath } : {}),
  } as StrataLayer;
}

/** 把某一层的像素导出成 PNG 字节（批量导出用）。 */
export function layerPng(layer: StrataLayer): Uint8ClampedArray | null {
  if (layer.kind !== "pixel") return null;
  const img = readPixels(layer.surface);
  return img.data;
}

/** 复制一份画布（导出前裁到内容范围用）。 */
export function cropToContent(surface: HTMLCanvasElement): HTMLCanvasElement {
  const b = contentBounds(surface);
  if (!b) return cloneSurface(surface);
  const out = createSurface(Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)));
  mustCtx(out).drawImage(surface, -b.x, -b.y);
  return out;
}
