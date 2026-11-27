/**
 * Camera Raw → 真 RAW 线性显影参数映射。
 *
 * 非 RAW 图继续用 8bit 调整层；RAW 图则把滑杆值翻译成 Rust 侧
 * `develop_raw_display` 能直接吃进线性域的参数：白平衡乘数、曝光 EV、
 * 影调滑杆、线性曲线节点。这里不做像素运算，只做纯函数映射，便于测试。
 */
import { adjustDef } from "./layer";
import { presetCurveLut } from "../engine/algos/cameraRaw";
import { srgbToLinear } from "../engine/filters";

export interface RawMeta {
  source: "sensor" | "embedded-preview";
  wbMultipliers: [number, number, number];
  baselineExposure: number;
  orientation: number;
  cfa: string | null;
}

export interface RawToneParams {
  shadows: number;
  highlights: number;
  clarity: number;
  texture: number;
  dehaze: number;
}

export interface RawDevelopParams {
  whiteBalance: "asShot" | "auto" | "custom";
  wbMultipliers: [number, number, number] | null;
  exposure: number;
  tone: RawToneParams;
  curveKnots: [number, number][];
}

export interface RawDevelopState {
  path: string;
  meta: RawMeta;
  /** Rust 线性显影参数 */
  params: RawDevelopParams;
  /** 对应滑杆的原始 UI 值；重开对话框时恢复滑杆位置 */
  ui: Record<string, number>;
}

const clamp = (v: number, min: number, max: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : 0;

/** Camera Raw 18 参数的默认中性值（不复制定义表）。 */
export function defaultRawUiParams(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of adjustDef("cameraraw").params) out[p.id] = p.def;
  return out;
}

/** UI 预设曲线（显示域控制点）转成线性域节点，供 Rust 的 ToneCurve 语义使用。 */
export function curvePresetToLinearKnots(preset: number): [number, number][] {
  const lut = presetCurveLut(preset);
  const out: [number, number][] = [];
  let last = 0;
  for (let i = 0; i <= 8; i += 1) {
    const sx = i / 8;
    const sy = lut[Math.min(lut.length - 1, Math.round(sx * (lut.length - 1)))];
    const x = srgbToLinear(sx);
    const y = Math.max(last, srgbToLinear(sy));
    if (i > 0 && x <= out[out.length - 1][0]) continue;
    out.push([x, y]);
    last = y;
  }
  out[0] = [0, 0];
  out[out.length - 1] = [1, 1];
  return out;
}

/**
 * 把 18 个 UI 参数映射成线性显影参数。
 *
 * temperature / tint 沿相机通道乘数偏移（Bayer 近似），其余参数直接进
 * 线性域 Tone；曲线先做 sRGB EOTF 反解，避免把显示域控制点塞进线性曲线。
 */
export function uiToRawDevelop(
  params: Record<string, number>,
  meta: RawMeta | null | undefined,
): RawDevelopParams {
  const temperature = clamp(params.temperature ?? 0, -100, 100) / 100;
  const tint = clamp(params.tint ?? 0, -100, 100) / 100;
  const base = meta?.wbMultipliers ?? [1, 1, 1];
  const valid = base.every((v) => Number.isFinite(v) && v > 0);
  const src = valid ? base : [1, 1, 1];
  const custom: [number, number, number] = [
    Math.max(1e-4, src[0] * (1 + 0.35 * temperature)),
    Math.max(1e-4, src[1] * (1 - 0.25 * tint)),
    Math.max(1e-4, src[2] * (1 - 0.35 * temperature)),
  ];
  const tuned = Math.abs(temperature) > 1e-6 || Math.abs(tint) > 1e-6;
  return {
    whiteBalance: tuned ? "custom" : "asShot",
    wbMultipliers: tuned ? custom : null,
    exposure: clamp(params.exposure ?? 0, -5, 5),
    tone: {
      shadows: clamp(params.shadows ?? 0, -100, 100),
      highlights: clamp(params.highlights ?? 0, -100, 100),
      clarity: clamp(params.clarity ?? 0, -100, 100),
      texture: clamp(params.texture ?? 0, -100, 100),
      dehaze: clamp(params.dehaze ?? 0, -100, 100),
    },
    curveKnots: curvePresetToLinearKnots(params.curve ?? 0),
  };
}
