/**
 * 第四批滤镜内核：模糊画廊（可变半径模糊）+ 高级模糊 + 位移 / 彩色半调 / HSB。
 *
 * 纯函数、不依赖 DOM / Canvas，node（vitest）环境可以直接对固定像素断言。
 * 算法均为自研（并非 PhotoCraft 移植，参考 Photoshop 同名滤镜的公开行为）：
 *
 * - 可变半径模糊用「迭代小幅模糊 + 逐像素混合」逼近：每趟对整图做一次
 *   半径 r 的盒式模糊，然后按 amountMap 决定每个像素这一趟吃多少。
 *   amount=1 的像素吃满 steps 趟 ≈ 半径 steps·r；amount=0 的一趟都不吃。
 *   相邻像素的吃入量是连续插值的，所以不会出现阶梯状的 seams。
 *   相比「预生成 N 级模糊再插值」，内存从 N 份全图降到 2 份。
 * - 采样类模糊（路径 / 旋转 / 智能）统一按预乘 alpha 累加，避免半透明
 *   像素长期泄漏出暗边。
 */
import {
  boxBlur,
  boxBlurPass,
  cloneBuffer,
  gaussianBlur,
  makeBuffer,
  premultiply,
  unpremultiplyInto,
  valueNoise,
  type RgbaBuffer,
} from "./kernels";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lumaAt(d: Uint8ClampedArray, o: number): number {
  return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
}

/* ---------------------------------------------------- 可变半径模糊（地基） */

/**
 * 按逐像素 amount（0~1）做可变半径模糊，最大半径 maxRadius。
 * 这是 Field / Iris / Tilt-Shift 三个画廊滤镜共同的实现。
 */
export function iterativeVariableBlur(
  src: RgbaBuffer,
  amount: Float32Array,
  maxRadius: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = cloneBuffer(src);
  if (maxRadius <= 0.4) return out;
  const steps = Math.min(10, Math.max(1, Math.round(maxRadius / 1.5)));
  const stepR = Math.max(1, Math.round(maxRadius / steps));
  let p = premultiply(src);
  for (let i = 1; i <= steps; i += 1) {
    const b = boxBlurPass(p, w, h, stepR);
    const prev = i - 1;
    for (let idx = 0; idx < w * h; idx += 1) {
      let alpha = clamp01(amount[idx]) * steps - prev;
      if (alpha <= 0) continue;
      if (alpha > 1) alpha = 1;
      const o = idx * 4;
      for (let c = 0; c < 4; c += 1) p[o + c] += (b[o + c] - p[o + c]) * alpha;
    }
  }
  unpremultiplyInto(out.data, p);
  p = new Float32Array(0);
  return out;
}

/** 场景模糊：整幅画面一个基础模糊量，再叠一层横向/纵向的渐变场。 */
export function fieldBlur(src: RgbaBuffer, amount: number, startPct: number, dir: number): RgbaBuffer {
  const { width: w, height: h } = src;
  const map = new Float32Array(w * h);
  const g = clamp01(startPct / 100);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const t = dir === 1 ? x / Math.max(1, w - 1) : y / Math.max(1, h - 1);
      map[y * w + x] = g + (1 - g) * t;
    }
  }
  return iterativeVariableBlur(src, map, Math.max(0.5, amount));
}

/** 移轴摄影：中间一条清晰带，越往上下越模糊。 */
export function tiltShift(
  src: RgbaBuffer,
  radius: number,
  centerPct: number,
  keepPct: number,
  featherPct: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const map = new Float32Array(w * h);
  const cy = ((h - 1) * centerPct) / 100;
  const keep = Math.max(0, (keepPct / 100) * (h / 2));
  const feather = Math.max(1, (featherPct / 100) * (h / 2));
  for (let y = 0; y < h; y += 1) {
    const a = clamp01((Math.abs(y - cy) - keep) / feather);
    for (let x = 0; x < w; x += 1) map[y * w + x] = a;
  }
  return iterativeVariableBlur(src, map, Math.max(0.5, radius));
}

/**
 * 光圈模糊：椭圆内部保持清晰，向外糊开。
 * irisPct 是椭圆相对画布短边的百分比，featherPct 是外羽化带宽度。
 */
