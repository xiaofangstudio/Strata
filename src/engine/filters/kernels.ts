/**
 * 滤镜像素内核（纯函数，不依赖 DOM / Canvas）。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src), MIT / Apache-2.0。
 * 算法语义对照 Rust 原实现移植：可分离高斯核、三趟盒式模糊逼近大半径
 * 高斯（Kovesi, "Fast almost-Gaussian filtering", 2010）、运行和盒式模糊、
 * USM 锐化、加性杂色。RGBA 均按预乘 alpha 处理，避免半透明边缘出现光晕。
 *
 * 缓冲统一用 { data, width, height } 结构而不是 ImageData —— 这样 node
 * 环境（vitest）可以直接对 4×4 固定像素做断言，UI 层再包一层即可。
 */

export interface RgbaBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function makeBuffer(width: number, height: number): RgbaBuffer {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function cloneBuffer(src: RgbaBuffer): RgbaBuffer {
  return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
}

/* ---------------------------------------------------------------- 预乘 alpha */

function premultiply(src: RgbaBuffer): Float32Array {
  const { data } = src;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = data[i] * a;
    out[i + 1] = data[i + 1] * a;
    out[i + 2] = data[i + 2] * a;
    out[i + 3] = data[i + 3];
  }
  return out;
}

function unpremultiplyInto(dst: Uint8ClampedArray, p: Float32Array): void {
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3];
    if (a <= 0) {
      dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
      continue;
    }
    const inv = 255 / a;
    dst[i] = p[i] * inv;
    dst[i + 1] = p[i + 1] * inv;
    dst[i + 2] = p[i + 2] * inv;
    dst[i + 3] = a;
  }
}

/* ---------------------------------------------------------------- 盒式模糊 */

/**
 * 一趟运行和盒式模糊（单方向）。
 * PhotoCraft blur.rs box_pass：dst[i] = mean(src[i..i+2r+1])，线性复杂度。
 */
function boxPassLine(
  src: Float32Array,
  dst: Float32Array,
  count: number,
  channels: number,
  r: number,
): void {
  const win = 2 * r + 1;
  const norm = 1 / win;
  for (let i = 0; i < count; i += 1) {
    const o = i * channels;
    for (let c = 0; c < channels; c += 1) dst[o + c] = 0;
    for (let k = 0; k < win; k += 1) {
      const idx = Math.min(count - 1, Math.max(0, i + k - r)) * channels;
      for (let c = 0; c < channels; c += 1) dst[o + c] += src[idx + c];
    }
    for (let c = 0; c < channels; c += 1) dst[o + c] *= norm;
  }
}

/** 水平 + 垂直各一趟盒式模糊（预乘域），边界夹取（PS 的边缘行为）。 */
function boxBlurPass(p: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return p;
  const tmp = new Float32Array(p.length);
  for (let y = 0; y < h; y += 1) {
    boxPassLine(
      p.subarray(y * w * 4, (y + 1) * w * 4),
      tmp.subarray(y * w * 4, (y + 1) * w * 4),
      w,
      4,
      r,
    );
  }
  const out = new Float32Array(p.length);
  const col = new Float32Array(h * 4);
  const acc = new Float32Array(h * 4);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      const o = (y * w + x) * 4;
      col[y * 4] = tmp[o];
      col[y * 4 + 1] = tmp[o + 1];
      col[y * 4 + 2] = tmp[o + 2];
      col[y * 4 + 3] = tmp[o + 3];
    }
    boxPassLine(col, acc, h, 4, r);
    for (let y = 0; y < h; y += 1) {
      const o = (y * w + x) * 4;
      out[o] = acc[y * 4];
      out[o + 1] = acc[y * 4 + 1];
      out[o + 2] = acc[y * 4 + 2];
      out[o + 3] = acc[y * 4 + 3];
    }
  }
  return out;
}

