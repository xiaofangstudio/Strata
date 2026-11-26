/**
 * Calculations 的画布薄壳：从图层 / Alpha 通道取像素，交给纯函数运算，
 * 同时产出「灰度显示图」与「选区遮罩」两张画布，预览与落库同源。
 */
import type { StrataDoc } from "../core/document";
import { alphaChannelsOf } from "../core/channelOps";
import {
  blendCalcChannels,
  resultToImage,
  resultToMask,
  sampleCalcChannel,
  type CalcParams,
  type CalcSource,
} from "../core/calculations";
import { composeDoc } from "./compositor";
import { createSurface, readPixels, writePixels } from "./surface";

function sourcePixels(doc: StrataDoc, src: CalcSource, flat: HTMLCanvasElement | null): Uint8ClampedArray | null {
  if (src.layerId === "merged") {
    if (!flat) return null;
    return readPixels(flat).data;
  }
  if (src.channel.startsWith("alpha:")) {
    const id = src.channel.slice(6);
    const ch = alphaChannelsOf(doc).find((c) => c.id === id);
    return ch ? readPixels(ch.mask).data : null;
  }
  const layer = doc.layers.find((l) => l.id === src.layerId);
  if (!layer || layer.kind !== "pixel") return null;
  return readPixels(layer.surface).data;
}

export interface CalculationResult {
  image: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  values: Uint8ClampedArray;
}

/** 运算失败时返回 null（来源图层 / 通道不存在），调用方给出明确提示。 */
export function computeCalculation(doc: StrataDoc, params: CalcParams): CalculationResult | null {
  const needsFlat =
    params.source1.layerId === "merged" ||
    params.source2.layerId === "merged";
  let flat: HTMLCanvasElement | null = null;
  if (needsFlat) {
    flat = createSurface(doc.width, doc.height);
    composeDoc(doc, flat);
  }
  const a = sourcePixels(doc, params.source1, flat);
  const b = sourcePixels(doc, params.source2, flat);
  if (!a || !b) return null;
  const values = blendCalcChannels(
    sampleCalcChannel(a, params.source1.channel),
    sampleCalcChannel(b, params.source2.channel),
    params,
  );
  // sampleCalcChannel 得到的长度就是像素数；写回画布时还原成 RGBA
  const image = createSurface(doc.width, doc.height);
  const mask = createSurface(doc.width, doc.height);
  writePixels(image, new ImageData(new Uint8ClampedArray(resultToImage(values)), doc.width, doc.height));
  writePixels(mask, new ImageData(new Uint8ClampedArray(resultToMask(values)), doc.width, doc.height));
  return { image, mask, values };
}

/** 让「运算结果」落进文档：存成新 Alpha 通道，或替换当前选区。 */
export function applyCalculation(
  doc: StrataDoc,
  mask: HTMLCanvasElement,
  result: "channel" | "selection",
  name: string,
): StrataDoc {
  if (result === "selection") {
    return { ...doc, selection: mask, dirty: true };
  }
  const channels = alphaChannelsOf(doc).slice();
  channels.push({
    id: `alpha-${Date.now().toString(36)}-${channels.length + 1}`,
    name: name.trim() || `Alpha ${channels.length + 1}`,
    mask,
  });
  return { ...doc, alphaChannels: channels, dirty: true };
}