export function irisBlur(
  src: RgbaBuffer,
  radius: number,
  cxPct: number,
  cyPct: number,
  irisPct: number,
  featherPct: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const map = new Float32Array(w * h);
  const cx = ((w - 1) * cxPct) / 100;
  const cy = ((h - 1) * cyPct) / 100;
  const rx = Math.max(1, (irisPct / 100) * (w / 2));
  const ry = Math.max(1, (irisPct / 100) * (h / 2));
  const feather = Math.max(0.02, featherPct / 100);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const len = Math.hypot(dx, dy);
      map[y * w + x] = clamp01((len - 1) / feather);
    }
  }
  return iterativeVariableBlur(src, map, Math.max(0.5, radius));
}

/* -------------------------------------------------------- 采样工具类模糊 */

/** 读取一个像素到 tmp[0..3]（RGBA），wrap=true 时环绕取样。 */
function pxAt(src: RgbaBuffer, x: number, y: number, wrap: boolean, tmp: Float32Array): void {
  const { width: w, height: h, data } = src;
  let xx = Math.round(x);
  let yy = Math.round(y);
  if (wrap) {
    xx = ((xx % w) + w) % w;
    yy = ((yy % h) + h) % h;
  } else {
    xx = xx < 0 ? 0 : xx > w - 1 ? w - 1 : xx;
    yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
  }
  const o = (yy * w + xx) * 4;
  tmp[0] = data[o];
  tmp[1] = data[o + 1];
  tmp[2] = data[o + 2];
  tmp[3] = data[o + 3];
}

/** 预乘 alpha 累加一份采样（权重 w），结果写回 acc[0..4]。 */
function accumulate(src: RgbaBuffer, x: number, y: number, wrap: boolean, wgt: number, acc: Float32Array, tmp: Float32Array): void {
  pxAt(src, x, y, wrap, tmp);
  const a = (tmp[3] / 255) * wgt;
  acc[0] += tmp[0] * a;
  acc[1] += tmp[1] * a;
  acc[2] += tmp[2] * a;
  acc[3] += a;
  acc[4] += wgt;
}

/** 把累加结果写进目标像素（accA 为 0 时保持透明，不产生暗边）。 */
function flushAcc(out: Uint8ClampedArray, o: number, acc: Float32Array): void {
  const accA = acc[3];
  if (accA <= 0.0001) return;
  out[o] = acc[0] / accA;
  out[o + 1] = acc[1] / accA;
  out[o + 2] = acc[2] / accA;
  out[o + 3] = (accA / acc[4]) * 255;
}

/**
 * 路径模糊：沿一段圆弧轨迹铺 SAMPLES 个采样点。
 * curvature 是整条轨迹的转向角，taper 让两端渐隐。
 */
export function pathBlur(
  src: RgbaBuffer,
  distance: number,
  angleDeg: number,
  curvatureDeg: number,
  taperPct: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const n = 24;
  const base = (angleDeg * Math.PI) / 180;
  const curv = (curvatureDeg * Math.PI) / 180;
  const taper = clamp01(taperPct / 100);
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      acc.fill(0);
      for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1) - 0.5;
        const wgt = 1 - Math.abs(t) * 2 * taper;
        if (wgt <= 0) continue;
        const ang = base + curv * t;
        const d = distance * t;
        accumulate(src, x + Math.cos(ang) * d, y + Math.sin(ang) * d, false, wgt, acc, tmp);
      }
      flushAcc(out.data, (y * w + x) * 4, acc);
    }
  }
  return out;
}

/** 旋转模糊：绕指定圆心把像素摊开成一段圆弧。 */
export function spinBlur(
  src: RgbaBuffer,
  angleDeg: number,
  cxPct: number,
  cyPct: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const n = 36;
  const cx = ((w - 1) * cxPct) / 100;
  const cy = ((h - 1) * cyPct) / 100;
  const total = (angleDeg * Math.PI) / 180;
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      acc.fill(0);
      const dx = x - cx;
      const dy = y - cy;
      for (let i = 0; i < n; i += 1) {
        const t = (i / (n - 1) - 0.5) * total;
        const cos = Math.cos(t);
        const sin = Math.sin(t);
        accumulate(src, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, false, 1, acc, tmp);
      }
      flushAcc(out.data, (y * w + x) * 4, acc);
    }
  }
  return out;
}

/**
 * 镜头模糊：先做整体散焦，再把高光抠出来单独「散景」叠回去 ——
 * 这是真实镜头成像里高光过曝成光斑的成因。
 */
