/**
 * 色彩配置文件（ICC 空间的矩阵近似）。
 *
 * Strata 的渲染管线固定是 8 位 sRGB，但「编辑 > 指定 / 转换为配置文件」要真的
 * 有意义，就必须真做色彩空间换算。这里用各空间的 **原色矩阵**（D65 白点）
 * 走 线性RGB → XYZ → 目标线性RGB 这条标准链路：
 *
 * - sRGB：IEC 61966-2-1，分段传输函数
 * - Display P3：DCI-P3 原色 + sRGB 传输函数
 * - Adobe RGB (1998)：gamma 2.19921875
 * - 灰度：按 Rec.709 亮度，单通道
 *
 * 「指定配置文件」不改像素（只是换个解释标签）；「转换为配置文件」才走换算 ——
 * 与 Photoshop 的语义一致。矩阵与逆矩阵都是公开标准值，纯函数，可直接断言。
 */
import { makeBuffer, type RgbaBuffer } from "../engine/filters/kernels";

export type ProfileId = "srgb" | "display-p3" | "adobe-rgb" | "gray";

export const PROFILE_LABELS: Record<ProfileId, string> = {
  srgb: "sRGB IEC61966-2.1",
  "display-p3": "Display P3",
  "adobe-rgb": "Adobe RGB (1998)",
  gray: "灰度 Gamma 2.2",
};

type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** 线性 RGB → XYZ（D65）。 */
const TO_XYZ: Record<Exclude<ProfileId, "gray">, Mat3> = {
  srgb: [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041],
  "display-p3": [0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0, 0.0451134, 1.0439444],
  "adobe-rgb": [0.5767309, 0.185554, 0.1881852, 0.2973769, 0.6273491, 0.0752741, 0.0270343, 0.0706872, 0.9911085],
};

/** XYZ → 线性 RGB。 */
const FROM_XYZ: Record<Exclude<ProfileId, "gray">, Mat3> = {
  srgb: [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252],
  "display-p3": [2.4934969, -0.9313836, -0.4027108, -0.829489, 1.7626641, 0.0236247, 0.0358458, -0.0761724, 0.9568845],
  "adobe-rgb": [2.041369, -0.5649464, -0.3446944, -0.969266, 1.8760108, 0.041556, 0.0134474, -0.1183897, 1.0154096],
};

function toLinear(v: number, profile: ProfileId): number {
  const c = v / 255;
  if (profile === "adobe-rgb") return Math.pow(c, 2.19921875);
  // sRGB 与 Display P3 共用同一条分段曲线
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function fromLinear(v: number, profile: ProfileId): number {
  const c = Math.max(0, v);
  if (profile === "adobe-rgb") return Math.pow(c, 1 / 2.19921875) * 255;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return s * 255;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * 把像素从 from 空间换算到 to 空间。
 * 灰度 ↔ 彩色：灰度按 Rec.709 亮度写入/读出三通道。
 */
export function convertProfile(src: RgbaBuffer, from: ProfileId, to: ProfileId): RgbaBuffer {
  const out = makeBuffer(src.width, src.height);
  if (from === to) {
    out.data.set(src.data);
    return out;
  }
  const d = src.data;
  for (let p = 0; p < src.width * src.height; p += 1) {
    const o = p * 4;
    if (from === "gray") {
      // 灰度 → 彩色：单通道值当作目标空间的中性灰
      const g = d[o];
      out.data[o] = g;
      out.data[o + 1] = g;
      out.data[o + 2] = g;
      out.data[o + 3] = d[o + 3];
      continue;
    }
    const rl = toLinear(d[o], from);
    const gl = toLinear(d[o + 1], from);
    const bl = toLinear(d[o + 2], from);
    const m = TO_XYZ[from];
    const X = m[0] * rl + m[1] * gl + m[2] * bl;
    const Y = m[3] * rl + m[4] * gl + m[5] * bl;
    const Z = m[6] * rl + m[7] * gl + m[8] * bl;
    if (to === "gray") {
      const y = clamp255(fromLinear(Y, "srgb"));
      out.data[o] = y;
      out.data[o + 1] = y;
      out.data[o + 2] = y;
      out.data[o + 3] = d[o + 3];
      continue;
    }
    const n = FROM_XYZ[to];
    const rr = n[0] * X + n[1] * Y + n[2] * Z;
    const gg = n[3] * X + n[4] * Y + n[5] * Z;
    const bb = n[6] * X + n[7] * Y + n[8] * Z;
    out.data[o] = clamp255(fromLinear(rr, to));
    out.data[o + 1] = clamp255(fromLinear(gg, to));
    out.data[o + 2] = clamp255(fromLinear(bb, to));
    out.data[o + 3] = d[o + 3];
  }
  return out;
}
