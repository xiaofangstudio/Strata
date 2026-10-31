/**
 * 渲染类滤镜内核：镜头光晕 / 树 / 火焰 / 画框 / 光照效果。
 *
 * 纯函数、不依赖 DOM；node（vitest）可直接断言。算法自研：
 * - 镜头光晕 = 核心辉光 + 光晕环 + 沿光心到画心连线排布的鬼影圆盘 +
 *   一道横向光条，三种镜头类型只在鬼影数量/大小/色调上不同
 *   （对应 PS 的「50-300 毫米变焦 / 35 毫米定焦 / 105 毫米定焦」）。
 * - 树 = 带随机扰动的递归分枝 + 末端叶团，线段用带半径圆盘步进绘制。
 * - 火焰 = 湍流噪声驱动的焰心距离场（mode 1 时为 IFS 分形火焰）。
 * - 光照效果 = 把亮度当高度场求法线，再做一次 Phong（漫反射 + 高光）。
 */
import { rng, valueNoise, type RgbaBuffer } from "./kernels";

/** 在当前像素上做 source-over 混合。 */
function blendPixel(d: Uint8ClampedArray, o: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const ia = 1 - a;
  d[o] = r * a + d[o] * ia;
  d[o + 1] = g * a + d[o + 1] * ia;
  d[o + 2] = b * a + d[o + 2] * ia;
  d[o + 3] = a * 255 + d[o + 3] * ia;
}

/** 画一个软边圆盘 / 圆环（用于光晕与树干笔刷）。 */
function paintDisc(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  rgb: readonly [number, number, number],
  soft: number,
): void {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r - soft));
  const x1 = Math.min(w - 1, Math.ceil(cx + r + soft));
  const y0 = Math.max(0, Math.floor(cy - r - soft));
  const y1 = Math.min(h - 1, Math.ceil(cy + r + soft));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > r + soft) continue;
      const edge = soft <= 0 ? 1 : Math.min(1, (r + soft - dist) / (soft * 2));
      blendPixel(d, (y * w + x) * 4, rgb[0], rgb[1], rgb[2], edge);
    }
  }
}

/** 沿线段步进画若干圆盘，得到一条有粗细的线。 */
function paintLine(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thick: number,
  rgb: readonly [number, number, number],
): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    paintDisc(d, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thick / 2, rgb, thick > 3 ? 1.2 : 0.6);
  }
}

/* -------------------------------------------------------------- 镜头光晕 */

/** 镜头光晕：太阳 / 强光进入镜筒后的整套光学伪像。 */
export function lensFlare(
  src: RgbaBuffer,
  xPct: number,
  yPct: number,
  brightness: number,
  type: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const fx = ((w - 1) * xPct) / 100;
  const fy = ((h - 1) * yPct) / 100;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const unit = Math.max(1, Math.min(w, h) / 2);
  const k = brightness / 100;
  const ghosts: { t: number; size: number; tint: readonly [number, number, number] }[] =
    type === 1
      ? [
          { t: 0.35, size: 0.1, tint: [120, 160, 255] },
          { t: 0.55, size: 0.06, tint: [255, 190, 120] },
          { t: 0.8, size: 0.14, tint: [160, 220, 255] },
        ]
      : type === 2
        ? [
            { t: 0.45, size: 0.08, tint: [255, 200, 140] },
            { t: 0.62, size: 0.05, tint: [150, 190, 255] },
            { t: 0.72, size: 0.11, tint: [255, 240, 200] },
            { t: 0.9, size: 0.04, tint: [200, 160, 255] },
          ]
        : [
            { t: 0.4, size: 0.07, tint: [255, 210, 150] },
            { t: 0.6, size: 0.12, tint: [140, 180, 255] },
            { t: 0.85, size: 0.05, tint: [255, 170, 220] },
          ];

  const layer = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < layer.length; i += 4) layer[i] = 255;

  // 1) 核心辉光 + 外晕
  paintDisc(layer, w, h, fx, fy, unit * 0.06, [255, 255, 255], unit * 0.12);
  paintDisc(layer, w, h, fx, fy, unit * 0.02 * k, [255, 255, 255], unit * 0.05);
  // 2) 横向光条
  for (let i = -1; i <= 1; i += 2) {
    paintLine(layer, w, h, fx, fy, fx + i * unit * 0.9, fy + i * unit * 0.06, 3, [255, 250, 230]);
  }
  // 3) 鬼影：沿「光心 → 画心」连线的镜像位置排布
  for (const g of ghosts) {
    const gx = fx + (cx - fx) * 2 * g.t;
    const gy = fy + (cy - fy) * 2 * g.t;
    paintDisc(layer, w, h, gx, gy, unit * g.size, g.tint, unit * g.size * 0.25);
  }
  // 4) 光晕环
  paintDisc(layer, w, h, fx, fy, unit * 0.28, [200, 210, 255], unit * 0.02);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const a = layer[o + 3] / 255;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const v = out.data[o + c] + layer[o + c] * a * k;
        out.data[o + c] = v > 255 ? 255 : v;
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------- 树 */

