/**
 * 颜色模式转换：位图 / 双色调 / 索引颜色 / CMYK / Lab / 多通道。
 *
 * 全部是纯像素函数（RgbaBuffer 进、RgbaBuffer 出），不依赖 DOM，
 * node（vitest）可直接断言。Strata 的渲染管线固定是 8 位 sRGB，
 * 所以这里的「模式」都是对该模式**真实成像特性**的模拟：
 *
 * - **位图**：阈值二值化（可选半调网点），黑/白两色，没有灰阶。
 * - **双色调**：把亮度映射到「深色墨 → 浅色墨」的双色渐变（PS 的双色调本质）。
 * - **索引颜色**：中位切分（median cut）量化出 N 色调色板，再按最近色映射，
 *   可开 Floyd–Steinberg 抖动 —— 和 GIF/PNG-8 的成像一致。
 * - **CMYK**：真的走一遍 RGB→CMYK→RGB，含油墨总量限制（ink limit）与
 *   底色去除（UCR），因此高饱和暗部会像印刷品一样掉饱和。
 * - **Lab**：RGB→XYZ(D65)→Lab→限色域→回 RGB，极端色会被轻微收色。
 * - **多通道**：拆出四张灰度通道图（由调用方写进 alpha 通道）。
 */
import { makeBuffer, type RgbaBuffer } from "../engine/filters/kernels";

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/* ---------------------------------------------------------------- 位图 */

/**
 * 位图模式：亮度超过 threshold 全白、否则全黑。
 * halftoneCell > 0 时用 45° 网点做「半调位图」（PS 的「半调网屏」选项）。
 */
export function toBitmap(src: RgbaBuffer, threshold: number, halftoneCell = 0): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const th = Math.min(255, Math.max(0, threshold));
  const cell = Math.max(0, Math.round(halftoneCell));
  const k = Math.PI / Math.max(2, cell);
  const cos = Math.cos(Math.PI / 4);
  const sin = Math.sin(Math.PI / 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      let on: boolean;
      if (cell === 0) {
        on = lum > th;
      } else {
        // 旋转坐标上的正弦网点：亮度越亮网点越大
        const sx = x * cos - y * sin;
        const sy = x * sin + y * cos;
        const pattern = Math.sin(sx * k) * Math.sin(sy * k);
        on = pattern + 2 * (lum / 255) - 1 > 0;
      }
      const v = on ? 255 : 0;
      out.data[o] = v;
      out.data[o + 1] = v;
      out.data[o + 2] = v;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}

/* -------------------------------------------------------------- 双色调 */

type Rgb = readonly [number, number, number];

/**
 * 双色调：亮度 0 → dark 色，亮度 255 → light 色，中间按 strength 插值。
 * strength < 100 时保留一部分原色（相当于 PS 里降低油墨浓度）。
 */
export function toDuotone(
  src: RgbaBuffer,
  dark: Rgb,
  light: Rgb,
  strength = 100,
): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const k = Math.min(100, Math.max(0, strength)) / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const lum = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
      for (let c = 0; c < 3; c += 1) {
        const ramp = dark[c] + (light[c] - dark[c]) * lum;
        out.data[o + c] = data[o + c] * (1 - k) + ramp * k;
      }
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}

/* ------------------------------------------------------------ 索引颜色 */

