/**
 * Blend If（混合颜色带）的逐像素权重。
 *
 * PS 的「本图层 / 下一图层」各有一对黑白半三角：决定哪些亮度的像素参与混合。
 * 这里把每对滑块建模为 [black, white] 两端 + 各自的羽化宽度；两端都有独立的
 * 半三角斜面， feather = 0 时退化为硬切。纯函数，不碰 canvas。
 */
import type { BlendIfState } from "../core/layer";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 一端斜坡：v <= edge 时 0，v >= edge+width 时 1。 */
function rise(v: number, edge: number, width: number): number {
  if (width <= 0) return v >= edge ? 1 : 0;
  return clamp01((v - edge) / width);
}

/** 一端斜坡：v >= edge 时 0，v <= edge-width 时 1。 */
function fall(v: number, edge: number, width: number): number {
  if (width <= 0) return v <= edge ? 1 : 0;
  return clamp01((edge - v) / width);
}

/** Blend If 是否真的会改变画面（滑块还在默认全范围时不走逐像素路径）。 */
export function blendIfActive(s: BlendIfState | undefined): boolean {
  return Boolean(
    s?.enabled &&
      (s.thisBlack > 0 || s.thisWhite < 255 || s.underBlack > 0 || s.underWhite < 255),
  );
}

/** 单个像素的混合权重（0 = 完全不参与，1 = 原样参与）。 */
export function blendIfWeight(
  thisLum: number,
  underLum: number,
  s: BlendIfState,
): number {
  if (!s.enabled) return 1;
  const f = Math.max(0, s.feather) / 255;
  const thisW =
    rise(thisLum, s.thisBlack / 255, f) * fall(thisLum, s.thisWhite / 255, f);
  const underW =
    rise(underLum, s.underBlack / 255, f) * fall(underLum, s.underWhite / 255, f);
  return clamp01(thisW * underW);
}

/** sRGB 亮度（与色阶吸管同一套权重）。 */
export function luma01(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
