/**
 * Calculations 的画布薄壳：从图层 / Alpha 通道取像素，交给纯函数运算，
 * 同时产出「灰度显示图」与「选区遮罩」两张画布，预览与落库同源。
 */
import type { StrataDoc } from "../core/document";
import { alphaChannelsOf } from "../core/channelOps";
import {
  blendCalcChannels,
  calcUsesIccGray,
  grayFromIccOutput,
  resultToImage,
  resultToMask,
  sampleCalcChannel,
  type CalcColorContext,
  type CalcChannel,
  type CalcParams,
  type CalcSource,
} from "../core/calculations";
import { builtinProfile, iccTransform } from "./cms";
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
  /** 本次 Gray 是否真的走了 ICC；失败回退 Rec.601 时为 false。 */
  iccGray: boolean;
}

/**
 * 取单通道。RGB / 8bit / sRGB 的 Gray 走真 ICC sRGB → GrayGamma22；
 * ICC 不可用时明确回退到旧的 Rec.601 公式，不让预览卡住。
 */
export async function sampleCalculationChannel(
  ctx: CalcColorContext,
  data: Uint8Array | Uint8ClampedArray,
  channel: CalcChannel,
): Promise<{ values: Uint8ClampedArray; icc: boolean }> {
  if (channel !== "gray" || !calcUsesIccGray(ctx)) {
    return { values: sampleCalcChannel(data, channel), icc: false };
  }
  try {
    const [src, dst] = await Promise.all([builtinProfile("srgb"), builtinProfile("gray")]);
    const out = await iccTransform(data, src, dst);
    return { values: grayFromIccOutput(out, Math.floor(data.length / 4)), icc: true };
  } catch {
    return { values: sampleCalcChannel(data, channel), icc: false };
  }
}

function prepareSources(doc: StrataDoc, params: CalcParams) {
  const needsFlat =
    params.source1.layerId === "merged" ||
    params.source2.layerId === "merged";
  let flat: HTMLCanvasElement | null = null;
  if (needsFlat) {
    flat = createSurface(doc.width, doc.height);
    composeDoc(doc, flat);
  }
  return {
    a: sourcePixels(doc, params.source1, flat),
    b: sourcePixels(doc, params.source2, flat),
  };
}

function toResult(doc: StrataDoc, values: Uint8ClampedArray, iccGray: boolean): CalculationResult {
  const image = createSurface(doc.width, doc.height);
  const mask = createSurface(doc.width, doc.height);
  writePixels(image, new ImageData(new Uint8ClampedArray(resultToImage(values)), doc.width, doc.height));
  writePixels(mask, new ImageData(new Uint8ClampedArray(resultToMask(values)), doc.width, doc.height));
  return { image, mask, values, iccGray };
}

/** 同步版本（旧调用方兼容）：不触碰 ICC，只在非 UI 场合使用。 */
export function computeCalculation(doc: StrataDoc, params: CalcParams): CalculationResult | null {
  const { a, b } = prepareSources(doc, params);
  if (!a || !b) return null;
  return toResult(
    doc,
    blendCalcChannels(
      sampleCalcChannel(a, params.source1.channel),
      sampleCalcChannel(b, params.source2.channel),
      params,
    ),
    false,
  );
}

/** UI 真用版本：预览与落库都走同一份 ICC 感知结果。 */
export async function computeCalculationAsync(
  doc: StrataDoc,
  params: CalcParams,
): Promise<CalculationResult | null> {
  const { a, b } = prepareSources(doc, params);
  if (!a || !b) return null;
  const [ca, cb] = await Promise.all([
    sampleCalculationChannel(doc, a, params.source1.channel),
    sampleCalculationChannel(doc, b, params.source2.channel),
  ]);
  return toResult(
    doc,
    blendCalcChannels(ca.values, cb.values, params),
    ca.icc || cb.icc,
  );
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
