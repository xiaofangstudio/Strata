/**
 * 模糊画廊的钉点直通管线（预览与落库同源，只差降采样）。
 *
 * 为什么不再走 FilterDef.apply：Field / Iris 支持每钉独立模糊量
 * （PhotoCraft 的 Pin.blur per pin），标量参数表达不了「每颗钉各自的量」。
 * 这里把多颗钉合成逐像素强度图（core/blurPins.pinAmountField，纯函数可测），
 * 直接喂 iterativeVariableBlur —— 与参考实现同一算法路径。
 * Tilt / Spin / Path 参考实现本身就是单钉，继续走 def.apply。
 *
 * 预览 maxSide 传 640（模糊是大半径操作，形状对得上即可），
 * 落库不传（全分辨率）—— 铁律：预览与结果同源，但绝不把近似结果落库。
 */
import type { StrataDoc } from "./document";
import { createSurface, mustCtx } from "../engine/surface";
import { filterDef } from "../engine/filters/defs";
import { iterativeVariableBlur } from "../engine/filters/gallery";
import { toBuffer, blendWithSelection } from "./filterOps";
import { pinAmountField, pinToParams, type BlurPin } from "./blurPins";

/**
 * 按钉点把模糊画廊滤镜烙进活动像素层。
 * @param maxSide 预览降采样上限；不传 = 全分辨率（落库）。
 * @param extraParams 面板里的非钉点参数（tilt 的清晰带/羽化等），并入 def.apply 的 params。
 * @returns 新 doc；图层不可改时原样返回。
 */
export function applyGalleryPins(
  doc: StrataDoc,
  id: string,
  pins: readonly BlurPin[],
  maxSide?: number,
  extraParams?: Record<string, number>,
): StrataDoc {
  const at = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  if (at < 0) return doc;
  const layer = doc.layers[at];
  // 锁定层不可改；智能对象的滤镜必须走栈（pushSmartFilter），钉点直烙会破坏非破坏语义
  if (layer.kind !== "pixel" || layer.locked || layer.smart) return doc;

  const srcW = layer.surface.width;
  const srcH = layer.surface.height;
  const k = maxSide ? Math.min(1, maxSide / Math.max(srcW, srcH)) : 1;
  const w = Math.max(1, Math.round(srcW * k));
  const h = Math.max(1, Math.round(srcH * k));

  // 工作面：全分辨率时直接读原图；降采样时把活动层缩进来
  let work: HTMLCanvasElement;
  if (k >= 0.999) {
    work = layer.surface;
  } else {
    work = createSurface(w, h);
    const wc = mustCtx(work);
    wc.imageSmoothingQuality = "medium";
    wc.drawImage(layer.surface, 0, 0, w, h);
  }

  const src = mustCtx(work).getImageData(0, 0, w, h);
  // 选区恒等于文档尺寸；工作面降采样时选区也要跟着缩，否则混合索引错位
  let sel: ImageData | null = null;
  if (doc.selection) {
    if (doc.selection.width === w && doc.selection.height === h) {
      sel = mustCtx(doc.selection).getImageData(0, 0, w, h);
    } else {
      const selSmall = createSurface(w, h);
      const sc = mustCtx(selSmall);
      sc.imageSmoothingQuality = "medium";
      sc.drawImage(doc.selection, 0, 0, w, h);
      sel = mustCtx(selSmall).getImageData(0, 0, w, h);
    }
  }
  const orig = toBuffer(src);

  let filtered = orig;
  const field = pinAmountField(id, pins, w, h);
  if (field) {
    filtered = iterativeVariableBlur(orig, field.map, field.maxBlurPx);
  } else {
    // 单钉滤镜：钉点 → 标量参数 + 面板参数，走既有 def.apply（零行为差异）
    const def = filterDef(id);
    const first = pins[0];
    if (def && first) {
      filtered = def.apply(orig, { ...pinToParams(id, first), ...extraParams });
    }
  }

  const merged = blendWithSelection(orig, filtered, sel);

  // 全分辨率：结果写回同尺寸新面；降采样：结果放大回原尺寸
  const next = createSurface(srcW, srcH);
  if (k >= 0.999) {
    const img = new ImageData(srcW, srcH);
    img.data.set(merged.data);
    mustCtx(next).putImageData(img, 0, 0);
  } else {
    const small = createSurface(w, h);
    const img = new ImageData(w, h);
    img.data.set(merged.data);
    mustCtx(small).putImageData(img, 0, 0);
    const nc = mustCtx(next);
    nc.imageSmoothingQuality = "medium";
    nc.drawImage(small, 0, 0, srcW, srcH);
  }

  const layers = doc.layers.slice();
  layers[at] = { ...layer, surface: next };
  return { ...doc, layers, dirty: true };
}

/** 供 UI 判断「这组钉能不能产生效果」（全部 blur 为 0 时视为无效果）。 */
export function galleryPinsUsable(pins: readonly BlurPin[]): boolean {
  return pins.length > 0 && pins.some((p) => p.blur > 0);
}
