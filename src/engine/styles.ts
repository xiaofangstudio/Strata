/**
 * 图层样式与剪贴蒙版的渲染。
 *
 * 与调整图层一样，这里也走 Canvas2D 的真实能力，不画假效果：
 *   投影 / 外发光 —— 用图层轮廓填色、模糊、偏移后压在图层像素之下；
 *   内阴影 / 内发光 —— 用「轮廓之外」反向填色、模糊、偏移后裁进轮廓内；
 *   颜色叠加 —— 直接用轮廓填一块纯色；
 *   描边 —— 交给一条 SVG 滤镜（高斯模糊 + alpha 阈值 = 膨胀/腐蚀），
 *            这样一次绘制就能得到干净的硬边描边，不必把整幅画布刷几十遍。
 *
 * 渲染顺序对齐 PS：投影、外发光在下；图层像素居中；内阴影、内发光、
 * 颜色叠加、描边在上。
 */
import { blendOp, isSoftBlend, type LayerStyle, type StrataLayer } from "../core/layer";
import { mustCtx } from "./surface";
import { svgFilter } from "./filters";
import { blendInto } from "./blend";

/* ---------------------------------------------------------------- 暂存画布 */

/**
 * 全局复用的暂存画布池。
 *
 * 索引固定分配、互不重叠：合成期间同一时刻只会用到这几张，避免每帧
 * new 出好几张 24MP 的画布。
 */
const pool: (HTMLCanvasElement | null)[] = [];

function slot(index: number, w: number, h: number): HTMLCanvasElement {
  let c = pool[index];
  if (!c) {
    c = document.createElement("canvas");
    pool[index] = c;
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  const ctx = mustCtx(c);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, c.width, c.height);
  return c;
}

/** 剪贴基底：需要跨多层存活，因此单独留一张，不进池。 */
let clipBuf: HTMLCanvasElement | null = null;

/* ---------------------------------------------------------------- 轮廓 */

/**
 * 把蒙版按 alpha 扣到图层像素上，得到「这一层实际要画的东西」。
 *
 * 蒙版按 alpha 存储，因此一次 destination-in 即可，不必逐像素换算。
 */