/**
 * 三趟盒式模糊逼近标准差 sigma 的高斯（PhotoCraft blur.rs boxes_for_gauss）。
 * 半径大于阈值时用这条 O(1) 路径，4000² 大图也能实时预览。
 */
export function boxesForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl -= 1;
  wl = Math.max(1, wl);
  const wu = wl + 2;
  const mIdeal =
    (12 * sigma * sigma - n * (wl * wl) - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.min(n, Math.max(0, Math.round(mIdeal)));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/** 盒式模糊（radius 为像素半径）。radius ≤ 0 原样返回。 */
export function boxBlur(src: RgbaBuffer, radius: number): RgbaBuffer {
  const r = Math.max(0, Math.round(radius));
  const out = cloneBuffer(src);
  if (r === 0) return out;
  let p = premultiply(src);
  p = boxBlurPass(p, src.width, src.height, r);
  unpremultiplyInto(out.data, p);
  return out;
}

/* ---------------------------------------------------------------- 高斯模糊 */

/** 归一化高斯核，σ=radius，半径 3σ（PhotoCraft blur.rs gaussian_kernel）。 */
export function gaussianKernel(sigma: number): number[] {
  if (sigma < 0.05) return [1];
  const r = Math.ceil(sigma * 3);
  const k: number[] = [];
  for (let i = -r; i <= r; i += 1) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const s = k.reduce((a, b) => a + b, 0);
  return k.map((v) => v / s);
}

/** 可分离二维卷积（预乘域，边界夹取）。 */
function convSep(p: Float32Array, w: number, h: number, kx: number[], ky: number[]): Float32Array {
  const rx = (kx.length / 2) | 0;
  const ry = (ky.length / 2) | 0;
  const tmp = new Float32Array(p.length);
  const out = new Float32Array(p.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (let i = -rx; i <= rx; i += 1) {
          const xi = Math.min(w - 1, Math.max(0, x + i));
          acc += p[(y * w + xi) * 4 + c] * kx[i + rx];
        }
        tmp[(y * w + x) * 4 + c] = acc;
      }
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (let i = -ry; i <= ry; i += 1) {
          const yi = Math.min(h - 1, Math.max(0, y + i));
          acc += tmp[(yi * w + x) * 4 + c] * ky[i + ry];
        }
        out[(y * w + x) * 4 + c] = acc;
      }
    }
  }
  return out;
}

/**
 * 高斯模糊。radius 遵循 PS 语义：σ = radius / 2（PS 的「半径 2」约等于 σ1）。
 * 小半径走精确核，半径 > 8 走三趟盒式模糊（成本与半径无关）。
 */
export function gaussianBlur(src: RgbaBuffer, radius: number): RgbaBuffer {
  const sigma = Math.max(0, radius) / 2;
  const out = cloneBuffer(src);
  if (sigma < 0.05) return out;
  let p: Float32Array;
  if (sigma > 4) {
    const boxes = boxesForGauss(sigma, 3);
    p = premultiply(src);
    for (const b of boxes) {
      const r = Math.max(0, (b - 1) / 2);
      p = boxBlurPass(p, src.width, src.height, r);
    }
  } else {
    const k = gaussianKernel(sigma);
    p = convSep(premultiply(src), src.width, src.height, k, k);
  }
  unpremultiplyInto(out.data, p);
  return out;
}

/* ---------------------------------------------------------------- 动感模糊 */

/** 动感模糊：沿 angle 方向的线核（长度 = 距离，可分离近似为单方向核）。 */
export function motionBlur(src: RgbaBuffer, angleDeg: number, distance: number): RgbaBuffer {
  const d = Math.max(0, Math.round(distance));
  if (d === 0) return cloneBuffer(src);
  const { width: w, height: h } = src;
  const theta = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(theta);
  const dy = -Math.sin(theta); // 屏幕坐标 y 向下，PS 角度逆时针
  const p = premultiply(src);
  const out = new Float32Array(p.length);
  const steps = d * 2 + 1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (let s = -d; s <= d; s += 1) {
          const xi = Math.min(w - 1, Math.max(0, Math.round(x + dx * s)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(y + dy * s)));
          acc += p[(yi * w + xi) * 4 + c];
        }
        out[o + c] = acc / steps;
      }
    }
  }
  const res = cloneBuffer(src);
  unpremultiplyInto(res.data, out);
  return res;
}

