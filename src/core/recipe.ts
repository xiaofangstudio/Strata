/**
 * 批处理配方（Droplet 与脚本事件管理器共用的内核）。
 *
 * PS 的 Droplet 是一个小程序，拖图上去就按预设动作批处理；脚本事件管理器
 * 则把「打开 / 新建 / 导出」这类事件挂到一段脚本上。Strata 没有脚本运行时
 * （这是如实声明过的），但这两件事可以真做：把「动作」定义成一个**配方** ——
 * 一串按序执行的文档级操作（自动对比度 / 转灰度 / 限长边 / 导出 PNG·JPG）。
 *
 * - Droplet：把配方存成 `.strata-droplet` 文件，双击它启动 Strata 即进入
 *   「已装载」状态，拖入的每张图都按配方跑一遍并导出。
 * - 脚本事件管理器：把配方挂到事件上，事件发生时对当前文档执行。
 *
 * 配方按**扁平合成**处理（图层栈先合成一张再操作）——与 PS 批处理对
 * 「处理结果」的语义一致，也让每一步的结果可预测；界面上如实说明。
 */
import { grayscaleDocument } from "./layerOps";
import { fitImage } from "./batchOps";
import { autoContrast } from "../engine/auto";
import { asRaster } from "../engine/raster";
import { composeDoc } from "../engine/compositor";
import { createSurface, mustCtx } from "../engine/surface";
import {
  baseName,
  docFromBlank,
  type StrataDoc,
} from "./document";
import { createLayer } from "./layer";
import { DEFAULT_DPI } from "./presets";

export const RECIPE_EXTENSION = "strata-droplet";

export type RecipeOp =
  | { op: "autoContrast" }
  | { op: "grayscale" }
  | { op: "fit"; maxSide: number }
  | { op: "exportPng" }
  | { op: "exportJpg"; quality: number };

export interface Recipe {
  kind: "strata-droplet";
  version: 1;
  name: string;
  ops: RecipeOp[];
}

/** 配方里每个操作的中文名（界面列出用）。 */
export function recipeOpLabel(op: RecipeOp): string {
  switch (op.op) {
    case "autoContrast":
      return "自动对比度";
    case "grayscale":
      return "转灰度";
    case "fit":
      return `长边限制到 ${op.maxSide} px`;
    case "exportPng":
      return "导出 PNG 到目标文件夹";
    case "exportJpg":
      return `导出 JPG（质量 ${op.quality}）到目标文件夹`;
  }
}

/** 解析并校验配方 JSON；不是合法配方就返回 null（绝不带着坏数据往下跑）。 */
export function parseRecipe(json: string): Recipe | null {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.kind !== "strata-droplet" || r.version !== 1) return null;
    if (typeof r.name !== "string" || !Array.isArray(r.ops)) return null;
    const ops: RecipeOp[] = [];
    for (const o of r.ops) {
      if (!o || typeof o !== "object") return null;
      const t = o as Record<string, unknown>;
      switch (t.op) {
        case "autoContrast":
        case "grayscale":
          ops.push({ op: t.op });
          break;
        case "fit":
          if (typeof t.maxSide !== "number" || !(t.maxSide >= 16)) return null;
          ops.push({ op: "fit", maxSide: Math.round(t.maxSide) });
          break;
        case "exportPng":
          ops.push({ op: "exportPng" });
          break;
        case "exportJpg":
          if (typeof t.quality !== "number" || t.quality < 10 || t.quality > 100)
            return null;
          ops.push({ op: "exportJpg", quality: Math.round(t.quality) });
          break;
        default:
          return null; // 不认识的 op 直接拒绝，而不是悄悄跳过
      }
    }
    if (ops.length === 0) return null;
    return { kind: "strata-droplet", version: 1, name: r.name, ops };
  } catch {
    return null;
  }
}

/** 把一份文档扁平化成单图层副本（配方的处理基准）。 */
export function flattenToSingleLayer(doc: StrataDoc): StrataDoc {
  const surface = createSurface(doc.width, doc.height);
  composeDoc(doc, surface);
  const layer = createLayer(doc.width, doc.height, baseName(doc.name));
  mustCtx(layer.surface).drawImage(surface, 0, 0);
  const next = docFromBlank(doc.width, doc.height, doc.name, "transparent", toInt(DEFAULT_DPI));
  next.layers = [layer];
  next.activeLayerId = layer.id;
  return next;
}

function toInt(v: string): number {
  return Number.parseInt(v, 10);
}

/** 对单图层文档做自动对比度（原地改那一张 surface）。 */
function applyAutoContrast(doc: StrataDoc): void {
  const layer = doc.layers[0];
  const ctx = mustCtx(layer.surface);
  const img = ctx.getImageData(0, 0, layer.surface.width, layer.surface.height);
  const report = autoContrast(asRaster(img));
  if (report.changed) ctx.putImageData(img, 0, 0);
}

/**
 * 对传入文档执行配方的文档级操作，返回新文档与待执行的导出步骤。
 * 纯同步、不碰文件系统，方便测试与界面复用。
 */
export function runRecipeDocOps(
  doc: StrataDoc,
  recipe: Recipe,
): { doc: StrataDoc; exports: RecipeOp[]; log: string[] } {
  let cur = flattenToSingleLayer(doc);
  const log: string[] = ["按扁平合成处理（图层栈合成一张后执行）"];
  const exports: RecipeOp[] = [];
  for (const op of recipe.ops) {
    switch (op.op) {
      case "autoContrast":
        applyAutoContrast(cur);
        log.push("自动对比度");
        break;
      case "grayscale":
        cur = grayscaleDocument(cur);
        log.push("转灰度");
        break;
      case "fit":
        cur = fitImage(cur, op.maxSide);
        log.push(`长边限制到 ${op.maxSide} px（现为 ${cur.width}×${cur.height}）`);
        break;
      case "exportPng":
      case "exportJpg":
        exports.push(op);
        break;
    }
  }
  cur.dirty = true;
  return { doc: cur, exports, log };
}