export function lensBlur(
  src: RgbaBuffer,
  radius: number,
  threshold: number,
  boost: number,
): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const base = gaussianBlur(src, Math.max(0.4, radius));
  const hl = makeBuffer(w, h);
  const th = Math.min(254, Math.max(0, threshold));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const lum = lumaAt(data, o);
      if (lum <= th) continue;
      const k = (lum - th) / (255 - th);
      const a = (data[o + 3] / 255) * k * k;
      hl.data[o] = data[o];
      hl.data[o + 1] = data[o + 1];
      hl.data[o + 2] = data[o + 2];
      hl.data[o + 3] = a * 255;
    }
  }
  // 三轮小半径盒式模糊逼近圆形光圈
  let b = hl;
  for (let i = 0; i < 3; i += 1) b = boxBlur(b, Math.max(1, radius * 0.45));
  const k = boost / 100;
  const out = cloneBuffer(base);
  for (let i = 0; i < w * h * 4; i += 4) {
    const cov = (b.data[i + 3] / 255) * k;
    if (cov <= 0) continue;
    for (let c = 0; c < 3; c += 1) {
      const v = out.data[i + c] + b.data[i + c] * cov;
      out.data[i + c] = v > 255 ? 255 : v;
    }
  }
  return out;
}

/* ------------------------------------------------------------ 形状模糊 */

/** 判断点是否落在指定形状的核内（均以 r 为外接半径）。 */
function inShape(shape: number, dx: number, dy: number, r: number): boolean {
  if (shape === 2) return true; // 方形
  if (shape === 1) return Math.abs(dx) + Math.abs(dy) <= r; // 菱形
  if (shape === 3) {
    // 六边形
    const s3 = Math.sqrt(3) / 2;
    return Math.abs(dy) <= r * s3 && Math.abs(dx) * s3 + Math.abs(dy) * 0.5 <= r * s3;
  }
  return dx * dx + dy * dy <= r * r; // 圆形
}

/**
 * 形状模糊：用一个二值形状当卷积核。
 * 核体积按分辨率自适应降采样（stride），避免大图卡死。
 */
export function shapeBlur(
  src: RgbaBuffer,
  radius: number,
  iterations: number,
  shape: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const r = Math.max(1, Math.round(radius));
  const offs: number[] = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (inShape(shape, dx, dy, r)) offs.push(dx, dy);
    }
  }
  const budget = w * h > 1_000_000 ? 40 : 96;
  const stride = Math.max(1, Math.ceil(offs.length / 2 / budget));
  const kern: number[] = [];
  for (let i = 0; i < offs.length; i += stride * 2) kern.push(offs[i], offs[i + 1]);

  let cur = cloneBuffer(src);
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  for (let it = 0; it < Math.max(1, Math.round(iterations)); it += 1) {
    const out = makeBuffer(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        acc.fill(0);
        for (let i = 0; i < kern.length; i += 2) {
          accumulate(cur, x + kern[i], y + kern[i + 1], false, 1, acc, tmp);
        }
        flushAcc(out.data, (y * w + x) * 4, acc);
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * 智能模糊：半径内只吸收「与中心亮度差在阈值内」的邻像素，所以能保边。
 * mode=0 硬阈值（PS 的正常模式），mode=1 软权重（差值越大权重越低）。
 */
export function smartBlur(
  src: RgbaBuffer,
  radius: number,
  threshold: number,
  quality: number,
  mode: number,
): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const r = Math.max(1, radius);
  const perRing = quality >= 2 ? 16 : quality >= 1 ? 12 : 8;
  const rings = quality >= 2 ? 3 : 2;
  const th = Math.max(1, threshold);
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  const ang355 = Math.PI * 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const l0 = lumaAt(data, o);
      acc.fill(0);
      accumulate(src, x, y, false, 1, acc, tmp);
      for (let ring = 1; ring <= rings; ring += 1) {
        const rad = (r * ring) / rings;
        for (let i = 0; i < perRing; i += 1) {
          const a = (ang355 * i) / perRing + ring * 0.31;
          const sx = x + Math.cos(a) * rad;
          const sy = y + Math.sin(a) * rad;
          const sxx = Math.min(w - 1, Math.max(0, Math.round(sx)));
          const syy = Math.min(h - 1, Math.max(0, Math.round(sy)));
          const so = (syy * w + sxx) * 4;
          const dl = Math.abs(lumaAt(data, so) - l0);
          let wgt = mode === 1 ? Math.exp(-((dl / th) * (dl / th))) : dl <= th ? 1 : 0;
          if (wgt <= 0.001) continue;
          if (wgt > 1) wgt = 1;
          accumulate(src, sx, sy, false, wgt, acc, tmp);
        }
      }
      flushAcc(out.data, o, acc);
    }
  }
  return out;
}