/* ---------------------------------------------------------------- 3×3 卷积 */

/** 锐化核：中心 1+4s、四邻 −s。s=1 即 PS「锐化」的 [0,-1,0;-1,5,-1;0,-1,0]。 */
export function sharpenKernel(strength: number): number[] {
  const s = Math.max(1, strength);
  return [0, -s, 0, -s, 1 + 4 * s, -s, 0, -s, 0];
}

/** 3×3 卷积（预乘域）。用于锐化 / 浮雕类小核滤镜。 */
export function convolve3x3(src: RgbaBuffer, k: number[], divisor = 0, bias = 0): RgbaBuffer {
  const { width: w, height: h } = src;
  const div = divisor || k.reduce((a, b) => a + b, 0) || 1;
  const p = premultiply(src);
  const out = new Float32Array(p.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = bias;
        for (let ky = -1; ky <= 1; ky += 1) {
          const yi = Math.min(h - 1, Math.max(0, y + ky));
          for (let kx = -1; kx <= 1; kx += 1) {
            const xi = Math.min(w - 1, Math.max(0, x + kx));
            acc += p[(yi * w + xi) * 4 + c] * k[(ky + 1) * 3 + (kx + 1)];
          }
        }
        out[(y * w + x) * 4 + c] = acc / div;
      }
    }
  }
  const res = cloneBuffer(src);
  unpremultiplyInto(res.data, out);
  return res;
}

/* ---------------------------------------------------------------- USM 锐化 */

/**
 * USM（Unsharp Mask）锐化。
 * out = src + amount × (src − blur(src))，|差| < threshold 的像素保持不动。
 * PhotoCraft sharpen.rs 同一公式；threshold 单位是 0–255 色阶。
 */
export function unsharpMask(
  src: RgbaBuffer,
  radius: number,
  amount: number,
  threshold: number,
): RgbaBuffer {
  const blurred = gaussianBlur(src, radius);
  const a = amount / 100;
  const t = Math.max(0, threshold);
  const out = cloneBuffer(src);
  const { data } = out;
  for (let i = 0; i < data.length; i += 4) {
    const sa = data[i + 3] / 255;
    for (let c = 0; c < 3; c += 1) {
      const diff = src.data[i + c] - blurred.data[i + c];
      if (Math.abs(diff) >= t) {
        data[i + c] = src.data[i + c] + a * diff * sa;
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 杂色 */

/** mulberry32 种子随机数（可复现，滑块拖动时预览不闪烁）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 添加杂色。amount 为 0–100%（PS 语义）；monochrome = 1 时灰度杂点，
 * 否则 RGB 各自独立。均匀分布（PS「平均分布」），透明像素不加深。
 */
export function addNoise(
  src: RgbaBuffer,
  amount: number,
  monochrome: boolean,
  seed = 20261024,
): RgbaBuffer {
  const out = cloneBuffer(src);
  const { data } = out;
  const rand = rng(seed);
  const amp = (Math.max(0, amount) / 100) * 255;
  const once = monochrome ? new Float32Array(3) : null;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (once) {
      const v = (rand() - 0.5) * amp;
      once[0] = once[1] = once[2] = v;
      for (let c = 0; c < 3; c += 1) data[i + c] += once[c];
    } else {
      for (let c = 0; c < 3; c += 1) data[i + c] += (rand() - 0.5) * amp;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 中值类 */

/** r×r 邻域中值（3×3 或更大），对 RGB 三通道独立取中值。 */
export function median(src: RgbaBuffer, radius: number): RgbaBuffer {
  const r = Math.max(1, Math.round(radius));
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const win: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        win.length = 0;
        for (let dy = -r; dy <= r; dy += 1) {
          const yi = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx += 1) {
            const xi = Math.min(w - 1, Math.max(0, x + dx));
            win.push(data[(yi * w + xi) * 4 + c]);
          }
        }
        win.sort((a, b) => a - b);
        out.data[(y * w + x) * 4 + c] = win[win.length >> 1];
      }
    }
  }
  return out;
}

/**
 * 蒙尘与划痕：|中心−中值| < 阈值的像素取中值，否则保留。
 * 与 PS 一致：只修噪点，不动大反差的真实边缘。
 */
export function dustAndScratch(src: RgbaBuffer, radius: number, threshold: number): RgbaBuffer {
  const r = Math.max(1, Math.round(radius));
  const t = Math.max(0, threshold);
  const med = median(src, r);
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let diff = 0;
      for (let c = 0; c < 3; c += 1) diff = Math.max(diff, Math.abs(data[o + c] - med.data[o + c]));
      if (diff < t) {
        for (let c = 0; c < 3; c += 1) out.data[o + c] = med.data[o + c];
      }
    }
  }
  return out;
}

