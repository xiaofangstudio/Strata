/**
 * 色阶三点吸管的纯计算部分（PhotoCraft `layer_picker.rs` 的语义）。
 *
 * 吸管只改**输入色阶**，不碰像素：
 *   · 黑场吸管：把采样亮度设为新的黑场，比它暗的像素直接落到输出 0；
 *   · 白场吸管：把采样亮度设为新的白场，比它亮的像素直接落到输出 255；
 *   · 灰场吸管：保持黑白场不动，只调伽马，让采样亮度映射到中点 128。
 *
 * 纯函数，不碰 DOM / canvas，方便单测；canvas 取色与 UI 接线在 LevelsEditor。
 */

export type LevelPickKind = "black" | "gray" | "white";
export type LevelChannel = "r" | "g" | "b" | "lum";

export interface LevelsPickInput {
  /** 黑场 / 灰场 / 白场吸管。 */
  kind: LevelPickKind;
  black: number;
  white: number;
  gamma: number;
  channel: LevelChannel;
  /** 采样到的 RGB（0–255）。 */
  sample: readonly [number, number, number];
}

export interface LevelsPickResult {
  black: number;
  white: number;
  gamma: number;
}

export const clampLevel = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** 灰度系数（%，10–300）⇄ 中间调在输入轴上的位置。 */
export function gammaMid(ib: number, iw: number, g: number): number {
  const span = Math.max(1, iw - ib);
  return ib + span * Math.pow(0.5, g / 100);
}

export function gammaFromMid(ib: number, iw: number, t: number): number {
  const span = Math.max(1, iw - ib);
  const ratio = clampLevel((t - ib) / span, 0.02, 0.98);
  // ⚠️ 这里原来是 log(0.5) / log(ratio)（分子分母写反）：只有 g=100 时
  // ratio 恰好 0.5 才碰巧对，其余整段灰场手柄和数值都是错位的。
  const g = (100 * Math.log(ratio)) / Math.log(0.5);
  return clampLevel(g, 10, 300);
}

/** 按通道从 RGB 取 0–255 的亮度值。 */
export function sampleLevel(input: LevelsPickInput): number {
  const [r, g, b] = input.sample;
  const v =
    input.channel === "r"
      ? r
      : input.channel === "g"
        ? g
        : input.channel === "b"
          ? b
          : 0.299 * r + 0.587 * g + 0.114 * b;
  return clampLevel(v, 0, 255);
}

/** 计算一次吸管操作后的三项输入色阶。 */
export function levelsFromSample(input: LevelsPickInput): LevelsPickResult {
  const v = Math.round(sampleLevel(input));
  const black = clampLevel(Math.round(input.black), 0, 254);
  const white = clampLevel(Math.round(input.white), black + 1, 255);
  const gamma = clampLevel(Math.round(input.gamma), 10, 300);

  if (input.kind === "black") {
    return { black: clampLevel(v, 0, white - 1), white, gamma };
  }
  if (input.kind === "white") {
    return { black, white: clampLevel(v, black + 1, 255), gamma };
  }
  return { black, white, gamma: gammaFromMid(black, white, v) };
}
