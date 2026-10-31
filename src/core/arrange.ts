/**
 * 图层对齐与分布。
 *
 * 图层画布恒等于文档尺寸，所以「图层位置」不是坐标属性，而是**内容在外接框里的
 * 位置**。对齐 = 把每个图层的内容平移到目标外接框对齐；分布 = 按内容位置排序后
 * 均匀铺开。多选图层（doc.selectedLayerIds）一起处理，只选一层时以画布为基准。
 *
 * 纯几何 + canvas 落版，与 layerOps 的 translateLayer 同一套路，
 * 但按 id 批量处理（translateLayer 只认活动图层）。
 */
import { createSurface, mustCtx } from "../engine/surface";
import { contentBounds, type Bounds } from "../engine/warp";
import type { StrataDoc } from "./document";
import type { StrataLayer } from "./layer";

export type AlignEdge = "top" | "verticalCenters" | "bottom" | "left" | "horizontalCenters" | "right";

/** 参与排列的像素层：有 surface、未锁定、未被组隐藏。 */
function targets(doc: StrataDoc): StrataLayer[] {
  const ids = new Set(doc.selectedLayerIds ?? []);
  const pool =
    ids.size > 1
      ? doc.layers.filter((l) => ids.has(l.id) && l.kind !== "adjust")
      : doc.layers.filter((l) => l.id === doc.activeLayerId && l.kind !== "adjust");
  return pool.filter((l) => l.kind === "pixel" || l.kind === "group");
}