/** 减少杂色：中值滤波与原图按强度混合（保边降噪的轻量近似）。 */
export function reduceNoise(src: RgbaBuffer, strength: number): RgbaBuffer {
  const med = median(src, 1);
  const k = Math.min(100, Math.max(0, strength)) / 100;
  const out = cloneBuffer(src);
  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      out.data[i + c] = src.data[i + c] * (1 - k) + med.data[i + c] * k;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 表面模糊 */

/**
 * 表面模糊（PS 特殊模糊的保边模式）：邻域内 |亮度差| ≤ 阈值的像素才参与
 * 加权平均，权重 = 1 − (差/阈值)²。 bilateral 滤镜的标准写法。
 */
export function surfaceBlur(src: RgbaBuffer, radius: number, threshold: number): RgbaBuffer {
  const r = Math.max(1, Math.round(radius));
  const t = Math.max(1, threshold);
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const luma = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    luma[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const lc = luma[y * w + x];
      let wsum = 0;
      const acc = [0, 0, 0];
      for (let dy = -r; dy <= r; dy += 1) {
        const yi = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx += 1) {
          const xi = Math.min(w - 1, Math.max(0, x + dx));
          const j = yi * w + xi;
          const diff = Math.abs(luma[j] - lc);
          if (diff > t) continue;
          const wgt = 1 - (diff / t) ** 2;
          wsum += wgt;
          const p = j * 4;
          acc[0] += data[p] * wgt;
          acc[1] += data[p + 1] * wgt;
          acc[2] += data[p + 2] * wgt;
        }
      }
      if (wsum > 0) {
        out.data[o] = acc[0] / wsum;
        out.data[o + 1] = acc[1] / wsum;
        out.data[o + 2] = acc[2] / wsum;
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 径向模糊 */

/** 径向模糊（旋转）：绕画布中心按 steps 个角度采样平均。 */
export function radialSpin(src: RgbaBuffer, angleDeg: number, steps: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const p = premultiply(src);
  const out = new Float32Array(p.length);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const n = Math.max(2, Math.round(steps));
  const rad = (angleDeg * Math.PI) / 180 / n;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const cos0 = Math.cos(rad);
      const sin0 = Math.sin(rad);
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        let sx = x;
        let sy = y;
        for (let s = 0; s < n; s += 1) {
          const xi = Math.min(w - 1, Math.max(0, Math.round(sx)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(sy)));
          acc += p[(yi * w + xi) * 4 + c];
          const nx = (sx - cx) * cos0 - (sy - cy) * sin0;
          const ny = (sx - cx) * sin0 + (sy - cy) * cos0;
          sx = nx + cx;
          sy = ny + cy;
        }
        out[(y * w + x) * 4 + c] = acc / n;
      }
    }
  }
  const res = cloneBuffer(src);
  unpremultiplyInto(res.data, out);
  return res;
}