/**
 * 树：递归分枝 + 末端叶团。
 * seed 决定姿态，spread 是张开角，depth 是递归层数，leaves 是叶色方案。
 */
export function tree(
  src: RgbaBuffer,
  seed: number,
  spreadDeg: number,
  depth: number,
  leaves: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const rand = rng(seed || 1);
  const bark: readonly [number, number, number] = [92, 66, 48];
  const leafRgb: readonly [number, number, number] =
    leaves === 1 ? [232, 170, 200] : leaves === 2 ? [244, 208, 96] : [74, 150, 72];
  const baseLen = Math.max(6, h * 0.18);
  const spread = (spreadDeg * Math.PI) / 180;

  const grow = (x: number, y: number, ang: number, len: number, thick: number, level: number): void => {
    if (level > depth || len < 1.5 || thick < 0.4) return;
    const jitter = (rand() - 0.5) * spread * 0.5;
    const a = ang + jitter;
    const x1 = x + Math.cos(a) * len;
    const y1 = y + Math.sin(a) * len;
    paintLine(out.data, w, h, x, y, x1, y1, thick, bark);
    if (level === depth) {
      paintDisc(out.data, w, h, x1, y1, Math.max(1.5, len * 0.55), leafRgb, Math.max(1, len * 0.3));
    }
    grow(x1, y1, a - spread * (0.7 + rand() * 0.5), len * 0.74, thick * 0.66, level + 1);
    grow(x1, y1, a + spread * (0.7 + rand() * 0.5), len * 0.74, thick * 0.66, level + 1);
    if (rand() > 0.65) grow(x1, y1, a + (rand() - 0.5) * 0.4, len * 0.6, thick * 0.6, level + 1);
  };

  grow(w / 2, h * 0.98, -Math.PI / 2, baseLen, Math.max(2, h * 0.022), 1);
  return out;
}

/* ------------------------------------------------------------------ 火焰 */

/** 火焰：mode=0 湍流噪声距离场，mode=1 IFS 分形火焰。 */
export function flame(
  src: RgbaBuffer,
  seed: number,
  turbulence: number,
  brightness: number,
  mode: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const k = brightness / 100;
  if (mode === 1) {
    // IFS 分形火焰：三个非线性变体按权重随机迭代，落点累积成密度图
    const acc = new Float32Array(w * h);
    const counts = new Float32Array(w * h);
    let x = 0.1;
    let y = 0.1;
    const rand = rng(seed || 3);
    const iters = Math.min(400_000, Math.max(20_000, Math.round(w * h * 1.5)));
    for (let i = 0; i < iters; i += 1) {
      const r = rand();
      let nx: number;
      let ny: number;
      if (r < 0.34) {
        nx = Math.sin(x) + Math.cos(y);
        ny = Math.sin(y) - Math.cos(x);
      } else if (r < 0.67) {
        const rr = Math.hypot(x, y) || 1e-6;
        nx = (x / rr) * (Math.sin(rr * 2.1) + 0.6);
        ny = (y / rr) * (Math.cos(rr * 2.1) + 0.6);
      } else {
        nx = (x + y) * 0.7 - 0.2;
        ny = (y - x) * 0.7 + 0.3;
      }
      x = nx;
      y = ny;
      if (i < 200) continue;
      const px = Math.round(((x + 3) / 6) * (w - 1));
      const py = Math.round(((y + 3) / 6) * (h - 1));
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      acc[py * w + px] += 1;
      counts[py * w + px] += 1;
    }
    let maxV = 0;
    for (let i = 0; i < acc.length; i += 1) if (acc[i] > maxV) maxV = acc[i];
    if (maxV <= 0) return out;
    for (let y2 = 0; y2 < h; y2 += 1) {
      for (let x2 = 0; x2 < w; x2 += 1) {
        const i = y2 * w + x2;
        if (acc[i] <= 0) continue;
        const t = Math.pow(acc[i] / maxV, 0.4) * k;
        const o = i * 4;
        out.data[o] = Math.min(255, out.data[o] + 255 * t);
        out.data[o + 1] = Math.min(255, out.data[o + 1] + 210 * t * t);
        out.data[o + 2] = Math.min(255, out.data[o + 2] + 120 * t * t * t);
      }
    }
    return out;
  }
  const turb = turbulence / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const u = x / Math.max(1, w - 1) - 0.5;
      const v = y / Math.max(1, h - 1);
      const wobble = (valueNoise(x / 26, y / 26 + v * 2, seed) - 0.5) * turb * (0.25 + v);
      const halfWidth = Math.max(0.01, 0.42 * (1 - v) ** 0.7 + 0.02);
      const d = Math.abs(u + wobble) / halfWidth;
      if (d >= 1) continue;
      const heat = Math.max(0, 1 - d) * Math.max(0, 1 - v * 0.55) * k;
      const o = (y * w + x) * 4;
      out.data[o] = Math.min(255, out.data[o] + 255 * heat);
      out.data[o + 1] = Math.min(255, out.data[o + 1] + 200 * heat ** 1.6);
      out.data[o + 2] = Math.min(255, out.data[o + 2] + 90 * heat ** 2.6);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 画框 */

/** 画框：给画面加一圈带斜面的装饰边框。 */
export function pictureFrame(src: RgbaBuffer, thickness: number, style: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const t = Math.max(1, Math.round(thickness));
  const frame: readonly [number, number, number] = style === 2 ? [42, 30, 22] : [58, 58, 62];
  const hi: readonly [number, number, number] = [214, 206, 190];
  const lo: readonly [number, number, number] = [18, 16, 14];
  const corner = style === 2 ? t * 1.6 : 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      let inside = dx < t || dy < t;
      if (corner > 0) {
        const rx = Math.min(x, w - 1 - x) - t;
        const ry = Math.min(y, h - 1 - y) - t;
        if (rx < 0 && ry < 0 && Math.hypot(rx, ry) > corner) inside = true;
      }
      if (!inside) continue;
      const edge = Math.min(dx, dy);
      const rgb = edge === 0 || edge === t - 1 ? (x + y > w / 2 + h / 2 - t * 2 ? lo : hi) : frame;
      blendPixel(out.data, (y * w + x) * 4, rgb[0], rgb[1], rgb[2], 1);
    }
  }
  if (style === 1) {
    for (let i = 0; i < w; i += 1) {
      blendPixel(out.data, (t * 2 * w + i) * 4, hi[0], hi[1], hi[2], 0.8);
      blendPixel(out.data, ((h - 1 - t * 2) * w + i) * 4, hi[0], hi[1], hi[2], 0.8);
    }
    for (let i = 0; i < h; i += 1) {
      blendPixel(out.data, (i * w + t * 2) * 4, hi[0], hi[1], hi[2], 0.8);
      blendPixel(out.data, (i * w + (w - 1 - t * 2)) * 4, hi[0], hi[1], hi[2], 0.8);
    }
  }
  return out;
}

