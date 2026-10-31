/**
 * 镜头校正 / 自适应广角：几何反畸变内核。
 *
 * 纯函数、不依赖 DOM，node（vitest）可直接断言。自研实现，语义参照
 * Photoshop 同名滤镜：
 *
 * - **镜头校正**：一次把四件事做完 —— 桶形/枕形畸变（径向 r'=r(1+k r²)）、
 *   垂直/水平透视（keystone，按另一轴线性缩放）、横向色差（R/B 通道按不同
 *   半径缩放后分别重采样）、晕影（径向增益，负值消除暗角、正值加暗角）。
 * - **自适应广角**：直线投影（rectilinear, r = f·tanθ）与等距鱼眼
 *   （equidistant fisheye, r = f·θ）之间的互换，用 r_src = atan(r·t)/atan(t)
 *   及其反函数做径向重采样 —— 这是真实鱼眼镜头去畸变的数学形式，
 *   而不是随便拉一个经验曲线。
 */
import { makeBuffer, type RgbaBuffer } from "./kernels";

/** 单通道双线性采样（越界夹边）。 */
function sampleChannel(src: RgbaBuffer, x: number, y: number, ch: number): number {
  const { width: w, height: h, data } = src;
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const p00 = data[(y0 * w + x0) * 4 + ch];
  const p10 = data[(y0 * w + x1) * 4 + ch];
  const p01 = data[(y1 * w + x0) * 4 + ch];
  const p11 = data[(y1 * w + x1) * 4 + ch];
  return (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
}

/** 四通道双线性采样。 */
function sampleRgba(src: RgbaBuffer, x: number, y: number, out: Uint8ClampedArray, o: number): void {
  for (let c = 0; c < 4; c += 1) out[o + c] = sampleChannel(src, x, y, c);
}

/**
 * 镜头校正。
 * - distortion：正值修正桶形（把边缘往里收），负值修正枕形
 * - vertical / horizontal：透视校正（keystone），正负决定收哪一头
 * - ca：横向色差校正半径（像素），正值把红通道外扩、蓝通道内收
 * - vignette：负值去暗角、正值加暗角；midpoint 是晕影起始半径百分比
 */
export function lensCorrection(
  src: RgbaBuffer,
  distortion: number,
  vertical: number,
  horizontal: number,
  ca: number,
  vignette: number,
  midpoint: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.max(1, Math.hypot(cx, cy));
  const k = (distortion / 100) * 0.5;
  const vk = (vertical / 100) * 0.5;
  const hk = (horizontal / 100) * 0.5;
  const caR = ca;
  const vig = vignette / 100;
  const mid = Math.min(0.98, Math.max(0.02, midpoint / 100));
  const hasCa = Math.abs(ca) > 0.01;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      // 以画布中心为原点的归一化坐标
      let nx = (x - cx) / R;
      let ny = (y - cy) / R;
      // 透视：按另一轴线性缩放（keystone）
      if (vk !== 0) nx *= 1 + vk * ny;
      if (hk !== 0) ny *= 1 + hk * nx;
      // 径向畸变
      if (k !== 0) {
        const r2 = nx * nx + ny * ny;
        const f = 1 + k * r2;
        nx *= f;
        ny *= f;
      }
      const sx = cx + nx * R;
      const sy = cy + ny * R;
      const o = (y * w + x) * 4;
      if (hasCa) {
        // 色差：R 与 B 各按不同半径缩放，G 保持不变（人眼对绿最敏感）
        const rl = Math.hypot(nx, ny) || 1e-6;
        const kr = 1 + caR / (rl * R);
        const kb = 1 - caR / (rl * R);
        out.data[o] = sampleChannel(src, cx + nx * kr * R, cy + ny * kr * R, 0);
        out.data[o + 1] = sampleChannel(src, sx, sy, 1);
        out.data[o + 2] = sampleChannel(src, cx + nx * kb * R, cy + ny * kb * R, 2);
        out.data[o + 3] = sampleChannel(src, sx, sy, 3);
      } else {
        sampleRgba(src, sx, sy, out.data, o);
      }
      // 晕影：径向增益
      if (vig !== 0) {
        const rd = Math.hypot((x - cx) / R, (y - cy) / R);
        const t = Math.max(0, (rd - mid) / Math.max(0.02, 1 - mid));
        const gain = 1 - vig * t * t;
        for (let c = 0; c < 3; c += 1) {
          const v = out.data[o + c] * gain;
          out.data[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
  }
  return out;
}

/**
 * 自适应广角：直线投影 ↔ 等距鱼眼 的径向互换。
 * mode=0 鱼眼去畸变（变成直线投影），mode=1 反向（做鱼眼效果）。
 * strength 控制视场角：越大越接近超广角。
 */
export function adaptiveWideAngle(src: RgbaBuffer, strength: number, mode: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.max(1, Math.hypot(cx, cy));
  const t = 0.35 + (Math.min(100, Math.max(1, strength)) / 100) * 3;
  const at = Math.atan(t);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = (x - cx) / R;
      const ny = (y - cy) / R;
      const r = Math.hypot(nx, ny);
      const o = (y * w + x) * 4;
      if (r < 1e-6) {
        sampleRgba(src, x, y, out.data, o);
        continue;
      }
      // 直线 r = tanθ  ↔  等距鱼眼 r = θ
      const rs =
        mode === 1
          ? Math.tan(r * at) / t
          : Math.atan(r * t) / at;
      const f = rs / r;
      sampleRgba(src, cx + nx * f * R, cy + ny * f * R, out.data, o);
    }
  }
  return out;
}