/** 径向模糊（缩放）：从中心向外按比例采样平均。 */
export function radialZoom(src: RgbaBuffer, amount: number, steps: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const p = premultiply(src);
  const out = new Float32Array(p.length);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const n = Math.max(2, Math.round(steps));
  const k = Math.max(0, amount) / 100 / n;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (let s = 0; s < n; s += 1) {
          const f = 1 + k * s;
          const xi = Math.min(w - 1, Math.max(0, Math.round(cx + (x - cx) * f)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(cy + (y - cy) * f)));
          acc += p[(yi * w + xi) * 4 + c];
        }
        out[(y * w + x) * 4 + c] = acc / n;
      }
    }
  }
  const res = cloneBuffer(src);
  unpremultiplyInto(res.data, out);
  return res;
}

/* ---------------------------------------------------------------- 像素化 */

/** 彩块化（马赛克）：块内取平均。 */
export function mosaic(src: RgbaBuffer, size: number): RgbaBuffer {
  const s = Math.max(1, Math.round(size));
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  for (let by = 0; by < h; by += s) {
    for (let bx = 0; bx < w; bx += s) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let y = by; y < Math.min(h, by + s); y += 1) {
        for (let x = bx; x < Math.min(w, bx + s); x += 1) {
          const o = (y * w + x) * 4;
          acc[0] += data[o];
          acc[1] += data[o + 1];
          acc[2] += data[o + 2];
          acc[3] += data[o + 3];
          n += 1;
        }
      }
      for (let y = by; y < Math.min(h, by + s); y += 1) {
        for (let x = bx; x < Math.min(w, bx + s); x += 1) {
          const o = (y * w + x) * 4;
          out.data[o] = acc[0] / n;
          out.data[o + 1] = acc[1] / n;
          out.data[o + 2] = acc[2] / n;
          out.data[o + 3] = acc[3] / n;
        }
      }
    }
  }
  return out;
}

/**
 * 晶格化：把画布划成不规则三角网（抖动网格），每格取中心像素。
 * 简化实现：单元尺寸加伪随机抖动，取格点最近像素值。
 */
export function crystallize(src: RgbaBuffer, size: number, seed = 7): RgbaBuffer {
  const s = Math.max(2, Math.round(size));
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const rand = rng(seed);
  // 每个网格的抖动量先生成，保证同一像素判定一致
  const jx = new Float32Array(Math.ceil(w / s) + 2);
  const jy = new Float32Array(Math.ceil(h / s) + 2);
  for (let i = 0; i < jx.length; i += 1) jx[i] = (rand() - 0.5) * s * 0.8;
  for (let i = 0; i < jy.length; i += 1) jy[i] = (rand() - 0.5) * s * 0.8;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const gx = Math.floor(x / s);
      const gy = Math.floor(y / s);
      const cx = Math.min(w - 1, Math.max(0, Math.round(gx * s + s / 2 + jx[gx])));
      const cy = Math.min(h - 1, Math.max(0, Math.round(gy * s + s / 2 + jy[gy])));
      const so = (cy * w + cx) * 4;
      const o = (y * w + x) * 4;
      out.data[o] = data[so];
      out.data[o + 1] = data[so + 1];
      out.data[o + 2] = data[so + 2];
      out.data[o + 3] = data[so + 3];
    }
  }
  return out;
}

/** 碎片：四个方向偏移各取一份再平均（PS Fragment 的经典近似）。 */
export function fragment(src: RgbaBuffer, offset: number): RgbaBuffer {
  const d = Math.max(1, Math.round(offset));
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const dirs = [
    [-d, -d],
    [d, -d],
    [-d, d],
    [d, d],
  ];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (const [dx, dy] of dirs) {
          const xi = Math.min(w - 1, Math.max(0, x + dx));
          const yi = Math.min(h - 1, Math.max(0, y + dy));
          acc += data[(yi * w + xi) * 4 + c];
        }
        out.data[o + c] = acc / 4;
      }
    }
  }
  return out;
}

