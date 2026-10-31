/**
 * 形状布尔运算（Layer > Combine Shapes）。
 *
 * Strata 的形状最终都落在像素层上，所以「合并形状」在这里就是**按 alpha 做布尔**：
 * 取最上面那一层的颜色，把选中各层的覆盖率按 并/减/交/异或 合成一张新 alpha。
 * 与应用内其他像素运算同一套「旧文档进、新文档出」的写法。
 *
 * 纯计算部分（combineAlpha）在 node 里可断言。
 */
import { createSurface, mustCtx, readPixels } from "../engine/surface";
import type { StrataDoc } from "./document";
import type { StrataLayer } from "./layer";

export type CombineOp = "unite" | "subtract" | "intersect" | "exclude";

export const COMBINE_LABELS: Record<CombineOp, string> = {
  unite: "合并形状",
  subtract: "减去顶层形状",
  intersect: "与形状区域相交",
  exclude: "排除重叠形状",
};

/** 把两层 alpha（0~255）按布尔运算合成。 */
export function combineAlpha(base: number, next: number, op: CombineOp): number {
  switch (op) {
    case "unite":
      return Math.max(base, next);
    case "subtract":
      return Math.max(0, base - next);
    case "intersect":
      return Math.min(base, next);
    case "exclude":
      return Math.abs(base - next);
    default:
      return base;
  }
}

/** 参与运算的像素层（多选优先，否则取活动层及以下所有像素层）。 */
function operandLayers(doc: StrataDoc): StrataLayer[] {
  const ids = doc.selectedLayerIds ?? [];
  if (ids.length >= 2) {
    return doc.layers.filter((l) => ids.includes(l.id) && l.kind === "pixel");
  }
  return doc.layers.filter((l) => l.kind === "pixel");
}

/**
 * 合并选中的形状层：结果写进最上面那层，其余参与层删除。
 * 颜色取顶层（PS 也是保留最上面形状的填充）。
 */
export function combineShapes(doc: StrataDoc, op: CombineOp): StrataDoc {
  const parts = operandLayers(doc);
  if (parts.length < 2) return doc;
  const top = parts[parts.length - 1];
  const w = doc.width;
  const h = doc.height;

  // 从底往上累积 alpha（subtract 的语义是「下面的减上面的」，所以顺序从下往上）
  const acc = new Float32Array(w * h);
  for (const l of parts) {
    const img = readPixels(l.surface);
    for (let p = 0; p < w * h; p += 1) {
      acc[p] = combineAlpha(acc[p], img.data[p * 4 + 3], op);
    }
  }

  const topImg = readPixels(top.surface);
  const out = createSurface(w, h);
  const img = readPixels(out);
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    img.data[o] = topImg.data[o];
    img.data[o + 1] = topImg.data[o + 1];
    img.data[o + 2] = topImg.data[o + 2];
    img.data[o + 3] = acc[p];
  }
  mustCtx(out).putImageData(img, 0, 0);

  const doomed = new Set(parts.slice(0, -1).map((l) => l.id));
  const layers = doc.layers
    .filter((l) => !doomed.has(l.id))
    .map((l) => (l.id === top.id ? { ...l, surface: out, name: `${l.name}（合并）` } : l));
  return { ...doc, layers, selectedLayerIds: [top.id], activeLayerId: top.id, dirty: true };
}
