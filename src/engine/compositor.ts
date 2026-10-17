/**
 * 图层合成。
 *
 * 从下到上逐层绘制：图层样式（下） → 混合模式 → 不透明度 → 图层蒙版 →
 * 图层样式（上）。剪贴层只在下层轮廓内显示。
 * 调整图层不画自己的像素，而是把「它下方已经合成出来的结果」整体过一遍
 * 滤镜再写回，这就是非破坏调整的全部实现。
 *
 * 合成结果落在调用方给的画布上，也就是画布视图与导出共用同一段代码 ——
 * 屏幕上看到的和导出的必然一致。
 */
import { adjustFilter, blendOp, type StrataLayer } from "../core/layer";
import type { StrataDoc } from "../core/document";
import { mustCtx } from "./surface";
import { pruneFilters } from "./filters";
import { clipBaseOf, maskedSurface, paintStyledLayer } from "./styles";

export { maskedSurface };

/* ---------------------------------------------------------------- 暂存画布 */

/**
 * 调整图层专用的一张全局复用暂存画布。
 *
 * 一次只需要服务一帧，固定一张就够，避免每帧 new 一张 24MP 的画布。
 * 蒙版与图层样式的暂存画布由 styles.ts 统一管理。
 */
let adjustBuf: HTMLCanvasElement | null = null;