/** 铜版雕刻：按模式在像素间撒固定值的点（PS Mezzotint 的简化版）。 */
export function mezzotint(src: RgbaBuffer, density: number, seed = 99): RgbaBuffer {
  const out = cloneBuffer(src);
  const { data, width: w, height: h } = out;
  const rand = rng(seed);
  const p = Math.min(100, Math.max(0, density)) / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (rand() < p) {
        const o = (y * w + x) * 4;
        const v = rand() < 0.5 ? 0 : 255;
        data[o] = data[o + 1] = data[o + 2] = v;
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 扭曲 */

/** 双线性采样：越界夹取到边缘，RGBA 四通道一起插值。 */
function sampleBilinear(
  src: RgbaBuffer,
  x: number,
  y: number,
  out: Uint8ClampedArray,
  o: number,
): void {
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

/** 旋转扭曲：绕中心按「离中心越近扭得越厉害」的二次衰减场旋转采样。 */
export function twirl(src: RgbaBuffer, angleDeg: number, radiusPct: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.max(1, ((Math.min(w, h) / 2) * Math.min(100, Math.max(1, radiusPct))) / 100);
  const ang = (angleDeg * Math.PI) / 180;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const o = (y * w + x) * 4;
      if (r >= R) {
        sampleBilinear(src, x, y, out.data, o);
        continue;
      }
      const t = ang * (1 - r / R) ** 2;
      const cos = Math.cos(t);
      const sin = Math.sin(t);
      sampleBilinear(src, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, out.data, o);
    }
  }
  return out;
}

/** 波浪：横纵两个方向的正弦位移场（PS Wave 的简化版，固定三角波语义）。 */
export function wave(src: RgbaBuffer, amplitude: number, wavelength: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const len = Math.max(2, wavelength);
  const amp = Math.max(0, amplitude);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const dx = amp * Math.sin((y / len) * Math.PI * 2);
      const dy = amp * Math.sin((x / len) * Math.PI * 2);
      sampleBilinear(src, x + dx, y + dy, out.data, o);
    }
  }
  return out;
}

/** 波纹：沿半径方向的正弦扰动（把画面当成水面荡开）。 */
export function ripple(src: RgbaBuffer, amount: number, size: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const len = Math.max(2, size);
  const amp = Math.max(0, amount);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const dr = amp * Math.sin((r / len) * Math.PI * 2);
      const rr = r === 0 ? 0 : (r + dr) / r;
      const o = (y * w + x) * 4;
      sampleBilinear(src, cx + dx * rr, cy + dy * rr, out.data, o);
    }
  }
  return out;
}

/**
 * 挤压 / 球面化：同一套径向重采样，amount 正值把像素往中心挤（挤压），
 * 负值往外推（球面化凸起）。衰减取「到边缘线性归零」的钟形剖面。
 */