/* -------------------------------------------------------------- 光照效果 */

/**
 * 光照效果：把亮度当高度场求法线，做一次 Phong。
 * gloss 越大高光越锐，material 越大越像塑料（非金属），exposure 是曝光补偿。
 */
export function lightingEffects(
  src: RgbaBuffer,
  angleDeg: number,
  elevationDeg: number,
  ambientPct: number,
  glossPct: number,
  materialPct: number,
  exposurePct: number,
): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = { data: new Uint8ClampedArray(data), width: w, height: h };
  const az = (angleDeg * Math.PI) / 180;
  const el = (Math.min(89, Math.max(1, elevationDeg)) * Math.PI) / 180;
  const lx = Math.cos(el) * Math.cos(az);
  const ly = Math.cos(el) * Math.sin(az);
  const lz = Math.sin(el);
  const hx = lx;
  const hy = ly;
  const hz = lz + 1;
  const hl = Math.hypot(hx, hy, hz) || 1;
  const ambient = ambientPct / 100;
  const gloss = glossPct / 100;
  const material = materialPct / 100;
  const exposure = exposurePct / 100;
  const shininess = 4 + gloss * 60;
  const bump = 2 + gloss * 6;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) lum[i] = luma(data, i * 4) / 255;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const o = i * 4;
      const l = lum[Math.min(h - 1, y + 1) * w + x] - lum[Math.max(0, y - 1) * w + x];
      const r = lum[y * w + Math.min(w - 1, x + 1)] - lum[y * w + Math.max(0, x - 1)];
      const nx = -r * bump * 8;
      const ny = -l * bump * 8;
      const nl = Math.hypot(nx, ny, 1) || 1;
      const ux = nx / nl;
      const uy = ny / nl;
      const uz = 1 / nl;
      const diff = Math.max(0, ux * lx + uy * ly + uz * lz);
      const specDot = Math.max(0, (ux * hx + uy * hy + uz * hz) / hl);
      const spec = Math.pow(specDot, shininess) * gloss;
      const shade = ambient + (1 - ambient) * diff;
      for (let c = 0; c < 3; c += 1) {
        const metallic = material > 0.5 ? 1 : 0;
        const base = data[o + c] * shade * exposure;
        const tinted = data[o + c] / 255;
        const specColor = (metallic ? tinted : 1) * spec * 255;
        const v = base + specColor;
        out.data[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return out;
}

function luma(d: Uint8ClampedArray, o: number): number {
  return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
}
