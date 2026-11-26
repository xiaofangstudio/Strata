/**
 * 图像 > 计算（Calculations）的通道运算内核（移植自 PhotoCraft 的 `image.calculations`）。
 *
 * 与旧的「两个 Alpha 通道相加/相减」不同，这里两个来源都可以是任意图层的
 * R / G / B / 灰度 / 透明度，或已存的 Alpha 通道；结果是一张灰度图，可以存成
 * 新 Alpha 通道或载回选区。窗口里显示的正是这张结果灰度图（与参考软件一致）。
 *
 * 像素运算全是纯函数，不碰 DOM；画布只在调用方薄薄包一层。
 */

export type CalcChannel =
  | "gray"
  | "red"
  | "green"
  | "blue"
  | "alpha"
  | `alpha:${string}`;

export type CalcBlend = "normal" | "add" | "subtract" | "multiply" | "screen" | "difference";

export const CALC_BLENDS: readonly CalcBlend[] = [
  "normal",
  "add",
  "subtract",
  "multiply",
  "screen",
  "difference",
];

export interface CalcSource {
  /** 图层 id，或 `merged` 表示合成结果 */
  layerId: string;
  channel: CalcChannel;
}

export interface CalcParams {
  source1: CalcSource;
  source2: CalcSource;
  blend: CalcBlend;
  /** 0–100，混合结果相对第一来源的不透明度 */
  opacity: number;
  /** 1–2，乘法的比例（PS 的 Scale） */
  scale: number;
  /** -255..255，结果偏移（PS 的 Offset） */
  offset: number;
  invert1: boolean;
  invert2: boolean;
  invertResult: boolean;
}

export const DEFAULT_CALC_PARAMS: CalcParams = {
  source1: { layerId: "merged", channel: "gray" },
  source2: { layerId: "merged", channel: "gray" },
  blend: "multiply",
  opacity: 100,
  scale: 1,
  offset: 0,
  invert1: false,
  invert2: false,
  invertResult: false,
};

/** 从一张 RGBA 位图里取单通道，输出每像素一个灰度字节（长度 = 像素数）。 */
export function sampleCalcChannel(data: Uint8Array | Uint8ClampedArray, channel: CalcChannel): Uint8ClampedArray {
  const n = Math.floor(data.length / 4);
  const out = new Uint8ClampedArray(n);
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    if (channel === "alpha" || channel.startsWith("alpha:")) out[p] = data[i + 3];
    else if (channel === "red") out[p] = data[i];
    else if (channel === "green") out[p] = data[i + 1];
    else if (channel === "blue") out[p] = data[i + 2];
    else out[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return out;
}

const clampByte = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));

/** 逐像素混合两条灰度通道；scale / offset / 三处反相都在这里一次算清。 */
export function blendCalcChannels(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  params: Pick<CalcParams, "blend" | "opacity" | "scale" | "offset" | "invert1" | "invert2" | "invertResult">,
): Uint8ClampedArray {
  const n = Math.min(a.length, b.length);
  const out = new Uint8ClampedArray(n);
  const opacity = Math.min(100, Math.max(0, params.opacity)) / 100;
  const scale = Math.min(2, Math.max(1, params.scale));
  const offset = Math.min(255, Math.max(-255, params.offset));
  for (let i = 0; i < n; i += 1) {
    const x = params.invert1 ? 255 - a[i] : a[i];
    const y = params.invert2 ? 255 - b[i] : b[i];
    let mixed: number;
    switch (params.blend) {
      case "normal":
        mixed = y;
        break;
      case "add":
        mixed = x + y;
        break;
      case "subtract":
        mixed = x - y;
        break;
      case "multiply":
        mixed = ((x * y) / 255) * scale;
        break;
      case "screen":
        mixed = 255 - ((255 - x) * (255 - y)) / 255;
        break;
      case "difference":
        mixed = Math.abs(x - y);
        break;
      default:
        mixed = y;
    }
    mixed = clampByte(mixed + offset);
    // 不透明度作用于「结果相对第一来源」的混合，与参考软件的 50% 灰结果一致
    mixed = clampByte(x + (mixed - x) * opacity);
    out[i] = clampByte(params.invertResult ? 255 - mixed : mixed);
  }
  return out;
}

/** 结果灰度 → 显示用的 RGBA（RGB 同值、alpha 全不透明）。 */
export function resultToImage(values: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i += 1) {
    const o = i * 4;
    out[o] = values[i];
    out[o + 1] = values[i];
    out[o + 2] = values[i];
    out[o + 3] = 255;
  }
  return out;
}

/** 结果灰度 → 选区 / Alpha 通道用的遮罩（RGB 白、alpha 即选中程度）。 */
export function resultToMask(values: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i += 1) {
    const o = i * 4;
    out[o] = 255;
    out[o + 1] = 255;
    out[o + 2] = 255;
    out[o + 3] = values[i];
  }
  return out;
}