interface Box {
  pixels: number[];
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

function makeBox(pixels: number[], data: Uint8ClampedArray): Box {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (const p of pixels) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  return { pixels, rMin, rMax, gMin, gMax, bMin, bMax };
}

/** 中位切分量化：返回调色板（最多 colors 个色）。 */
export function medianCutPalette(src: RgbaBuffer, colors: number): Rgb[] {
  const { width: w, height: h, data } = src;
  const n = Math.max(2, Math.min(256, Math.round(colors)));
  const all: number[] = [];
  // 大图采样，避免量化阶段就吃满内存
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const p = y * w + x;
      if (data[p * 4 + 3] < 8) continue;
      all.push(p);
    }
  }
  if (all.length === 0) return [[0, 0, 0]];
  let boxes: Box[] = [makeBox(all, data)];
  while (boxes.length < n) {
    // 找通道跨度最大的盒子切
    let best = -1;
    let bestRange = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i];
      if (b.pixels.length < 2) continue;
      const range = Math.max(b.rMax - b.rMin, b.gMax - b.gMin, b.bMax - b.bMin);
      if (range > bestRange) {
        bestRange = range;
        best = i;
      }
    }
    if (best < 0 || bestRange === 0) break;
    const box = boxes[best];
    const useR = box.rMax - box.rMin >= box.gMax - box.gMin && box.rMax - box.rMin >= box.bMax - box.bMin;
    const useG = !useR && box.gMax - box.gMin >= box.bMax - box.bMin;
    const ch = useR ? 0 : useG ? 1 : 2;
    box.pixels.sort((a, b) => data[a * 4 + ch] - data[b * 4 + ch]);
    const mid = box.pixels.length >> 1;
    const left = box.pixels.slice(0, mid);
    const right = box.pixels.slice(mid);
    boxes = boxes.filter((_, i) => i !== best);
    if (left.length) boxes.push(makeBox(left, data));
    if (right.length) boxes.push(makeBox(right, data));
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const p of b.pixels) {
      const i = p * 4;
      r += data[i];
      g += data[i + 1];
      bl += data[i + 2];
    }
    const c = b.pixels.length || 1;
    return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)] as const;
  });
}

/** 最近调色板索引。 */
function nearest(palette: Rgb[], r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const p = palette[i];
    const dr = p[0] - r;
    const dg = p[1] - g;
    const db = p[2] - b;
    const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * 索引颜色：把图量化到 n 色。dither 打开时用 Floyd–Steinberg 误差扩散。
 * 返回量化后的图与调色板（调色板供「颜色表」编辑）。
 */
export function toIndexed(
  src: RgbaBuffer,
  colors: number,
  dither: boolean,
): { buf: RgbaBuffer; palette: Rgb[] } {
  const palette = medianCutPalette(src, colors);
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const work = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    work[p * 3] = data[i];
    work[p * 3 + 1] = data[i + 1];
    work[p * 3 + 2] = data[i + 2];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      const o = p * 4;
      if (data[o + 3] < 8) continue;
      const r = work[p * 3];
      const g = work[p * 3 + 1];
      const b = work[p * 3 + 2];
      const idx = nearest(palette, r, g, b);
      const pr = palette[idx][0];
      const pg = palette[idx][1];
      const pb = palette[idx][2];
      out.data[o] = pr;
      out.data[o + 1] = pg;
      out.data[o + 2] = pb;
      out.data[o + 3] = data[o + 3];
      if (!dither) continue;
      const er = r - pr;
      const eg = g - pg;
      const eb = b - pb;
      const spread = (dx: number, dy: number, k: number): void => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const np = ny * w + nx;
        work[np * 3] += er * k;
        work[np * 3 + 1] += eg * k;
        work[np * 3 + 2] += eb * k;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return { buf: out, palette };
}

/** 按调色板重新映射（「颜色表」改完色后回涂用）。 */
export function applyPalette(src: RgbaBuffer, palette: Rgb[]): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    if (data[o + 3] < 8) continue;
    const idx = nearest(palette, data[o], data[o + 1], data[o + 2]);
    out.data[o] = palette[idx][0];
    out.data[o + 1] = palette[idx][1];
    out.data[o + 2] = palette[idx][2];
    out.data[o + 3] = data[o + 3];
  }
  return out;
}

/* ---------------------------------------------------------------- CMYK */

/**
 * CMYK 模拟：RGB→CMYK（含 UCR 底色去除）→ 油墨总量限制 → 回 RGB。
 * inkLimit 是四色油墨总量上限（印刷常规 240%–320%），超过会等比压缩，
 * 这正是 CMYK 模式看起来「暗部发灰、艳色变闷」的原因。
 */
