/**
 * 木偶变形（Puppet Warp）核心：带钉点约束的 Moving Least Squares 变形。
 *
 * 算法：Schaefer, McPhail, Warren, "Image Deformation Using Moving Least
 * Squares", SIGGRAPH 2006 —— 相似变换用复数闭式，仿射用 2×2 加权最小二乘。
 *
 * 纯像素、不依赖 DOM，node（vitest）可直接断言。
 * 输入钉点 = { ox, oy 原始位置, x, y 当前位置 }。变形是「反向映射」：
 * 对每个输出像素 v，把 q_i（当前位置）当控制点、p_i（原始位置）当目标，
 * 解一个加权最小二乘相似/仿射变换 f'，再在 f'(v) 处双线性采样源图 ——
 * 这是逆向变形的标准做法（正向映射会在覆盖处出现空洞）。
 *
 * 权重 w_i = 1 / (|v - q_i|² + ε)（α=1），离钉点越近影响越大；
 * 采样出界取边缘延伸（与滤镜内核一致）。
 *
 * 性能：每像素 O(N)（N = 钉点数）。交互预览应在缩小后的缓冲上跑，
 * 确定时才在全分辨率上跑一次 —— 见 PuppetWarpDialog。
 */
import { makeBuffer, sampleBilinear, type RgbaBuffer } from "./filters/kernels";

/** 一个变形钉：原始位置 + 当前位置（同一坐标系，通常是画布坐标）。 */
export interface WarpPin {
  ox: number;
  oy: number;
  x: number;
  y: number;
}

export type MlsMode = "similarity" | "affine";

const EPS = 1e-8;

/**
 * 对 src 做一次 MLS 网格变形，输出同尺寸缓冲。
 * 相似模式至少要 2 个有分布的钉点、仿射至少 3 个不共线，不足时原样返回。
 */
export function mlsWarp(
  src: RgbaBuffer,
  pins: readonly WarpPin[],
  mode: MlsMode = "similarity",
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const minPins = mode === "affine" ? 3 : 2;
  if (pins.length < minPins || !hasSpan(pins)) {
    out.data.set(src.data);
    return out;
  }
  const n = pins.length;
  const qx = new Float64Array(n);
  const qy = new Float64Array(n);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    qx[i] = pins[i].x;
    qy[i] = pins[i].y;
    px[i] = pins[i].ox;
    py[i] = pins[i].oy;
  }

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let sw = 0;
      let pcx = 0;
      let pcy = 0;
      let qcx = 0;
      let qcy = 0;
      let onPin = -1;
      for (let i = 0; i < n; i += 1) {
        const dx = x - qx[i];
        const dy = y - qy[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < EPS) {
          onPin = i;
          break;
        }
        const wi = 1 / d2;
        sw += wi;
        pcx += wi * px[i];
        pcy += wi * py[i];
        qcx += wi * qx[i];
        qcy += wi * qy[i];
      }
      if (onPin >= 0) {
        // 恰好落在钉点上：直接取它的原始位置
        sampleBilinear(src, px[onPin], py[onPin], out.data, o);
        continue;
      }
      pcx /= sw;
      pcy /= sw;
      qcx /= sw;
      qcy /= sw;
      // 累积 q̂（控制点相对质心）与 p̂（目标相对质心）的加权和
      let cre = 0; // similarity: Σ w_i p̂·q̂（复数乘积实部）
      let cim = 0; // similarity: Σ w_i (p̂_y q̂_x − p̂_x q̂_y)
      let f11 = 0; // affine: F = Σ w_i q̂ q̂^T
      let f12 = 0;
      let f22 = 0;
      let g11 = 0; // affine: C = Σ w_i p̂ q̂^T
      let g12 = 0;
      let g21 = 0;
      let g22 = 0;
      for (let i = 0; i < n; i += 1) {
        const dx = x - qx[i];
        const dy = y - qy[i];
        const wi = 1 / (dx * dx + dy * dy);
        const phx = px[i] - pcx;
        const phy = py[i] - pcy;
        const qhx = qx[i] - qcx;
        const qhy = qy[i] - qcy;
        cre += wi * (phx * qhx + phy * qhy);
        cim += wi * (phy * qhx - phx * qhy);
        f11 += wi * qhx * qhx;
        f12 += wi * qhx * qhy;
        f22 += wi * qhy * qhy;
        g11 += wi * phx * qhx;
        g12 += wi * phx * qhy;
        g21 += wi * phy * qhx;
        g22 += wi * phy * qhy;
      }
      const vhx = x - qcx;
      const vhy = y - qcy;
      let sx: number;
      let sy: number;
      if (mode === "affine") {
        const det = f11 * f22 - f12 * f12;
        if (det < EPS) {
          // 退化（共线）：退化为纯平移，至少保证连续
          sx = x + (pcx - qcx);
          sy = y + (pcy - qcy);
        } else {
          // A = C · F⁻¹，再作用到 v̂
          const i11 = f22 / det;
          const i12 = -f12 / det;
          const i21 = i12;
          const i22 = f11 / det;
          // F⁻¹ v̂
          const fx = i11 * vhx + i12 * vhy;
          const fy = i21 * vhx + i22 * vhy;
          sx = pcx + g11 * fx + g12 * fy;
          sy = pcy + g21 * fx + g22 * fy;
        }
      } else {
        const mu = f11 + f22; // Σ w_i |q̂_i|²
        if (mu < EPS) {
          sampleBilinear(src, x, y, out.data, o);
          continue;
        }
        const are = cre / mu;
        const aim = cim / mu;
        // 复数 a = are + i·aim 作用在 v̂ 上
        sx = pcx + are * vhx - aim * vhy;
        sy = pcy + aim * vhx + are * vhy;
      }
      sampleBilinear(src, sx, sy, out.data, o);
    }
  }
  return out;
}

/** 钉点必须有空间分布（全挤在一个点上没有定义）。 */
function hasSpan(pins: readonly WarpPin[]): boolean {
  const x0 = pins[0].x;
  const y0 = pins[0].y;
  for (let i = 1; i < pins.length; i += 1) {
    if (Math.hypot(pins[i].x - x0, pins[i].y - y0) > 1) return true;
  }
  return false;
}