export function maskedSurface(layer: StrataLayer): HTMLCanvasElement {
  const src = layer.surface;
  const buf = slot(3, src.width, src.height);
  const ctx = mustCtx(buf);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(layer.mask!, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  return buf;
}

/** 图层自身的轮廓（含蒙版，不含样式）。 */
export function layerShape(layer: StrataLayer): HTMLCanvasElement {
  return layer.maskActive && layer.mask ? maskedSurface(layer) : layer.surface;
}

/**
 * 剪贴基底：下方「非剪贴」图层的轮廓。之后的剪贴层都按它的 alpha 裁切。
 */
function baseShape(layer: StrataLayer, w: number, h: number): HTMLCanvasElement {
  let c = clipBuf;
  if (!c) {
    c = document.createElement("canvas");
    clipBuf = c;
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  const ctx = mustCtx(c);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(layer.surface, 0, 0);
  if (layer.maskActive && layer.mask) {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(layer.mask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  return c;
}

/* ---------------------------------------------------------------- 工具 */

/** 样式角度（PS 习惯：逆时针、y 轴朝上）→ 屏幕位移。 */
function offsetOf(angleDeg: number, distance: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [-Math.cos(a) * distance, Math.sin(a) * distance];
}

/** 把 src 的轮廓整体染成 color（保留 alpha）。目标画布会被覆盖。 */
function tint(dst: HTMLCanvasElement, src: HTMLCanvasElement, color: string): void {
  const ctx = mustCtx(dst);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, dst.width, dst.height);
  ctx.globalCompositeOperation = "source-over";
}

/** 启用中的样式，顺序即渲染顺序。 */
function activeStyles(layer: StrataLayer): LayerStyle[] {
  return (layer.styles ?? []).filter((s) => s.enabled);
}

/* ---------------------------------------------------------------- 描边滤镜 */

/**
 * 描边用的 SVG 滤镜。
 *
 * feGaussianBlur 把轮廓的 alpha 抹成一条斜坡，再用 feComponentTransfer 的
 * 离散型按阈值切一刀：阈值取 0.2 相当于向外膨胀、取 0.8 相当于向内腐蚀，
 * 两者相减就是一圈干净的描边。整条链只在 GPU 上跑一次，比在画布上刷
 * 几十次轮廓便宜得多。
 */
function strokeMarkup(radius: number, color: string, position: number): string {
  const sigma = Math.max(0.5, radius * 1.19).toFixed(2);
  const blur = `<feGaussianBlur in="SourceAlpha" stdDeviation="${sigma}" result="bl"/>`;
  const dilate =
    '<feComponentTransfer in="bl" result="dil">' +
    '<feFuncA type="discrete" tableValues="0 1 1 1 1"/></feComponentTransfer>';
  const erode =
    '<feComponentTransfer in="bl" result="ero">' +
    '<feFuncA type="discrete" tableValues="0 0 0 0 1"/></feComponentTransfer>';
  let ring: string;
  if (position === 0) {
    ring = `${blur}${dilate}<feComposite in="dil" in2="SourceAlpha" operator="out" result="ring"/>`;
  } else if (position === 1) {
    ring = `${blur}${erode}<feComposite in="SourceAlpha" in2="ero" operator="out" result="ring"/>`;
  } else {
    ring = `${blur}${dilate}${erode}<feComposite in="dil" in2="ero" operator="out" result="ring"/>`;
  }
  return (
    ring +
    `<feFlood flood-color="${color}" result="fc"/>` +
    '<feComposite in="fc" in2="ring" operator="in"/>' +
    '<feGaussianBlur stdDeviation="0.6"/>'
  );
}

/* ---------------------------------------------------------------- 单样式 */

/**
 * 把一种样式画到目标画布上。
 *
 * @param eff 图层轮廓（已含蒙版与剪贴）
 * @param above true 表示画在图层像素之上，false 表示画在其下
 */
function drawStyle(
  ctx: CanvasRenderingContext2D,
  layer: StrataLayer,
  eff: HTMLCanvasElement,
  s: LayerStyle,
  w: number,
  h: number,
): void {
  const alpha = Math.max(0, Math.min(1, s.opacity / 100));
  if (alpha <= 0) return;
  const blend = blendOp(s.blend);

  const commit = (src: CanvasRenderingContext2D | HTMLCanvasElement) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(src as CanvasImageSource, 0, 0);
    ctx.restore();
  };

  switch (s.id) {
    /* ---- 图层像素之下 ---- */
    case "dropshadow": {
      const buf = slot(1, w, h);
      tint(buf, eff, s.color);
      const [dx, dy] = offsetOf(s.angle, s.distance);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = blend;
      ctx.filter = s.size > 0 ? `blur(${s.size}px)` : "none";
      ctx.drawImage(buf, dx, dy);
      ctx.restore();
      break;
    }
    case "outerglow": {
      const buf = slot(1, w, h);
      tint(buf, eff, s.color);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = blend;
      ctx.filter = s.size > 0 ? `blur(${s.size}px)` : "none";
      ctx.drawImage(buf, 0, 0);
      ctx.restore();
      break;
    }

    /* ---- 图层像素之上 ---- */
    case "coloroverlay": {
      const buf = slot(1, w, h);
      tint(buf, eff, s.color);
      commit(buf);
      break;
    }
    case "innershadow":
    case "innerglow": {
      // 轮廓之外的整体填色 → 模糊（内阴影再偏移）→ 裁回轮廓内
      const outside = slot(1, w, h);
      const oc = mustCtx(outside);
      oc.fillStyle = s.color;
      oc.fillRect(0, 0, w, h);
      oc.globalCompositeOperation = "destination-out";
      oc.drawImage(eff, 0, 0);
      oc.globalCompositeOperation = "source-over";

      const out = slot(2, w, h);
      const ouc = mustCtx(out);
      const [dx, dy] = s.id === "innershadow" ? offsetOf(s.angle, s.distance) : [0, 0];
      ouc.filter = s.size > 0 ? `blur(${s.size}px)` : "none";
      ouc.drawImage(outside, dx, dy);
      ouc.filter = "none";
      ouc.globalCompositeOperation = "destination-in";
      ouc.drawImage(eff, 0, 0);
      ouc.globalCompositeOperation = "source-over";
      commit(out);
      break;
    }
    case "stroke": {
      if (s.size <= 0) break;
      const pos = Math.max(0, Math.min(2, s.position));
      const radius = pos === 2 ? s.size / 2 : s.size;
      const id = `sfx-${layer.id}`;
      const markup = strokeMarkup(radius, s.color, pos);
      const margin = Math.max(0.1, Math.min(0.5, 0.06 + radius / Math.min(w, h)));
      const url = svgFilter(id, `stroke|${radius}|${s.color}|${pos}`, markup, margin);
      const buf = slot(2, w, h);
      const bc = mustCtx(buf);
      bc.filter = url;
      bc.drawImage(eff, 0, 0);
      bc.filter = "none";
      commit(buf);
      break;
    }
  }
}

/* ---------------------------------------------------------------- 整层 */

/**
 * 把一个像素图层（含样式与剪贴）画到目标画布上。
 *
 * @param clipShape 非空时表示本层是剪贴层，只在该轮廓的不透明范围内显示
 */
export function paintStyledLayer(
  ctx: CanvasRenderingContext2D,
  layer: StrataLayer,
  clipShape?: HTMLCanvasElement | null,
): void {
  if (layer.kind === "adjust") return;
  if (!layer.visible || layer.opacity <= 0) return;

  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const styles = activeStyles(layer);

  /* 最常用的情形：没有样式也没有剪贴，直接一次 drawImage。 */
  if (styles.length === 0 && !clipShape) {
    if (isSoftBlend(layer.blend)) {
      blendInto(ctx, layerShape(layer), layer.opacity / 100, layer.blend);
      return;
    }
    ctx.save();
    ctx.globalAlpha = layer.opacity / 100;
    ctx.globalCompositeOperation = blendOp(layer.blend);
    ctx.drawImage(layerShape(layer), 0, 0);
    ctx.restore();
    return;
  }

  /* 生效像素：图层表面 + 蒙版 + 剪贴基底。放进 0 号槽供各样式的轮廓使用。 */
  const eff = slot(0, w, h);
  const ec = mustCtx(eff);
  ec.drawImage(layer.surface, 0, 0);
  if (layer.maskActive && layer.mask) {
    ec.globalCompositeOperation = "destination-in";
    ec.drawImage(layer.mask, 0, 0);
    ec.globalCompositeOperation = "source-over";
  }
  if (clipShape) {
    ec.globalCompositeOperation = "destination-in";
    ec.drawImage(clipShape, 0, 0);
    ec.globalCompositeOperation = "source-over";
  }

  const below = ["dropshadow", "outerglow"];
  for (const s of styles) {
    if (below.includes(s.id)) drawStyle(ctx, layer, eff, s, w, h);
  }

  ctx.save();
  if (isSoftBlend(layer.blend)) {
    // Canvas2D 没有这些混色公式，只能把整幅画面读回来逐像素算。
    // 会破坏 ctx 的 save / restore 栈 —— 因此先 restore 再单独合成。
    ctx.restore();
    blendInto(ctx, eff, layer.opacity / 100, layer.blend);
  } else {
    ctx.globalAlpha = layer.opacity / 100;
    ctx.globalCompositeOperation = blendOp(layer.blend);
    ctx.drawImage(eff, 0, 0);
    ctx.restore();
  }

  for (const s of styles) {
    if (!below.includes(s.id)) drawStyle(ctx, layer, eff, s, w, h);
  }
}

/** 供合成器在遇到「非剪贴」图层时取它的轮廓，作为后续剪贴层的基底。 */
export function clipBaseOf(layer: StrataLayer, w: number, h: number): HTMLCanvasElement {
  return baseShape(layer, w, h);
}