export function toCmyk(src: RgbaBuffer, inkLimit: number, ucr: number): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const limit = Math.min(400, Math.max(100, inkLimit)) / 100;
  const u = Math.min(100, Math.max(0, ucr)) / 100;
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    let k = 1 - Math.max(r, g, b);
    // UCR：用黑版替代一部分三色叠印
    k = Math.min(1, k * (1 + u));
    let c = 0;
    let m = 0;
    let y = 0;
    if (k < 1) {
      c = (1 - r - k) / (1 - k);
      m = (1 - g - k) / (1 - k);
      y = (1 - b - k) / (1 - k);
    }
    // 油墨不能为负：UCR 把黑版加上去之后，三色板不该出现负值
    c = c < 0 ? 0 : c;
    m = m < 0 ? 0 : m;
    y = y < 0 ? 0 : y;
    let total = c + m + y + k;
    if (total > limit && total > 0) {
      const f = limit / total;
      c *= f;
      m *= f;
      y *= f;
      k *= f;
      total = limit;
    }
    void total;
    out.data[o] = clamp255((1 - c) * (1 - k) * 255);
    out.data[o + 1] = clamp255((1 - m) * (1 - k) * 255);
    out.data[o + 2] = clamp255((1 - y) * (1 - k) * 255);
    out.data[o + 3] = data[o + 3];
  }
  return out;
}

/* ----------------------------------------------------------------- Lab */

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
}

function f(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function finv(t: number): number {
  return t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787;
}

/**
 * Lab 模拟：走一遍 sRGB → XYZ(D65) → Lab →（限色域）→ 回到 sRGB。
 * chroma 是本模式允许的最大彩度（C*ab），越小越保守；不设 0 则为纯往返。
 */
export function toLab(src: RgbaBuffer, chroma: number): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const maxC = Math.max(0, chroma);
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    const rl = srgbToLinear(data[o]);
    const gl = srgbToLinear(data[o + 1]);
    const bl = srgbToLinear(data[o + 2]);
    // sRGB → XYZ (D65)
    const X = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
    const Y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
    const Z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
    const fx = f(X);
    const fy = f(Y);
    const fz = f(Z);
    let L = 116 * fy - 16;
    let a = 500 * (fx - fy);
    let b2 = 200 * (fy - fz);
    if (maxC > 0) {
      const c = Math.hypot(a, b2);
      if (c > maxC) {
        const k = maxC / c;
        a *= k;
        b2 *= k;
      }
    }
    // 回 XYZ → sRGB
    const fy2 = (L + 16) / 116;
    const X2 = finv(fy2 + a / 500) * 0.95047;
    const Y2 = finv(fy2);
    const Z2 = finv(fy2 - b2 / 200) * 1.08883;
    const r2 = 3.2404542 * X2 - 1.5371385 * Y2 - 0.4985314 * Z2;
    const g2 = -0.969266 * X2 + 1.8760108 * Y2 + 0.041556 * Z2;
    const b3 = 0.0556434 * X2 - 0.2040259 * Y2 + 1.0572252 * Z2;
    out.data[o] = clamp255(linearToSrgb(Math.max(0, r2)));
    out.data[o + 1] = clamp255(linearToSrgb(Math.max(0, g2)));
    out.data[o + 2] = clamp255(linearToSrgb(Math.max(0, b3)));
    out.data[o + 3] = data[o + 3];
    void L;
  }
  return out;
}

/* ------------------------------------------------------------- 多通道 */

/** 拆出 R / G / B / Alphal 四张灰度图（多通道模式用）。 */
export function splitChannels(src: RgbaBuffer): {
  channels: RgbaBuffer[];
  names: string[];
} {
  const { width: w, height: h, data } = src;
  const make = (pick: (i: number) => number): RgbaBuffer => {
    const b = makeBuffer(w, h);
    for (let p = 0; p < w * h; p += 1) {
      const o = p * 4;
      const v = pick(o);
      b.data[o] = v;
      b.data[o + 1] = v;
      b.data[o + 2] = v;
      b.data[o + 3] = 255;
    }
    return b;
  };
  return {
    channels: [
      make((o) => data[o]),
      make((o) => data[o + 1]),
      make((o) => data[o + 2]),
      make((o) => data[o + 3]),
    ],
    names: ["红", "绿", "蓝", "Alpha"],
  };
}

/**
 * 位深：8 位是管线的原生精度；16 / 32 位在 8 位管线上没有额外精度可存，
 * 因此这里只做「向下量化」这一步 —— 从 16/32 转回 8 位时按 8 位步长取整。
 * 诚实地说：它不是浮点管线，只是模式标记 + 向下取整。
 */
export function quantizeTo8(src: RgbaBuffer): RgbaBuffer {
  const out = makeBuffer(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 1) {
    out.data[i] = Math.round(src.data[i] / 1) * 1;
  }
  return out;
}