/** 每个目标层的可见内容外接框（组按整棵子树的内容合起来算）。 */
function boundsOf(doc: StrataDoc, layer: StrataLayer): Bounds | null {
  if (layer.kind === "group") {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const l of doc.layers) {
      if (l.parent !== layer.id || l.kind !== "pixel") continue;
      const b = contentBounds(l.surface);
      if (!b) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    if (!Number.isFinite(x0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return contentBounds(layer.surface);
}

/** 把一张画布的内容整体平移（空出来的地方保持透明）。 */
function shifted(src: HTMLCanvasElement, dx: number, dy: number): HTMLCanvasElement {
  const out = createSurface(src.width, src.height);
  mustCtx(out).drawImage(src, Math.round(dx), Math.round(dy));
  return out;
}

/** 平移一个图层（组则连整棵子树），maskLinked 为 false 时蒙版不跟着走。 */
function shiftLayer(doc: StrataDoc, layer: StrataLayer, dx: number, dy: number): StrataLayer[] {
  const moved: StrataLayer[] = [];
  const apply = (l: StrataLayer): StrataLayer => {
    if (l.kind !== "pixel") return l;
    const next: StrataLayer = { ...l, surface: shifted(l.surface, dx, dy) };
    if (l.mask && l.maskLinked !== false) next.mask = shifted(l.mask, dx, dy);
    return next;
  };
  if (layer.kind === "group") {
    for (const l of doc.layers) {
      if (l.parent === layer.id) moved.push(apply(l));
    }
    if (moved.length > 0) {
      // 组本身没有像素，标个占位让上层知道这一组动过了
      moved.push({ ...layer });
    }
    return moved;
  }
  return [apply(layer)];
}

/**
 * 对齐：把多层的内容边缘 / 中心对齐到「选区外接框」。
 * 只选一层时基准是整张画布。
 */
export function alignLayers(doc: StrataDoc, edge: AlignEdge): StrataDoc {
  const list = targets(doc);
  if (list.length === 0) return doc;
  const boxes = list.map((l) => ({ layer: l, box: boundsOf(doc, l) }));
  const valid = boxes.filter((b) => b.box) as { layer: StrataLayer; box: Bounds }[];
  if (valid.length === 0) return doc;

  let ref: Bounds;
  if (valid.length > 1) {
    const x0 = Math.min(...valid.map((v) => v.box.x));
    const y0 = Math.min(...valid.map((v) => v.box.y));
    const x1 = Math.max(...valid.map((v) => v.box.x + v.box.w));
    const y1 = Math.max(...valid.map((v) => v.box.y + v.box.h));
    ref = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  } else {
    ref = { x: 0, y: 0, w: doc.width, h: doc.height };
  }

  const nextLayers = doc.layers.slice();
  for (const { layer, box } of valid) {
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left":
        dx = ref.x - box.x;
        break;
      case "right":
        dx = ref.x + ref.w - (box.x + box.w);
        break;
      case "horizontalCenters":
        dx = ref.x + ref.w / 2 - (box.x + box.w / 2);
        break;
      case "top":
        dy = ref.y - box.y;
        break;
      case "bottom":
        dy = ref.y + ref.h - (box.y + box.h);
        break;
      case "verticalCenters":
        dy = ref.y + ref.h / 2 - (box.y + box.h / 2);
        break;
      default:
        break;
    }
    if (dx === 0 && dy === 0) continue;
    for (const moved of shiftLayer(doc, layer, dx, dy)) {
      const at = nextLayers.findIndex((l) => l.id === moved.id);
      if (at >= 0) nextLayers[at] = moved;
    }
  }
  return { ...doc, layers: nextLayers, dirty: true };
}

export type DistributeEdge = AlignEdge | "horizontally" | "vertically";

/**
 * 分布：按指定边排序后均匀铺开。
 * - 六个 *Edges/*Centers：等间距对齐「边或中心」（PS 的前六项）
 * - horizontally / vertically：让相邻间距相等（PS 的「水平/垂直分布间距」）
 */
export function distributeLayers(doc: StrataDoc, edge: DistributeEdge): StrataDoc {
  const list = targets(doc);
  if (list.length < 3) return doc;
  const boxes = list
    .map((l) => ({ layer: l, box: boundsOf(doc, l) }))
    .filter((b) => b.box) as { layer: StrataLayer; box: Bounds }[];
  if (boxes.length < 3) return doc;

  const horizontal =
    edge === "left" || edge === "right" || edge === "horizontalCenters" || edge === "horizontally";
  const posOf = (b: Bounds): number => {
    switch (edge) {
      case "left":
      case "top":
        return horizontal ? b.x : b.y;
      case "right":
        return b.x + b.w;
      case "bottom":
        return b.y + b.h;
      case "horizontalCenters":
        return b.x + b.w / 2;
      case "verticalCenters":
        return b.y + b.h / 2;
      default:
        return horizontal ? b.x : b.y;
    }
  };

  const sorted = boxes.slice().sort((a, b) => posOf(a.box) - posOf(b.box));
  const first = sorted[0].box;
  const last = sorted[sorted.length - 1].box;
  const nextLayers = doc.layers.slice();

  if (edge === "horizontally" || edge === "vertically") {
    // 等间距：所有内容总宽 + 总间隙均分
    const total = sorted.reduce((sum, s) => sum + (horizontal ? s.box.w : s.box.h), 0);
    const span = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y;
    const gap = (span - total) / (sorted.length - 1);
    let cursor = horizontal ? first.x : first.y;
    for (const s of sorted) {
      const cur = horizontal ? s.box.x : s.box.y;
      const d = cursor - cur;
      if (d !== 0) {
        for (const moved of shiftLayer(doc, s.layer, horizontal ? d : 0, horizontal ? 0 : d)) {
          const at = nextLayers.findIndex((l) => l.id === moved.id);
          if (at >= 0) nextLayers[at] = moved;
        }
      }
      cursor += (horizontal ? s.box.w : s.box.h) + gap;
    }
  } else {
    // 边/中心等间距：首尾固定，中间按位置均匀插值
    const a = posOf(first);
    const b = posOf(last);
    const step = (b - a) / (sorted.length - 1);
    for (let i = 1; i < sorted.length - 1; i += 1) {
      const s = sorted[i];
      const want = a + step * i;
      const d = want - posOf(s.box);
      if (d === 0) continue;
      for (const moved of shiftLayer(doc, s.layer, horizontal ? d : 0, horizontal ? 0 : d)) {
        const at = nextLayers.findIndex((l) => l.id === moved.id);
        if (at >= 0) nextLayers[at] = moved;
      }
    }
  }
  return { ...doc, layers: nextLayers, dirty: true };
}
