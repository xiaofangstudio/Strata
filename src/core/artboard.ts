/**
 * 画板（Artboard）与切片（Slice）。
 *
 * Strata 没有「多画板文档」这种结构，所以画板做成**带边界的图层组**：
 * 组本身照旧装子层，额外带一个 `artboard: {x,y,w,h}` —— 界面按这个矩形画出
 * 画板框与名字，导出时也能按它裁切。这样既不破坏「扁平图层数组」的既有不变式，
 * 又拿到了 PS 画板的核心用途（在一份文档里划出多个交付区域）。
 *
 * 切片同理：`doc.slices` 存一组矩形，供「按切片导出」用。
 */
import { createGroupLayer, type StrataLayer } from "./layer";
import { contentBounds } from "../engine/warp";
import type { StrataDoc } from "./document";

export interface ArtboardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 该图层是不是画板（组 + 边界）。 */
export function isArtboard(layer: StrataLayer | undefined | null): boolean {
  return Boolean(layer && layer.kind === "group" && layer.artboard);
}

/**
 * 把选中图层收进一个组（多选也支持）。
 *
 * 图层栈是扁平数组、子层必须紧挨在组下面，所以这里手工排一遍：
 * 遇到第一个选中层的位置就插入「组 + 全部子层」，其余选中层跳过。
 */
export function groupSelected(doc: StrataDoc, name: string): StrataDoc {
  const ids = new Set(
    doc.selectedLayerIds?.length ? doc.selectedLayerIds : [doc.activeLayerId],
  );
  const picked = doc.layers.filter((l) => ids.has(l.id));
  if (picked.length === 0) return doc;
  const group = createGroupLayer(name);
  const firstIndex = doc.layers.findIndex((l) => ids.has(l.id));
  const out: StrataLayer[] = [];
  let inserted = false;
  for (let i = 0; i < doc.layers.length; i += 1) {
    const l = doc.layers[i];
    if (i === firstIndex) {
      out.push(group);
      for (const p of picked) out.push({ ...p, parent: group.id });
      inserted = true;
    }
    if (ids.has(l.id)) continue;
    out.push(l);
  }
  if (!inserted) return doc;
  return { ...doc, layers: out, activeLayerId: group.id, selectedLayerIds: [group.id], dirty: true };
}

/** 组的边界：子层内容外接框的并集；没有内容时退回整张画布。 */
export function boundsOfGroup(doc: StrataDoc, groupId: string): ArtboardBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of doc.layers) {
    if (l.parent !== groupId || l.kind !== "pixel") continue;
    const b = contentBounds(l.surface);
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: doc.width, h: doc.height };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** 给某个组打上画板边界（不在组上时什么也不做）。 */
export function markArtboard(doc: StrataDoc, groupId: string, box?: ArtboardBox): StrataDoc {
  const g = doc.layers.find((l) => l.id === groupId);
  if (!g || g.kind !== "group") return doc;
  const artboard = box ?? boundsOfGroup(doc, groupId);
  const layers = doc.layers.map((l) => (l.id === groupId ? { ...l, artboard } : l));
  return { ...doc, layers, dirty: true };
}

/**
 * 新建画板。
 * - fromGroup：把当前组变成画板
 * - fromLayers：把选中图层收进组并标成画板
 * - 都不是：给当前图层建一个组当画板
 */
export function newArtboard(
  doc: StrataDoc,
  mode: "blank" | "fromGroup" | "fromLayers",
): StrataDoc {
  const seq = doc.layers.filter((l) => l.kind === "group" && l.artboard).length + 1;
  const name = `画板 ${seq}`;
  if (mode === "fromGroup") {
    const cur = doc.layers.find((l) => l.id === doc.activeLayerId);
    if (cur?.kind !== "group") return doc;
    return markArtboard(doc, cur.id);
  }
  const grouped = groupSelected(doc, name);
  if (grouped === doc) return doc;
  const gid = grouped.activeLayerId;
  if (mode === "fromLayers") return markArtboard(grouped, gid);
  // blank：新建的画板默认就是整张画布的范围
  return markArtboard(grouped, gid, { x: 0, y: 0, w: grouped.width, h: grouped.height });
}

/* ------------------------------------------------------------- 切片 */

export interface SliceRect extends ArtboardBox {
  name: string;
}

/** 按当前活动图层的内容范围建立一个切片（切片的本意就是「导出这块」）。 */
export function sliceFromLayer(doc: StrataDoc): { doc: StrataDoc; slice: SliceRect } | null {
  const l = doc.layers.find((x) => x.id === doc.activeLayerId);
  if (!l || l.kind !== "pixel") return null;
  const b = contentBounds(l.surface);
  if (!b) return null;
  const slice: SliceRect = { name: l.name, x: b.x, y: b.y, w: b.w, h: b.h };
  const slices = [...(doc.slices ?? []), slice];
  return { doc: { ...doc, slices, dirty: true }, slice };
}