export function pinch(src: RgbaBuffer, amount: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.min(w, h) / 2;
  const a = Math.max(-100, Math.min(100, amount)) / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const o = (y * w + x) * 4;
      if (r >= R || r === 0) {
        sampleBilinear(src, x, y, out.data, o);
        continue;
      }
      const k = 1 + a * (1 - r / R) ** 2;
      sampleBilinear(src, cx + dx * k, cy + dy * k, out.data, o);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 风格化 */

/**
 * 查找边缘：亮度图的 Sobel 梯度取反 —— 边缘深色、平坦区留白（PS 同款）。
 */
export function findEdges(src: RgbaBuffer): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    lum[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(h - 1, y + 1);
      const gx =
        -lum[ym * w + xm] - 2 * lum[y * w + xm] - lum[yp * w + xm] +
        lum[ym * w + xp] + 2 * lum[y * w + xp] + lum[yp * w + xp];
      const gy =
        -lum[ym * w + xm] - 2 * lum[ym * w + x] - lum[ym * w + xp] +
        lum[yp * w + xm] + 2 * lum[yp * w + x] + lum[yp * w + xp];
      const g = Math.min(255, Math.hypot(gx, gy));
      const v = 255 - g;
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}

/** 浮雕：沿光照方向的差分叠加中灰底 —— 凹凸感来自亮度差。 */
export function emboss(src: RgbaBuffer, angleDeg: number, height: number, amount: number): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const k = amount / 100;
  const at = (x: number, y: number): number => {
    const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
    const o = (yi * w + xi) * 4;
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = 128 + (at(x - dx * height, y - dy * height) - at(x + dx * height, y + dy * height)) * k;
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}

/** 曝光过度：超过中灰的通道值取反（底片曝光的近似）。 */
export function solarize(src: RgbaBuffer): RgbaBuffer {
  const out = cloneBuffer(src);
  const { data } = out;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      if (data[i + c] > 128) data[i + c] = 255 - data[i + c];
    }
  }
  return out;
}

/** 风：水平方向的单向拖影 + 随机断口（先动感模糊再随机保留原像素）。 */
export function wind(src: RgbaBuffer, strength: number, seed = 7): RgbaBuffer {
  const blurred = motionBlur(src, 0, Math.max(1, Math.round(strength)));
  const out = cloneBuffer(blurred);
  const { data, width: w, height: h } = out;
  const rand = rng(seed);
  const d0 = src.data;
  for (let i = 0; i < w * h; i += 1) {
    if (rand() < 0.45) {
      const o = i * 4;
      data[o] = d0[o];
      data[o + 1] = d0[o + 1];
      data[o + 2] = d0[o + 2];
    }
  }
  return out;
}

