/**
 * 几何变换：翻转 / 旋转 / 自由变换。
 *
 * 与 layerOps 一样，全部写成「旧文档 → 新文档」的纯函数：不改入参、
 * 每次返回新对象，撤销栈与 React 的 diff 都能直接复用。
 *
 * 分两层：
 *  - 离散操作（水平 / 垂直翻转、90 度整倍旋转）—— 图像菜单与编辑菜单直接调用；
 *  - 自由变换（FreeTransform + applyFreeTransform）—— 交互式变换的数学内核，
 *    由编辑器浮层反复调用它来出预览帧，确认时才真正落进历史。
 */
import { cloneSurface, createSurface, mustCtx } from "../engine/surface";
import { activeLayer, type StrataDoc } from "./document";
import type { StrataLayer } from "./layer";

/** 翻转轴：h 水平、v 垂直。 */
export type FlipAxis = "h" | "v";

/** 90 度整倍的旋转角度。 */
export type QuarterTurn = 90 | 180 | 270;

/* -------------------------------------------------------------- 基础表面操作 */

/** 翻转一张表面（尺寸不变）。 */
function flipSurface(src: HTMLCanvasElement, axis: FlipAxis): HTMLCanvasElement {
  const out = createSurface(src.width, src.height);
  const ctx = mustCtx(out);
  if (axis === "h") {
    ctx.translate(src.width, 0);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(0, src.height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(src, 0, 0);
  return out;
}

/**
 * 把一张表面顺时针旋转 deg 度（只支持 90 / 180 / 270）。
 *
 * 90 / 270 度会交换宽高 —— 这正是「图像旋转」能改画布长宽的原因。
 */
function turnSurface(src: HTMLCanvasElement, deg: QuarterTurn): HTMLCanvasElement {
  const swap = deg === 90 || deg === 270;
  const out = createSurface(
    swap ? src.height : src.width,
    swap ? src.width : src.height,
  );
  const ctx = mustCtx(out);
  if (deg === 90) {
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (deg === 180) {
    ctx.translate(out.width, out.height);
    ctx.rotate(Math.PI);
  } else {
    ctx.translate(0, out.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(src, 0, 0);
  return out;
}

/** 可参与像素变换的图层（只有像素层有自己的 surface）。 */
function isPixel(l: StrataLayer): boolean {
  return l.kind === "pixel";
}

/* --------------------------------------------------- 编辑 > 变换（当前图层） */

/**
 * 水平 / 垂直翻转当前图层。
 *
 * 翻转的是「本层像素」，上下层关系不动 —— 与 PS「编辑 > 变换 > 水平翻转」一致。
 * 图层蒙版一起翻，保证蒙版与像素仍然对齐。
 */
export function flipLayer(doc: StrataDoc, axis: FlipAxis): StrataDoc {
  const at = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  if (at < 0) return doc;
  const layer = doc.layers[at];
  if (!isPixel(layer) || layer.locked) return doc;
  const layers = doc.layers.slice();
  layers[at] = {
    ...layer,
    surface: flipSurface(layer.surface, axis),
    mask: layer.mask ? flipSurface(layer.mask, axis) : layer.mask,
  };
  return { ...doc, layers, dirty: true };
}

/**
 * 图层旋转 90°（顺 / 逆）：内容绕画布中心转 quarter，画布尺寸不变。
 * 非正方形画布上越界部分会被裁掉 —— 与 PS 的「变换 > 旋转 90°」行为一致。
 */
export function rotateLayerQuarter(doc: StrataDoc, deg: 90 | 270): StrataDoc {
  const at = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  if (at < 0) return doc;
  const layer = doc.layers[at];
  if (!isPixel(layer) || layer.locked) return doc;
  const turn = (src: HTMLCanvasElement): HTMLCanvasElement => {
    const out = createSurface(src.width, src.height);
    const ctx = mustCtx(out);
    ctx.translate(src.width / 2, src.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return out;
  };
  const layers = doc.layers.slice();
  layers[at] = {
    ...layer,
    surface: turn(layer.surface),
    mask: layer.mask ? turn(layer.mask) : layer.mask,
  };
  return { ...doc, layers, dirty: true };
}

/** 当前图层旋转 180 度（尺寸不变，等价于水平 + 垂直翻转）。 */
export function rotateLayerHalf(doc: StrataDoc): StrataDoc {
  const at = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  if (at < 0) return doc;
  const layer = doc.layers[at];
  if (!isPixel(layer) || layer.locked) return doc;
  const layers = doc.layers.slice();
  layers[at] = {
    ...layer,
    surface: turnSurface(layer.surface, 180),
    mask: layer.mask ? turnSurface(layer.mask, 180) : layer.mask,
  };
  return { ...doc, layers, dirty: true };
}

/* ------------------------------------------------- 图像 > 图像旋转（整份文档） */

/**
 * 整份文档顺时针旋转 90 / 180 / 270 度。
 *
 * 与「图层变换」不同，这里连画布一起转：90 / 270 度宽高互换，所有像素层、
 * 蒙版、以及选区遮罩同步旋转，层与层之间的对齐关系完全保持。
 * 调整图层 / 组没有自己的像素，跳过即可。
 */
export function rotateDocument(doc: StrataDoc, deg: QuarterTurn): StrataDoc {
  const swap = deg === 90 || deg === 270;
  const layers = doc.layers.map((l) => {
    if (isPixel(l)) {
      return {
        ...l,
        surface: turnSurface(l.surface, deg),
        mask: l.mask ? turnSurface(l.mask, deg) : l.mask,
      };
    }
    return { ...l, mask: l.mask ? turnSurface(l.mask, deg) : l.mask };
  });
  return {
    ...doc,
    width: swap ? doc.height : doc.width,
    height: swap ? doc.width : doc.height,
    layers,
    selection: doc.selection ? turnSurface(doc.selection, deg) : doc.selection,
    dirty: true,
  };
}

/** 整份文档水平 / 垂直翻转（PS「图像旋转 > 水平翻转画布」）。 */
export function flipDocument(doc: StrataDoc, axis: FlipAxis): StrataDoc {
  const layers = doc.layers.map((l) => {
    if (isPixel(l)) {
      return {
        ...l,
        surface: flipSurface(l.surface, axis),
        mask: l.mask ? flipSurface(l.mask, axis) : l.mask,
      };
    }
    return { ...l, mask: l.mask ? flipSurface(l.mask, axis) : l.mask };
  });
  return {
    ...doc,
    layers,
    selection: doc.selection ? flipSurface(doc.selection, axis) : doc.selection,
    dirty: true,
  };
}

/* ------------------------------------------------------------------ 自由变换 */

/**
 * 一次自由变换的参数。
 *
 * 把变换拆成「中心 + 未旋转宽高 + 旋转角 + 双向翻转」而不是一条 3×3 矩阵，
 * 是为了让吸附手柄的数学保持简单：缩放只改 w/h 并把对角（或对边）当锚点钉住，
 * 旋转只改 angle，平移只改中心。翻转记成布尔量，不参与手柄几何 ——
 * 翻转后的矩形和原矩形在几何上是同一个。
 */
export interface FreeTransform {
  /** 被变换的图层 id */
  layerId: string;
  /** 原始像素（文档尺寸） */
  src: HTMLCanvasElement;
  /** 变换后的中心点（文档坐标） */
  cx: number;
  cy: number;
  /** 未旋转时的宽高（文档坐标） */
  w: number;
  h: number;
  /** 旋转角（弧度，顺时针为正） */
  angle: number;
  flipH: boolean;
  flipV: boolean;
}

/** 进入自由变换时的初始参数：铺满画布、不旋转、不翻转。 */
export function initialFreeTransform(doc: StrataDoc): FreeTransform | null {
  const act = activeLayer(doc);
  if (!act || !isPixel(act) || act.locked) return null;
  return {
    layerId: act.id,
    src: cloneSurface(act.surface),
    cx: doc.width / 2,
    cy: doc.height / 2,
    w: doc.width,
    h: doc.height,
    angle: 0,
    flipH: false,
    flipV: false,
  };
}

/** 四角（文档坐标），顺序：左上 → 右上 → 右下 → 左下。 */
export function transformCorners(t: FreeTransform): { x: number; y: number }[] {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  const hw = t.w / 2;
  const hh = t.h / 2;
  const at = (x: number, y: number) => ({
    x: t.cx + x * c - y * s,
    y: t.cy + x * s + y * c,
  });
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/**
 * 把某张表面按变换参数画到一张文档尺寸的新表面上。
 *
 * 这就是自由变换的全部像素学：先移到中心、再旋转、再按「目标宽高 / 原宽高」
 * 缩放（翻转记成负比例），最后把原图以自身中心对齐画上去。落在画布外的部分
 * 自然被裁掉，与 PS 的即时变换一致。
 */
function paintTransformed(
  doc: StrataDoc,
  t: FreeTransform,
  src: HTMLCanvasElement,
): HTMLCanvasElement {
  const out = createSurface(doc.width, doc.height);
  const ctx = mustCtx(out);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(t.cx, t.cy);
  ctx.rotate(t.angle);
  ctx.scale(
    (t.flipH ? -1 : 1) * (t.w / src.width),
    (t.flipV ? -1 : 1) * (t.h / src.height),
  );
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  return out;
}

/**
 * 变换后的图层像素（文档尺寸）。
 *
 * 与 applyFreeTransform 用的是同一套像素学，但只产出表面、不改文档 ——
 * 编辑器用它出实时预览帧，拖动手柄时每一帧都是「正式结果」的样子。
 */
export function freeTransformSurface(
  doc: StrataDoc,
  t: FreeTransform,
): HTMLCanvasElement {
  return paintTransformed(doc, t, t.src);
}

/**
 * 把一次自由变换烘进文档：产出「被变换图层换成新像素」的新文档。
 *
 * 变换只改这一个图层；图层蒙版若存在，用同一套变换同步重画，避免蒙版错位。
 * 画布尺寸不变 —— 落在画布外的内容自然被裁掉，与 PS 的即时变换一致。
 */
export function applyFreeTransform(doc: StrataDoc, t: FreeTransform): StrataDoc {
  const at = doc.layers.findIndex((l) => l.id === t.layerId);
  if (at < 0) return doc;
  const layer = doc.layers[at];

  const layers = doc.layers.slice();
  layers[at] = {
    ...layer,
    surface: paintTransformed(doc, t, t.src),
    mask: layer.mask ? paintTransformed(doc, t, layer.mask) : layer.mask,
  };
  return { ...doc, layers, dirty: true };
}

/**
 * 任意角度旋转整幅画布（PS 图像 > 图像旋转 > 任意角度）。
 *
 * 画布按旋转后的外接矩形扩张；所有像素层、蒙版与选区用同一套变换，
 * 保证图层之间不错位。落在新画布外的部分自然被裁掉。
 */
export function rotateDocumentArbitrary(doc: StrataDoc, deg: number): StrataDoc {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = Math.max(1, Math.round(doc.width * cos + doc.height * sin));
  const h = Math.max(1, Math.round(doc.width * sin + doc.height * cos));
  const turn = (src: HTMLCanvasElement): HTMLCanvasElement => {
    const out = createSurface(w, h);
    const ctx = mustCtx(out);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rad);
    ctx.drawImage(src, -doc.width / 2, -doc.height / 2);
    return out;
  };
  const layers = doc.layers.map((l) => {
    if (l.kind !== "pixel") {
      return { ...l, mask: l.mask ? turn(l.mask) : l.mask };
    }
    return { ...l, surface: turn(l.surface), mask: l.mask ? turn(l.mask) : l.mask };
  });
  return {
    ...doc,
    width: w,
    height: h,
    layers,
    selection: doc.selection ? turn(doc.selection) : null,
    dirty: true,
  };
}