/* ------------------------------------------------------------ 位移 */

/** 位移图：0=棋盘格 1=湍流 2=径向。返回值域 [-0.5, 0.5]。 */
function map1(mode: number, x: number, y: number, w: number, h: number): number {
  if (mode === 1) {
    return valueNoise(x / 24, y / 24, 3) - 0.5;
  }
  if (mode === 2) {
    const dx = x / Math.max(1, w - 1) - 0.5;
    const dy = y / Math.max(1, h - 1) - 0.5;
    const d = Math.hypot(dx, dy);
    return (Math.sin(d * Math.PI * 4) * 0.5 - 0.5) * -1;
  }
  const cell = 32;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  return (cx + cy) % 2 === 0 ? 0.5 : -0.5;
}

/** 位移：用一张程序生成的位移图把像素推歪。 */
export function displace(
  src: RgbaBuffer,
  hAmount: number,
  vAmount: number,
  mode: number,
  edge: number,
): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const wrap = edge === 1;
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const m = map1(mode, x, y, w, h);
      acc.fill(0);
      accumulate(src, x + m * hAmount, y + m * vAmount, wrap, 1, acc, tmp);
      flushAcc(out.data, (y * w + x) * 4, acc);
    }
  }
  return out;
}

/* -------------------------------------------------------- 彩色半调 */

interface Screen {
  angle: number;
  ink: number;
}

/**
 * 彩色半调：CMYK 四张网点屏（15°/75°/0°/45°，即 PS 的默认网屏角度）。
 * 每通道独立算出该点是否落墨，再按减色法叠回 RGB。
 */
export function colorHalftone(src: RgbaBuffer, size: number): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const period = Math.max(2, size);
  const scr: Screen[] = [
    { angle: (15 * Math.PI) / 180, ink: 0 },
    { angle: (75 * Math.PI) / 180, ink: 0 },
    { angle: 0, ink: 0 },
    { angle: (45 * Math.PI) / 180, ink: 0 },
  ];
  const cos = scr.map((s) => Math.cos(s.angle));
  const sin = scr.map((s) => Math.sin(s.angle));
  const k = Math.PI / period;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const cInk = 1 - data[o] / 255;
      const mInk = 1 - data[o + 1] / 255;
      const yInk = 1 - data[o + 2] / 255;
      const kInk = Math.min(cInk, mInk, yInk);
      const denom = Math.max(0.0001, 1 - kInk);
      const levels = [(cInk - kInk) / denom, (mInk - kInk) / denom, (yInk - kInk) / denom, kInk];
      const dots = [0, 0, 0, 0];
      for (let i = 0; i < 4; i += 1) {
        const sx = x * cos[i] - y * sin[i];
        const sy = x * sin[i] + y * cos[i];
        const pattern = Math.sin(sx * k) * Math.sin(sy * k);
        if (pattern + 2 * levels[i] - 1 >= 0) dots[i] = 1;
      }
      const rr = Math.min(1, dots[0] + dots[3]);
      const gg = Math.min(1, dots[1] + dots[3]);
      const bb = Math.min(1, dots[2] + dots[3]);
      out.data[o] = (1 - rr) * 255;
      out.data[o + 1] = (1 - gg) * 255;
      out.data[o + 2] = (1 - bb) * 255;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}

/* ------------------------------------------------------------ HSB/HSL */

function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h *= 60;
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max / 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r / 255) h = ((g / 255 - b / 255) / d) % 6;
  else if (max === g / 255) h = (b / 255 - r / 255) / d + 2;
  else h = (r / 255 - g / 255) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/**
 * HSB / HSL：把颜色拆到色相/饱和度/明度（亮度）三个分量，并分别写入
 * R/G/B 三个通道输出 —— 方便把任意一个分量当蒙版抠出来用。
 */
export function hsbHsl(src: RgbaBuffer, mode: number): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const triple = mode === 1 ? rgbToHsl(data[o], data[o + 1], data[o + 2]) : rgbToHsb(data[o], data[o + 1], data[o + 2]);
      out.data[o] = (triple[0] / 360) * 255;
      out.data[o + 1] = triple[1] * 255;
      out.data[o + 2] = triple[2] * 255;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}