/** 油画：四象限 Kuwahara —— 每点取「方差最小的象限」的平均色，笔触块面化。 */
export function oilPaint(src: RgbaBuffer, radius: number): RgbaBuffer {
  const r = Math.max(1, Math.min(6, Math.round(radius)));
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    lum[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  const quad = (x: number, y: number, sx: number, sy: number): [number, number, number, number] => {
    let n = 0;
    let sl = 0;
    let sl2 = 0;
    let r0 = 0;
    let g0 = 0;
    let b0 = 0;
    for (let j = 0; j <= r; j += 1) {
      const yi = Math.min(h - 1, Math.max(0, y + sy * j));
      for (let i = 0; i <= r; i += 1) {
        const xi = Math.min(w - 1, Math.max(0, x + sx * i));
        const k = yi * w + xi;
        const l = lum[k];
        n += 1;
        sl += l;
        sl2 += l * l;
        const o = k * 4;
        r0 += data[o];
        g0 += data[o + 1];
        b0 += data[o + 2];
      }
    }
    const mean = sl / n;
    return [sl2 / n - mean * mean, r0 / n, g0 / n, b0 / n];
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let best = quad(x, y, 1, 1);
      for (const [sx, sy] of [[-1, 1], [1, -1], [-1, -1]] as const) {
        const q = quad(x, y, sx, sy);
        if (q[0] < best[0]) best = q;
      }
      const o = (y * w + x) * 4;
      out.data[o] = best[1];
      out.data[o + 1] = best[2];
      out.data[o + 2] = best[3];
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 纹理 */

/** 颗粒：叠加单色亮度噪声（monochrome grain），种子固定可复现。 */
export function grain(src: RgbaBuffer, amount: number, seed = 21): RgbaBuffer {
  const out = cloneBuffer(src);
  const { data } = out;
  const rand = rng(seed);
  const a = Math.max(0, amount) / 2;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * a;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  return out;
}

/** 拼缀图：分块取平均色，块间接缝按亮度差做明暗勾边（马赛克 + 浮雕感）。 */
export function patchwork(src: RgbaBuffer, size: number): RgbaBuffer {
  const s = Math.max(2, Math.round(size));
  const { width: w, height: h } = src;
  const gw = Math.ceil(w / s);
  const gh = Math.ceil(h / s);
  const mean: number[] = [];
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      let acc = 0;
      let n = 0;
      for (let y = gy * s; y < Math.min(h, (gy + 1) * s); y += 1) {
        for (let x = gx * s; x < Math.min(w, (gx + 1) * s); x += 1) {
          const o = (y * w + x) * 4;
          acc += 0.299 * src.data[o] + 0.587 * src.data[o + 1] + 0.114 * src.data[o + 2];
          n += 1;
        }
      }
      mean[gy * gw + gx] = n ? acc / n : 0;
    }
  }
  const out = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const gx = Math.floor(x / s);
      const gy = Math.floor(y / s);
      const l = mean[gy * gw + gx];
      const lr = mean[gy * gw + Math.min(gw - 1, gx + 1)];
      const lb = mean[Math.min(gh - 1, gy + 1) * gw + gx];
      const shade = 1 + Math.max(-0.6, Math.min(0.6, (l - (lr + lb) / 2) / 128));
      const o = (y * w + x) * 4;
      const so = (Math.min(h - 1, gy * s + (s >> 1)) * w + Math.min(w - 1, gx * s + (s >> 1))) * 4;
      out.data[o] = src.data[so] * shade;
      out.data[o + 1] = src.data[so + 1] * shade;
      out.data[o + 2] = src.data[so + 2] * shade;
      out.data[o + 3] = src.data[o + 3];
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 素描 */

/** 半调图案：按格子平均亮度排大小不一的圆点，白底黑点（印刷网屏的近似）。 */
export function halftone(src: RgbaBuffer, size: number): RgbaBuffer {
  const s = Math.max(2, Math.round(size));
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = 255;
      out.data[o + 3] = src.data[o + 3];
    }
  }
  for (let gy = 0; gy < Math.ceil(h / s); gy += 1) {
    for (let gx = 0; gx < Math.ceil(w / s); gx += 1) {
      let acc = 0;
      let n = 0;
      for (let y = gy * s; y < Math.min(h, (gy + 1) * s); y += 1) {
        for (let x = gx * s; x < Math.min(w, (gx + 1) * s); x += 1) {
          const o = (y * w + x) * 4;
          acc += 0.299 * src.data[o] + 0.587 * src.data[o + 1] + 0.114 * src.data[o + 2];
          n += 1;
        }
      }
      const lum = n ? acc / n : 255;
      const cx = gx * s + s / 2;
      const cy = gy * s + s / 2;
      const rad = ((255 - lum) / 255) * (s / 2);
      if (rad <= 0.4) continue;
      const r2 = rad * rad;
      for (let y = Math.max(0, Math.floor(cy - rad)); y < Math.min(h, Math.ceil(cy + rad)); y += 1) {
        for (let x = Math.max(0, Math.floor(cx - rad)); x < Math.min(w, Math.ceil(cx + rad)); x += 1) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r2) {
            const o = (y * w + x) * 4;
            out.data[o] = out.data[o + 1] = out.data[o + 2] = 0;
          }
        }
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 艺术效果 */

/** 水彩：中值滤波抹平细节 + 轻微提饱和，模拟颜料的柔化沉淀。 */
export function watercolor(src: RgbaBuffer, smoothing: number): RgbaBuffer {
  const base = median(src, Math.max(1, Math.round(smoothing)));
  const out = cloneBuffer(base);
  const { data } = out;
  const sat = 1.25;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = l + (data[i] - l) * sat;
    data[i + 1] = l + (data[i + 1] - l) * sat;
    data[i + 2] = l + (data[i + 2] - l) * sat;
  }
  return out;
}