function adjustBuffer(w: number, h: number): HTMLCanvasElement {
  let c = adjustBuf;
  if (!c) {
    c = document.createElement("canvas");
    adjustBuf = c;
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return resetBuffer(c);
}

/**
 * 图层组的缓冲画布池：按嵌套深度取用。
 *
 * 一个组渲染时先把自己的子层画进本深度的缓冲，再整块画到上一层 ——
 * 所以「渲染某深度」与「使用上一层缓冲」永远不重叠，一深度一张就够，
 * 组再多也不会重复分配；不嵌套时池里只会有 1 张。
 */
const groupBufs: HTMLCanvasElement[] = [];

function groupBuffer(depth: number, w: number, h: number): HTMLCanvasElement {
  let c = groupBufs[depth];
  if (!c) {
    c = document.createElement("canvas");
    groupBufs[depth] = c;
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return resetBuffer(c);
}

/** 复位一张复用画布：状态全部归零并清空，复用前必调。 */
function resetBuffer(c: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = mustCtx(c);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, c.width, c.height);
  return c;
}


/* ---------------------------------------------------------------- 单层绘制 */

/**
 * 把一层画到目标画布上，按该层的混合模式、不透明度、蒙版与样式。
 *
 * 只对自带像素的层有意义：调整层要看「下方合成结果」，组要看自己的子层，
 * 二者都不是一层能单独画出来的，所以直接跳过。
 */
export function drawLayer(
  ctx: CanvasRenderingContext2D,
  layer: StrataLayer,
): void {
  if (layer.kind === "adjust" || layer.kind === "group") return;
  paintStyledLayer(ctx, layer);
}

/** 把一整层的效果（含蒙版、样式与不透明度）落到目标画布上（合并 / 拼合用）。 */
export function paintSurface(
  ctx: CanvasRenderingContext2D,
  layer: StrataLayer,
  /** 非空时表示这一层是剪贴层，只在该轮廓内显示 */
  clipShape?: HTMLCanvasElement | null,
): void {
  paintStyledLayer(ctx, layer, clipShape);
}

/* ---------------------------------------------------------------- 调整图层 */

/**
 * 把当前合成结果整体过一遍调整图层的滤镜。
 *
 * 不透明度不是「滤镜强度」而是「效果与原图的混合比」，因此低于 100% 时
 * 先把原样按比例叠回来，这样滑杆从 0 到 100 是一条平滑的过渡。
 */
function applyAdjust(
  ctx: CanvasRenderingContext2D,
  layer: StrataLayer,
  w: number,
  h: number,
): void {
  if (!layer.visible || layer.opacity <= 0 || !layer.adjust) return;
  const filter = adjustFilter(layer.adjust, layer.id);
  if (!filter) return;

  const buf = adjustBuffer(w, h);
  const bc = mustCtx(buf);
  bc.drawImage(ctx.canvas, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = blendOp(layer.blend);
  ctx.clearRect(0, 0, w, h);
  ctx.filter = filter;
  ctx.globalAlpha = 1;
  ctx.drawImage(buf, 0, 0);

  const back = 1 - layer.opacity / 100;
  if (back > 0) {
    ctx.filter = "none";
    ctx.globalAlpha = back;
    ctx.drawImage(buf, 0, 0);
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- 整档合成 */

/**
 * 绘制过程中的临时替换：把栈里第 index 层换成 layer。
 *
 * 未抬笔的笔画、拖动中的位移、正在涂的蒙版都靠它即时回显 ——
 * 好处是回显走的是与最终结果完全相同的合成路径，不会出现「一抬笔就变样」。
 */
export interface LayerOverride {
  index: number;
  layer: StrataLayer;
}

/**
 * 合成整份文档。
 *
 * 目标画布会被整体覆盖（含清空），因此不必事先擦除。
 */
export function composeDoc(
  doc: StrataDoc,
  target: HTMLCanvasElement,
  override?: LayerOverride | null,
): HTMLCanvasElement {
  if (target.width !== doc.width) target.width = doc.width;
  if (target.height !== doc.height) target.height = doc.height;
  const ctx = mustCtx(target);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, target.width, target.height);

  // 先把「临时替换」并进一份等长副本：组内子层正在描的笔画也要能即时回显，
  // 而子层在扁平数组里同样是按 id 定位的，所以副本一份就够。
  const list = override
    ? doc.layers.map((l, i) => (override.index === i ? override.layer : l))
    : doc.layers;

  paintStack(ctx, list, target.width, target.height, null, 0);

  // 顺手把已经删掉的图层留下的 SVG 滤镜清掉 —— 图层一多，这里不回收就会越堆越多
  pruneFilters(liveLayerIds(doc, override));
  return target;
}

/**
 * 把「同一层级」的图层从下到上依次画到 ctx 上。
 *
 * 绘制顺序就是数组顺序，而组内子层在数组里紧挨着排在组的下面：轮到某个组时
 * 才把它的整棵子树渲进缓冲，再当作「组的像素」画一次 —— 因此组内子层既不必
 * 在这里单独出现，次序也不会乱。parent = null 表示顶层。
 */
function paintStack(
  ctx: CanvasRenderingContext2D,
  layers: StrataLayer[],
  width: number,
  height: number,
  parent: string | null,
  depth: number,
): void {
  // 剪贴基底：最近一个「非剪贴」层的轮廓，供其上的剪贴层裁切
  let base: HTMLCanvasElement | null = null;

  for (const l of layers) {
    // 只画本层级的：别的层级由各自的父级递归带走
    if ((l.parent ?? null) !== parent) continue;

    // 调整层不画自己，而是把「下方已合成结果」整体过一遍滤镜
    if (l.kind === "adjust") {
      applyAdjust(ctx, l, width, height);
      base = null;
      continue;
    }

    if (l.kind === "group") {
      // 空组什么都不贡献（也不该拿 1×1 占位面去画）
      if (!layers.some((k) => k.parent === l.id)) continue;
      const buf = groupBuffer(depth, width, height);
      paintStack(mustCtx(buf), layers, width, height, l.id, depth + 1);
      // 浅拷贝换掉 surface，组的混合 / 不透明度 / 蒙版 / 样式就此零成本生效
      const eff: StrataLayer = { ...l, surface: buf };
      const clip = l.clip ? base : null;
      paintStyledLayer(ctx, eff, clip);
      if (!l.clip) base = clipBaseOf(eff, width, height);
      continue;
    }

    const clip = l.clip ? base : null;
    paintStyledLayer(ctx, l, clip);
    if (!l.clip) base = clipBaseOf(l, width, height);
  }
}

/** 当前还活着的图层 id（含临时替换进来的那一层）。 */
function liveLayerIds(doc: StrataDoc, override?: LayerOverride | null): Set<string> {
  const ids = new Set<string>();
  doc.layers.forEach((layer, i) => {
    ids.add(override && override.index === i ? override.layer.id : layer.id);
  });
  return ids;
}

/**
 * 「复制合并」用：把文档合成成一张新画布，与目标解耦。
 */
export function flattenDoc(doc: StrataDoc): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = doc.width;
  out.height = doc.height;
  return composeDoc(doc, out);
}
