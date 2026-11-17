/**
 * 镜头畸变模型：Brown–Conrady 径向/切向畸变 + 通用镜头配置文件。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/lens.rs), MIT / Apache-2.0。
 * 纯函数，只吃数字与 RgbaBuffer，不碰 DOM。
 */
import { makeBuffer, type RgbaBuffer } from "../filters/kernels";

export interface LensProfile {
  name: string;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
  /** 晕影衰减 1 + v1 r² + v2 r⁴ + v3 r⁶。 */
  vignette: readonly [number, number, number];
  /** 相对绿通道的红/蓝径向缩放偏移。 */
  caRed: number;
  caBlue: number;
}

/** 按 35mm 等效焦距插值典型镜头行为（对数焦距插值）。 */
export function genericProfile(focal35mm: number): LensProfile {
  // (focal, k1, k2, v1, v2)
  const table: readonly (readonly [number, number, number, number, number])[] = [
    [12, -0.16, 0.04, -0.60, 0.15],
    [16, -0.11, 0.025, -0.50, 0.12],
    [24, -0.06, 0.012, -0.38, 0.08],
    [35, -0.025, 0.004, -0.28, 0.05],
    [50, 0, 0, -0.22, 0.04],
    [85, 0.012, 0, -0.16, 0.02],
    [200, 0.02, 0, -0.10, 0.01],
  ];
  const f = Math.min(table[table.length - 1][0], Math.max(table[0][0], focal35mm));
  let k = 0;
  while (k < table.length - 2 && f > table[k + 1][0]) k += 1;
  const a = table[k];
  const b = table[k + 1];
  const t = (Math.log(f) - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]));
  const mix = (x: number, y: number) => x + (y - x) * t;
  return {
    name: `通用镜头 ${Math.round(focal35mm)}mm`,
    k1: mix(a[1], b[1]),
    k2: mix(a[2], b[2]),
    p1: 0,
    p2: 0,
    vignette: [mix(a[3], b[3]), mix(a[4], b[4]), 0],
    caRed: 0,
    caBlue: 0,
  };
}

/**
 * Brown–Conrady 逆映射：输出点 (x,y) 应去源图哪里取样。
 * 归一化坐标以画面半对角线为 1。
 */
export function brownConrady(
  x: number,
  y: number,
  k1: number,
  k2: number,
  p1: number,
  p2: number,
): [number, number] {
  const r2 = x * x + y * y;
  const radial = 1 + k1 * r2 + k2 * r2 * r2;
  const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
  const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
  return [x * radial + dx, y * radial + dy];
}

/** 镜头配置文件里的晕影衰减系数（1 + v1 r² + v2 r⁴ + v3 r⁶）。 */
export function vignetteFalloff(profile: LensProfile, r: number): number {
  const r2 = r * r;
  return Math.max(0.05, 1 + profile.vignette[0] * r2 + profile.vignette[1] * r2 * r2 + profile.vignette[2] * r2 ** 3);
}

/** 单点双线性采样，越界夹边（与现有 filter.lens.ts 的语义一致）。 */
function sample(src: RgbaBuffer, x: number, y: number, out: Uint8ClampedArray, o: number): void {
  const { width: w, height: h, data } = src;
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  for (let c = 0; c < 4; c += 1) {
    const p00 = data[(y0 * w + x0) * 4 + c];
    const p10 = data[(y0 * w + x1) * 4 + c];
    const p01 = data[(y1 * w + x0) * 4 + c];
    const p11 = data[(y1 * w + x1) * 4 + c];
    out[o + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
  }
}

export interface ProfileApplyOptions {
  /** 手动追加的二阶径向与切向系数。 */
  k2?: number;
  p1?: number;
  p2?: number;
  /** 手动色差校正（像素），正值红通道外扩、蓝通道内收。 */
  ca?: number;
  /** 手动晕影量，-100 去暗角 / +100 加暗角。 */
  vignette?: number;
  /** 晕影起始半径 0.02~0.98。 */
  midpoint?: number;
  /** 垂直/水平透视（keystone），按另一轴线性缩放。 */
  vertical?: number;
  horizontal?: number;
  /** 是否把配置文件里的晕影衰减除掉，默认 true。 */
  undoProfileVignette?: boolean;
}

/** 用配置文件 + 手动参数对图像做逆映射校正。 */
export function applyLensProfile(
  src: RgbaBuffer,
  profile: LensProfile,
  opts: ProfileApplyOptions = {},
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.max(1, Math.hypot(cx, cy));
  const k1 = profile.k1;
  const k2 = profile.k2 + (opts.k2 ?? 0);
  const p1 = profile.p1 + (opts.p1 ?? 0);
  const p2 = profile.p2 + (opts.p2 ?? 0);
  const ca = opts.ca ?? 0;
  const vig = (opts.vignette ?? 0) / 100;
  const mid = Math.min(0.98, Math.max(0.02, opts.midpoint ?? 50) / 100);
  const undoVig = opts.undoProfileVignette ?? true;
  const vk = opts.vertical ?? 0;
  const hk = opts.horizontal ?? 0;
  const hasPerspective = Math.abs(vk) > 1e-6 || Math.abs(hk) > 1e-6;
  const hasCa = Math.abs(ca) > 0.01 || Math.abs(profile.caRed) > 1e-6 || Math.abs(profile.caBlue) > 1e-6;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let nx = (x - cx) / R;
      let ny = (y - cy) / R;
      const r = Math.hypot(nx, ny);
      if (hasPerspective) {
        const px = vk !== 0 ? nx * (1 + vk * ny) : nx;
        const py = hk !== 0 ? ny * (1 + hk * px) : ny;
        nx = px;
        ny = py;
      }
      const [mx, my] = brownConrady(nx, ny, k1, k2, p1, p2);
      const sx = cx + mx * R;
      const sy = cy + my * R;
      const o = (y * w + x) * 4;
      if (hasCa) {
        const cr = 1 + profile.caRed + (r > 1e-6 ? ca / (r * R) : 0);
        const cb = 1 + profile.caBlue - (r > 1e-6 ? ca / (r * R) : 0);
        sample(src, cx + mx * cr * R, cy + my * cr * R, out.data, o);
        const gm = new Uint8ClampedArray(4);
        sample(src, sx, sy, gm, 0);
        const bm = new Uint8ClampedArray(4);
        sample(src, cx + mx * cb * R, cy + my * cb * R, bm, 0);
        out.data[o + 1] = gm[1];
        out.data[o + 2] = bm[2];
        out.data[o + 3] = gm[3];
      } else {
        sample(src, sx, sy, out.data, o);
      }

      if (undoVig && r > 1e-6) {
        const gain = 1 / vignetteFalloff(profile, r);
        for (let c = 0; c < 3; c += 1) out.data[o + c] *= gain;
      }
      if (vig !== 0) {
        const t = Math.max(0, (r - mid) / Math.max(0.02, 1 - mid));
        const gain = 1 - vig * t * t;
        for (let c = 0; c < 3; c += 1) out.data[o + c] *= gain;
      }
    }
  }
  return out;
}
