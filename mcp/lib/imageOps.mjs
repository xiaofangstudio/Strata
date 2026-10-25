/**
 * 图像管线（像素运算层，Mark 2）。
 *
 * 让 MCP 不只是「读写工程 JSON」的外壳，而是能真的打开一张 JPEG / PNG、
 * 做调色与滤镜、再导出成图 —— 全部走 Node 侧纯 JS，不依赖浏览器 Canvas。
 *
 * 设计原则（与 src/engine/filters/kernels.ts 保持一致）：
 *  · **纯函数**：输入 { data:RGBA, width, height }，输出同结构，便于单测与组合；
 *  · **徒手 India math**：所有曲面 / 色阶都以 256 查找表（LUT）先算一次再查表，
 *    每个像素只做一次数组访问，4000×3000 也在毫秒级；
 *  · **算法语义对照 PhotoCraft / Photoshop**：channelMixer 与 PS 通道混合器同一口径
 *    （输出通道由输入通道加权混合而成，所以「删掉某几个颜色通道」就是它的特例）。
 *
 * 调整算子 Ported from ArtCraft PhotoCraft (crates/algo)，MIT / Apache-2.0。
 */
import { decodePng, encodePng } from "./png.mjs";
import jpeg from "jpeg-js";

/* ---------------------------------------------------------------- 编解码 */

/** 常见格式的魔数识别，避免只看扩展名被改名的图骗过去。 */
function sniff(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes.length >= 6 && (bytes[2] === 0x01 || bytes[2] === 0x02)) {
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  }
  return null;
}

/**
 * 解码一张图（PNG / JPEG），统一输出 RGBA。
 * jpeg-js 解码出来没有 alpha，这里补 255。
 */
export function decodeImage(bytes) {
  const kind = sniff(bytes);
  if (kind === "png") {
    const { width, height, data } = decodePng(bytes);
    return { width, height, data };
  }
  if (kind === "jpeg") {
    const raw = jpeg.decode(bytes, { useTArray: true });
    const { width, height, data } = raw;
    return { width, height, data };
  }
  throw new Error(
    `不支持的图片格式（识别到的魔数：${kind ?? "未知"}）。目前支持 PNG 与 JPEG。`,
  );
}

/** 编码为 PNG 字节。 */
export function encodeImagePng(img) {
  return encodePng(img.width, img.height, img.data);
}

/** 编码为 JPEG 字节（quality 0–100）。 */
export function encodeImageJpeg(img, quality = 92) {
  const raw = { width: img.width, height: img.height, data: img.data };
  const out = jpeg.encode(raw, Math.min(100, Math.max(1, Math.round(quality))));
  return Buffer.from(out.data);
}

/* ---------------------------------------------------------------- 小工具 */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** 复制一份缓冲（算子默认不改原图，方便做 before/after 对比）。 */
function cloneImage(img) {
  return {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data),
  };
}

/** 生成 256 项 LUT 并执行：逐像素替换某个通道的值。 */
function applyLut(img, lutR, lutG, lutB) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lutR[d[i]];
    d[i + 1] = lutG[d[i + 1]];
    d[i + 2] = lutB[d[i + 2]];
  }
  return img;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/* ---------------------------------------------------------------- 调整算子 */

/**
 * 亮度 / 对比度。PS 语义：先乘对比斜率再偏移亮度；
 * 对比度为负时围绕灰点收缩，为正时向两端张开。
 */
export function brightnessContrast(img, brightness = 0, contrast = 0) {
  const out = cloneImage(img);
  const k = contrast >= 0 ? (100 + contrast) / 100 : (100 + contrast) / 100;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    const v = (i - 128) * k + 128 + brightness;
    lut[i] = clamp255(v);
  }
  return applyLut(out, lut, lut, lut);
}

/**
 * 饱和度（-100–100）。按 Rec.709 亮度保留明度，只在 chroma 上缩放；
 * 与 PS「色相/饱和度」的饱和度滑杆同一口径。
 */
export function saturation(img, amount = 0) {
  const out = cloneImage(img);
  const k = 1 + amount / 100;
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (r === g && g === b) continue;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    d[i] = clamp255(lum + (r - lum) * k);
    d[i + 1] = clamp255(lum + (g - lum) * k);
    d[i + 2] = clamp255(lum + (b - lum) * k);
  }
  return out;
}

/**
 * 自然饱和度（vibrance）：同样的提升低饱和像素涨得多、已经很艳的涨得少，
 * 所以不会出现 PS 饱和度一拉就溢色的问题 —— 修人像 / 猫眼神必备。
 */
export function vibrance(img, amount = 0) {
  const out = cloneImage(img);
  const k = amount / 100;
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx === mn) continue;
    const sat = (mx - mn) / 255;
    // 越接近灰就越好好 ~~(1 - sat)：低饱和区域增速快
    const gain = k * (1 - sat) * 2;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    d[i] = clamp255(lum + (r - lum) * (1 + gain));
    d[i + 1] = clamp255(lum + (g - lum) * (1 + gain));
    d[i + 2] = clamp255(lum + (b - lum) * (1 + gain));
  }
  return out;
}

/**
 * 色阶（levels）。PS 语义：低于输入黑场的压到 0、高于白场的拉到 255，
 * 中间按 gamma 做幂律（gamma>1 变亮、<1 变暗）。
 * 每个通道一套参数，所以全图 / 单通道通用。
 */
export function levels(
  img,
  { shadowIn = 0, highlightIn = 255, gamma = 1, shadowOut = 0, highlightOut = 255 } = {},
  channel = "rgb",
) {
  const out = cloneImage(img);
  const si = Math.min(253, Math.max(0, shadowIn));
  const hi = Math.max(si + 2, Math.min(255, highlightIn));
  const g = Math.max(0.01, Math.min(9.99, gamma));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    const t = Math.min(1, Math.max(0, (i - si) / (hi - si)));
    lut[i] = clamp255(shadowOut + Math.pow(t, 1 / g) * (highlightOut - shadowOut));
  }
  const none = identityLut();
  if (channel === "r") return applyLut(out, lut, none, none);
  if (channel === "g") return applyLut(out, none, lut, none);
  if (channel === "b") return applyLut(out, none, none, lut);
  return applyLut(out, lut, lut, lut);
}

function identityLut() {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) lut[i] = i;
  return lut;
}

/**
 * 曲线（curves）。控制点按 x 升序，先在段间线性插值、再补两端，
 * 建成 256 LUT —— 与 PS 曲线面板同一语义（你拖的那条线上的点）。
 *
 * 支持分通道：channel = "rgb" | "r" | "g" | "b"，与 PropertiesPanel
 * 的 CurveEditor 用同一份点集格式 [{x, y}]。
 */
export function curves(img, points, channel = "rgb") {
  const out = cloneImage(img);
  const pts = (points ?? []).slice().sort((a, b) => a.x - b.x);
  if (pts.length < 2) return out;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    let v = i;
    if (i <= pts[0].x) {
      v = pts[0].y;
    } else if (i >= pts[pts.length - 1].x) {
      v = pts[pts.length - 1].y;
    } else {
      for (let s = 0; s < pts.length - 1; s += 1) {
        const a = pts[s];
        const b = pts[s + 1];
        if (i >= a.x && i <= b.x) {
          const t = b.x === a.x ? 0 : (i - a.x) / (b.x - a.x);
          v = a.y + (b.y - a.y) * t;
          break;
        }
      }
    }
    lut[i] = clamp255(v);
  }
  const none = identityLut();
  if (channel === "r") return applyLut(out, lut, none, none);
  if (channel === "g") return applyLut(out, none, lut, none);
  if (channel === "b") return applyLut(out, none, none, lut);
  return applyLut(out, lut, lut, lut);
}

/**
 * 通道混合器（channelMixer）。PS 语义：
 * 输出通道 = 各输入通道按权重混合（权重以百分比计、-200…200），再整体加 bias。
 *
 * 这是「删掉颜色通道」的正规做法：
 *   · 只留红     → redOut = {r:100, g:0,   b:0}
 *   · 只留绿     → greenOut = {r:0, g:100, b:0}
 *   · 只留黄(RG) → redOut={r:100}, greenOut={g:100}, blueOut={} 全零
 * 比直接把某通道归零更平滑，可以做出真实的“只保留某几个通道”的色调。
 */
export function channelMixer(
  img,
  { red = { r: 100, g: 0, b: 0 }, green = { r: 0, g: 100, b: 0 }, blue = { r: 0, g: 0, b: 100 }, biasR = 0, biasG = 0, biasB = 0 } = {},
) {
  const out = cloneImage(img);
  const d = out.data;
  const s = (v) => (v ?? 0) / 100;
  const rW = [s(red.r), s(red.g), s(red.b)];
  const gW = [s(green.r), s(green.g), s(green.b)];
  const bW = [s(blue.r), s(blue.g), s(blue.b)];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    d[i] = clamp255(r * rW[0] + g * rW[1] + b * rW[2] + biasR);
    d[i + 1] = clamp255(r * gW[0] + g * gW[1] + b * gW[2] + biasG);
    d[i + 2] = clamp255(r * bW[0] + g * bW[1] + b * bW[2] + biasB);
  }
  return out;
}

/**
 * 黑白（去色后可选色调 —— 对应 PS 的黑白调整）。
 * weights 为 RGB 权重（百分比），tint 为 0–360 的色相角（可选）。
 */
export function blackWhite(img, weights = { r: 40, g: 40, b: 20 }, tint = null) {
  const out = cloneImage(img);
  const d = out.data;
  const tw = weights.r + weights.g + weights.b || 1;
  const wr = weights.r / tw;
  const wg = weights.g / tw;
  const wb = weights.b / tw;
  const tr = tint === null ? 0 : Math.cos((tint * Math.PI) / 180) * 0.3;
  const tg = tint === null ? 0 : Math.sin((tint * Math.PI) / 180) * 0.3;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] * wr + d[i + 1] * wg + d[i + 2] * wb;
    d[i] = clamp255(v + v * tr);
    d[i + 1] = clamp255(v - v * tg * 0.5);
    d[i + 2] = clamp255(v - v * tr);
  }
  return out;
}

/** 曝光（EV 档，-5…5）与偏移：先 2^EV 再线性加 offset，与 PS Exposure 一致。 */
export function exposure(img, ev = 0, offset = 0, gamma = 1) {
  const out = cloneImage(img);
  const k = Math.pow(2, ev);
  const invG = 1 / Math.max(0.01, Math.min(9.99, gamma));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255;
    lut[i] = clamp255(Math.pow(t * k + offset, invG) * 255);
  }
  return applyLut(out, lut, lut, lut);
}

/** 白平衡：temp 冷(-)暖(+)、tint 品红(-)绿(+)，各 -100…100。 */
export function whiteBalance(img, temp = 0, tint = 0) {
  const out = cloneImage(img);
  const t = temp / 100;
  const g = tint / 100;
  const lutR = new Uint8ClampedArray(256);
  const lutG = new Uint8ClampedArray(256);
  const lutB = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    lutR[i] = clamp255(i * (1 + 0.12 * t));
    lutG[i] = clamp255(i * (1 - 0.06 * g));
    lutB[i] = clamp255(i * (1 - 0.12 * t));
  }
  return applyLut(out, lutR, lutG, lutB);
}

/** 色相旋转（-180…180 度）+ 明度。 */
export function hueRotate(img, degrees = 0) {
  const out = cloneImage(img);
  const angle = (degrees * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    d[i] = clamp255(lum + (r - lum) * c - (g - lum) * s);
    d[i + 1] = clamp255(lum + (r - lum) * s + (g - lum) * c);
    d[i + 2] = clamp255(lum + (b - lum));
  }
  return out;
}

/** 反相 / 去色 / 色调分离 / 阈值。 */
export function invert(img) {
  const out = cloneImage(img);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  return out;
}

export function grayscale(img) {
  const out = cloneImage(img);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  return out;
}

export function posterize(img, levelsCount = 6) {
  const out = cloneImage(img);
  const n = Math.max(2, Math.min(255, Math.round(levelsCount)));
  const lut = new Uint8ClampedArray(256);
  const step = 255 / (n - 1);
  for (let i = 0; i < 256; i += 1) lut[i] = clamp255(Math.round(i / step) * step);
  return applyLut(out, lut, lut, lut);
}

export function threshold(img, value = 128) {
  const out = cloneImage(img);
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) lut[i] = i >= value ? 255 : 0;
  return applyLut(out, lut, lut, lut);
}

/**
 * 色彩平衡：分别对暗调 / 中间调 / 高光推 cyan-red、magenta-green、yellow-blue，
 * 每轴 -100…100，与 PS Color Balance 同一套三分区模型。
 */
export function colorBalance(
  img,
  { shadows = [0, 0, 0], midtones = [0, 0, 0], highlights = [0, 0, 0] } = {},
) {
  const out = cloneImage(img);
  const d = out.data;
  const zoneLut = (a, b, c) => {
    const lutR = new Uint8ClampedArray(256);
    const lutG = new Uint8ClampedArray(256);
    const lutB = new Uint8ClampedArray(256);
    const cr = a / 100;
    const mg = b / 100;
    const yb = c / 100;
    for (let i = 0; i < 256; i += 1) {
      lutR[i] = clamp255(i + yb * 100 * 0.5 - cr * 100 * 0.5 + cr * i * 0.2);
      lutG[i] = clamp255(i + mg * 100 * 0.5 - mg * i * 0.2);
      lutB[i] = clamp255(i + cr * 100 * 0.5 - yb * 100 * 0.5 + yb * i * 0.2);
    }
    return [lutR, lutG, lutB];
  };
  const [slR, slG, slB] = zoneLut(shadows[0], shadows[1], shadows[2]);
  const [mlR, mlG, mlB] = zoneLut(midtones[0], midtones[1], midtones[2]);
  const [hlR, hlG, hlB] = zoneLut(highlights[0], highlights[1], highlights[2]);
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    // 三个分区平滑交叉：暗调在 0.25 处占满，高光在 0.75 处占满
    const wS = Math.max(0, 1 - lum / 0.35);
    const wH = Math.max(0, (lum - 0.65) / 0.35);
    const wM = Math.max(0, 1 - wS - wH);
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (wS + wM + wH <= 0) continue;
    d[i] = clamp255((slR[r] * wS + mlR[r] * wM + hlR[r] * wH) / (wS + wM + wH));
    d[i + 1] = clamp255((slG[g] * wS + mlG[g] * wM + hlG[g] * wH) / (wS + wM + wH));
    d[i + 2] = clamp255((slB[b] * wS + mlB[b] * wM + hlB[b] * wH) / (wS + wM + wH));
  }
  return out;
}

/* ---------------------------------------------------------------- 滤镜 */

/** 盒式 / 表面模糊的可分离ITO核心（水平 + 垂直两趟）。 */
function boxBlurPass(img, radius) {
  const { width, height, data } = img;
  if (radius < 1) return img;
  const r = Math.round(radius);
  const out = new Uint8ClampedArray(data.length);
  const win = r * 2 + 1;
  // 水平
  for (let y = 0; y < height; y += 1) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    const row = y * width;
    for (let i = -r; i <= r; i += 1) {
      const x = Math.min(width - 1, Math.max(0, i));
      const p = (row + x) * 4;
      sr += data[p];
      sg += data[p + 1];
      sb += data[p + 2];
      sa += data[p + 3];
    }
    for (let x = 0; x < width; x += 1) {
      const o = (row + x) * 4;
      out[o] = sr / win;
      out[o + 1] = sg / win;
      out[o + 2] = sb / win;
      out[o + 3] = sa / win;
      const addX = Math.min(width - 1, x + r + 1);
      const subX = Math.max(0, x - r);
      const ap = (row + addX) * 4;
      const sp = (row + subX) * 4;
      sr += data[ap] - data[sp];
      sg += data[ap + 1] - data[sp + 1];
      sb += data[ap + 2] - data[sp + 2];
      sa += data[ap + 3] - data[sp + 3];
    }
  }
  // 垂直
  const final = new Uint8ClampedArray(data.length);
  for (let x = 0; x < width; x += 1) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    for (let i = -r; i <= r; i += 1) {
      const y = Math.min(height - 1, Math.max(0, i));
      const p = (y * width + x) * 4;
      sr += out[p];
      sg += out[p + 1];
      sb += out[p + 2];
      sa += out[p + 3];
    }
    for (let y = 0; y < height; y += 1) {
      const o = (y * width + x) * 4;
      final[o] = sr / win;
      final[o + 1] = sg / win;
      final[o + 2] = sb / win;
      final[o + 3] = sa / win;
      const addY = Math.min(height - 1, y + r + 1);
      const subY = Math.max(0, y - r);
      const ap = (addY * width + x) * 4;
      const sp = (subY * width + x) * 4;
      sr += out[ap] - out[sp];
      sg += out[ap + 1] - out[sp + 1];
      sb += out[ap + 2] - out[sp + 2];
      sa += out[ap + 3] - out[sp + 3];
    }
  }
  return { width, height, data: final };
}

/** 高斯核：按 sigma 生成，归一化的 1D 核心。 */
function gaussianKernel(sigma) {
  const rad = Math.max(1, Math.ceil(sigma * 3));
  const size = rad * 2 + 1;
  const k = new Float32Array(size);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const x = i - rad;
    const v = Math.exp(-(x * x) / s2);
    k[i] = v;
    sum += v;
  }
  for (let i = 0; i < size; i += 1) k[i] /= sum;
  return { k, rad };
}

/** 可分离高斯模糊（先在 x 上 fuss，再在 y 上）。 */
export function gaussianBlur(img, radius = 4) {
  const sigma = Math.max(0.1, radius / 2);
  const { k, rad } = gaussianKernel(sigma);
  const { width, height, data } = img;
  const tmp = new Uint8ClampedArray(data.length);
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = -rad; i <= rad; i += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + i));
        const p = (y * width + sx) * 4;
        const w = k[i + rad];
        r += data[p] * w;
        g += data[p + 1] * w;
        b += data[p + 2] * w;
        a += data[p + 3] * w;
      }
      const o = (y * width + x) * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = -rad; i <= rad; i += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + i));
        const p = (sy * width + x) * 4;
        const w = k[i + rad];
        r += tmp[p] * w;
        g += tmp[p + 1] * w;
        b += tmp[p + 2] * w;
        a += tmp[p + 3] * w;
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}

export function boxBlur(img, radius = 3) {
  return boxBlurPass(cloneImage(img), radius);
}

/**
 * USM 锐化（unsharpMask）：原图 + amount% ×(原图 − 模糊图)，
 * 只有差值超过 threshold 的部分才参与，避免把噪点一起放大 —— 与 PS 完全一致。
 */
export function unsharpMask(img, radius = 2, amount = 100, threshold = 3) {
  const blurred = gaussianBlur(img, radius);
  const out = cloneImage(img);
  const d = out.data;
  const b = blurred.data;
  const k = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const diff = d[i + c] - b[i + c];
      if (Math.abs(diff) > threshold) d[i + c] = clamp255(d[i + c] + diff * k);
    }
  }
  return out;
}

/** 添加杂色（单色 / 彩色），确定种子可复现。 */
export function addNoise(img, amount = 5, monochrome = true, seed = 1) {
  const out = cloneImage(img);
  const d = out.data;
  let s = seed || 1;
  const rnd = () => {
    // xorshift32：便宜、分布够好，且同一种子永远出同一张噪点图
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000) / 1000;
  };
  const amp = (amount / 100) * 255;
  if (monochrome) {
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * amp;
      d[i] = clamp255(d[i] + n);
      d[i + 1] = clamp255(d[i + 1] + n);
      d[i + 2] = clamp255(d[i + 2] + n);
    }
  } else {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp255(d[i] + (rnd() - 0.5) * amp);
      d[i + 1] = clamp255(d[i + 1] + (rnd() - 0.5) * amp);
      d[i + 2] = clamp255(d[i + 2] + (rnd() - 0.5) * amp);
    }
  }
  return out;
}

/** 马赛克（彩块化）：按 cell 取块平均值。 */
export function mosaic(img, cell = 12) {
  const size = Math.max(2, Math.round(cell));
  const out = cloneImage(img);
  const { width, height, data } = out;
  const src = new Uint8ClampedArray(data);
  for (let by = 0; by < height; by += size) {
    for (let bx = 0; bx < width; bx += size) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      const ey = Math.min(height, by + size);
      const ex = Math.min(width, bx + size);
      for (let y = by; y < ey; y += 1) {
        for (let x = bx; x < ex; x += 1) {
          const p = (y * width + x) * 4;
          r += src[p];
          g += src[p + 1];
          b += src[p + 2];
          n += 1;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      for (let y = by; y < ey; y += 1) {
        for (let x = bx; x < ex; x += 1) {
          const p = (y * width + x) * 4;
          data[p] = r;
          data[p + 1] = g;
          data[p + 2] = b;
        }
      }
    }
  }
  return out;
}

/** 中间值（去斑 / 降噪），radius 为邻域半径。 */
export function median(img, radius = 1) {
  const out = cloneImage(img);
  const { width, height, data } = out;
  const src = new Uint8ClampedArray(data);
  const win = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        win.length = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const sy = Math.min(height - 1, Math.max(0, y + dy));
            const sx = Math.min(width - 1, Math.max(0, x + dx));
            win.push(src[(sy * width + sx) * 4 + c]);
          }
        }
        win.sort((a, b) => a - b);
        data[(y * width + x) * 4 + c] = win[Math.floor(win.length / 2)];
      }
    }
  }
  return out;
}

/** 动感模糊：沿角度做多次线性叠加采样。 */
export function motionBlur(img, angleDeg = 0, distance = 20) {
  const out = cloneImage(img);
  const { width, height, data } = out;
  const src = new Uint8ClampedArray(data);
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const steps = Math.max(1, Math.round(distance));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let s = 0; s < steps; s += 1) {
        const t = s - steps / 2;
        const sx = Math.min(width - 1, Math.max(0, Math.round(x + dx * t)));
        const sy = Math.min(height - 1, Math.max(0, Math.round(y + dy * t)));
        const p = (sy * width + sx) * 4;
        r += src[p];
        g += src[p + 1];
        b += src[p + 2];
        a += src[p + 3];
      }
      const o = (y * width + x) * 4;
      data[o] = r / steps;
      data[o + 1] = g / steps;
      data[o + 2] = b / steps;
      data[o + 3] = a / steps;
    }
  }
  return out;
}

/** 等比缩放（最近邻，够为中国 —— 预览图用）。 */
export function resize(img, maxSide) {
  const longest = Math.max(img.width, img.height);
  if (!maxSide || longest <= maxSide) return img;
  const k = maxSide / longest;
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(img.height - 1, Math.floor(y / k));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(img.width - 1, Math.floor(x / k));
      const sp = (sy * img.width + sx) * 4;
      const dp = (y * w + x) * 4;
      data[dp] = img.data[sp];
      data[dp + 1] = img.data[sp + 1];
      data[dp + 2] = img.data[sp + 2];
      data[dp + 3] = img.data[sp + 3];
    }
  }
  return { width: w, height: h, data };
}

/* ---------------------------------------------------------- 算子注册表 */

/**
 * 可用调整算子表：名字 → 执行函数 + 参数说明。
 * MCP 工具只认这里的名字，客户端可以先问 strata_capabilities 取清单。
 */
export const ADJUSTERS = {
  brightnessContrast: {
    label: "亮度 / 对比度",
    params: ["brightness (-100…100)", "contrast (-100…100)"],
    run: (img, p) => brightnessContrast(img, p.brightness, p.contrast),
  },
  saturation: {
    label: "饱和度",
    params: ["amount (-100…100)"],
    run: (img, p) => saturation(img, p.amount),
  },
  vibrance: {
    label: "自然饱和度",
    params: ["amount (-100…100)"],
    run: (img, p) => vibrance(img, p.amount),
  },
  levels: {
    label: "色阶",
    params: ["shadowIn", "highlightIn", "gamma", "shadowOut", "highlightOut", "channel"],
    run: (img, p) => levels(img, p, p.channel ?? "rgb"),
  },
  curves: {
    label: "曲线",
    params: ["points [{x,y}]", "channel"],
    run: (img, p) => curves(img, p.points, p.channel ?? "rgb"),
  },
  channelMixer: {
    label: "通道混合器",
    params: ["red/green/blue 权重对象", "biasR/G/B"],
    run: (img, p) => channelMixer(img, p),
  },
  blackWhite: {
    label: "黑白",
    params: ["weights", "tint"],
    run: (img, p) => blackWhite(img, p.weights, p.tint ?? null),
  },
  exposure: {
    label: "曝光",
    params: ["ev", "offset", "gamma"],
    run: (img, p) => exposure(img, p.ev, p.offset, p.gamma),
  },
  whiteBalance: {
    label: "白平衡",
    params: ["temp", "tint"],
    run: (img, p) => whiteBalance(img, p.temp, p.tint),
  },
  hueRotate: {
    label: "色相旋转",
    params: ["degrees"],
    run: (img, p) => hueRotate(img, p.degrees),
  },
  colorBalance: {
    label: "色彩平衡",
    params: ["shadows", "midtones", "highlights（各 [c-r, m-g, y-b]）"],
    run: (img, p) => colorBalance(img, p),
  },
  invert: { label: "反相", params: [], run: (img) => invert(img) },
  grayscale: { label: "去色", params: [], run: (img) => grayscale(img) },
  posterize: {
    label: "色调分离",
    params: ["levelsCount"],
    run: (img, p) => posterize(img, p.levelsCount),
  },
  threshold: { label: "阈值", params: ["value"], run: (img, p) => threshold(img, p.value) },
};

/** 可用滤镜表。 */
export const FILTERS = {
  gaussianBlur: {
    label: "高斯模糊",
    params: ["radius"],
    run: (img, p) => gaussianBlur(img, p.radius ?? 4),
  },
  boxBlur: { label: "方框模糊", params: ["radius"], run: (img, p) => boxBlur(img, p.radius ?? 3) },
  unsharpMask: {
    label: "USM 锐化",
    params: ["radius", "amount", "threshold"],
    run: (img, p) => unsharpMask(img, p.radius, p.amount, p.threshold),
  },
  addNoise: {
    label: "添加杂色",
    params: ["amount", "monochrome", "seed"],
    run: (img, p) => addNoise(img, p.amount, p.monochrome, p.seed),
  },
  mosaic: { label: "马赛克", params: ["cell"], run: (img, p) => mosaic(img, p.cell) },
  median: { label: "中间值", params: ["radius"], run: (img, p) => median(img, p.radius) },
  motionBlur: {
    label: "动感模糊",
    params: ["angleDeg", "distance"],
    run: (img, p) => motionBlur(img, p.angleDeg, p.distance),
  },
};

/* ==================================================== 合成套件（Mark 3）
 *
 * 抠图 → 换主体 → 分区调色 → 打光，一条完整合成链路的像素层支撑。
 * 没有AI分割（项目明确剔除），抠图走「边界洪水填充 + 最大连通域 + 羽化」：
 * 对影棚/浅景深背景的猫图效果最好，复杂背景配合容差与羽化也能用。
 */

/** 单通道掩码结构。 */
// { width, height, data: Uint8Array } —— data 取 0…255，255 = 保留

/** 亮度图（0–255）。 */
function luminanceMap(img) {
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }
  return lum;
}

/**
 * Sobel 梯度幅值（0–255 量级）。
 * 只用来当"不许穿过"的墙：阈值调大 → 只有很硬的边能挡住；调小 → 纹理也会挡。
 */
function sobelMagnitude(img) {
  const { width: w, height: h } = img;
  const lum = luminanceMap(img);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const gx =
        -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] +
        lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const gy =
        -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] +
        lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      // 归一到 0–255（Sobel 最大约 4×255）
      mag[i] = Math.min(255, Math.sqrt(gx * gx + gy * gy) / 4);
    }
  }
  return mag;
}

/**
 * 从图像边界向内洪水填充，找出「与边相连的相似背景」。
 * 判定标准是**局部平滑**：邻居色差 ≤ tol 就并进来，所以渐变虚化背景也能跟住。
 * 返回 Uint8Array（1 = 背景）。
 */
export function backgroundFloodMask(img, tolerance = 28, edgeGate = 0, sides = "tlbr") {
  const { width: w, height: h, data } = img;
  // 容差语义：RGB 欧氏距离 ≤ tolerance × 2.55（tolerance 0–100，100 = 全图）。
  // 判定用「到自己种子区的颜色距离」，而不是「到父像素的距离」——
  // 纯局部判定会沿任何平滑梯度爬行（墙壁→床→猫一路吃穿），全局锚定才留得住主体。
  const limit = Math.max(1, tolerance) * 2.55;
  const tol = limit * limit;
  const bg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  // 每个入队像素携带它所属种子区的颜色（种子 = 边界像素本身）
  const seedR = new Uint8Array(w * h);
  const seedG = new Uint8Array(w * h);
  const seedB = new Uint8Array(w * h);
  let qh = 0;
  let qt = 0;
  const seed = (x, y) => {
    const i = y * w + x;
    if (!bg[i]) {
      bg[i] = 1;
      seedR[i] = data[i * 4];
      seedG[i] = data[i * 4 + 1];
      seedB[i] = data[i * 4 + 2];
      queue[qt++] = i;
    }
  };
  /*
   * 种子边：默认四条边都取。做成可配是因为「留背景」场景下底边的毛发/地毯
   * 往往和主体连在一起，从底边种下去会把它判成背景留下来（半透明绒毛会透出来）。
   * 只从上/左/右取种子，贴边的主体就会被完整判成主体、一起挖走。
   */
  const has = (ch) => sides.includes(ch);
  for (let x = 0; x < w; x += 1) {
    if (has("t")) seed(x, 0);
    if (has("b")) seed(x, h - 1);
  }
  for (let y = 0; y < h; y += 1) {
    if (has("l")) seed(0, y);
    if (has("r")) seed(w - 1, y);
  }
  // 边缘闸门：Sobel 梯度大的像素不许被背景"穿过"。
  // 这是同色主体能被抠出来的关键 —— 白猫趴在白床单上，颜色分不开，但轮廓处有梯度。
  const edge = edgeGate > 0 ? sobelMagnitude(img) : null;
  const dist2ToSeed = (i, s) => {
    const dr = data[i * 4] - seedR[s];
    const dg = data[i * 4 + 1] - seedG[s];
    const db = data[i * 4 + 2] - seedB[s];
    return dr * dr + dg * dg + db * db;
  };
  while (qh < qt) {
    const cur = queue[qh++];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    const tryNeighbor = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const ni = ny * w + nx;
      if (bg[ni]) return;
      if (edge && edge[ni] >= edgeGate) return;
      if (dist2ToSeed(ni, cur) <= tol) {
        bg[ni] = 1;
        seedR[ni] = seedR[cur];
        seedG[ni] = seedG[cur];
        seedB[ni] = seedB[cur];
        queue[qt++] = ni;
      }
    };
    tryNeighbor(cx - 1, cy);
    tryNeighbor(cx + 1, cy);
    tryNeighbor(cx, cy - 1);
    tryNeighbor(cx, cy + 1);
  }
  return bg;
}

/** 保留最大连通域（把洪水填充漏进主体的零碎小块洗掉）。 */
export function largestIsland(flags, w, h) {
  const out = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let best = [];
  for (let s = 0; s < w * h; s += 1) {
    if (!flags[s] || seen[s]) continue;
    // BFS 收集这个连通域
    let qh = 0;
    let qt = 0;
    const comp = [];
    seen[s] = 1;
    queue[qt++] = s;
    while (qh < qt) {
      const cur = queue[qh++];
      comp.push(cur);
      const cx = cur % w;
      const cy = (cur / w) | 0;
      const go = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const ni = ny * w + nx;
        if (flags[ni] && !seen[ni]) {
          seen[ni] = 1;
          queue[qt++] = ni;
        }
      };
      go(cx - 1, cy);
      go(cx + 1, cy);
      go(cx, cy - 1);
      go(cx, cy + 1);
    }
    if (comp.length > best.length) best = comp;
  }
  for (const i of best) out[i] = 255;
  return out;
}

/** 掩码羽化：把单通道掩码过一遍高斯。radius 为像素。 */
export function featherMask(mask, w, h, radius = 2) {
  if (radius <= 0) return mask;
  const asImg = {
    width: w,
    height: h,
    data: new Uint8ClampedArray(w * h * 4),
  };
  for (let i = 0; i < w * h; i += 1) {
    asImg.data[i * 4] = 255;
    asImg.data[i * 4 + 1] = 255;
    asImg.data[i * 4 + 2] = 255;
    asImg.data[i * 4 + 3] = mask[i];
  }
  // 注意：mask 约定为 0–255（255 = 完全保留）。调用方若持有 0/1 布尔掩码，
  // 必须先乘 255 —— 曾经 0/1 直接进来糊完全归零，成品整张贴图凭空消失。
  const blurred = gaussianBlur(asImg, radius);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) out[i] = blurred.data[i * 4 + 3];
  return out;
}

/** 非透明内容的包围盒（抠完裁一圈省像素）。 */
export function contentBounds(img, alphaThreshold = 8) {
  const { width: w, height: h, data } = img;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 裁到内容。 */
export function crop(img, box) {
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y += 1) {
    const src = ((y + box.y) * img.width + box.x) * 4;
    out.set(img.data.subarray(src, src + box.width * 4), y * box.width * 4);
  }
  return { width: box.width, height: box.height, data: out };
}

/**
 * 主体抠图：背景透明，返回裁到内容包围盒的 RGBA。
 * `invert` 为 true 时反着来 —— 留背景、抠走主体（换猫用的就是这一档）。
 */
export function cutout(
  img,
  { tolerance = 28, feather = 2, invert = false, trim = true, edgeGate = 0, sides = "tlbr" } = {},
) {
  const { width: w, height: h } = img;
  let bg = backgroundFloodMask(img, tolerance, edgeGate, sides);
  let subject = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) subject[i] = bg[i] ? 0 : 255;
  // 主体模式下只留最大连通域，防止背景里混进的孤岛跟过来
  if (!invert) subject = largestIsland(subject, w, h);
  let keep = invert
    ? (() => {
        // 背景模式：主体挖掉，主体掩码同样取最大连通域（把猫认全）
        const core = largestIsland(subject, w, h);
        const out = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i += 1) out[i] = core[i] ? 0 : 255;
        return out;
      })()
    : subject;
  const soft = featherMask(keep, w, h, feather);
  const out = {
    width: w,
    height: h,
    data: new Uint8ClampedArray(img.data),
  };
  for (let i = 0; i < w * h; i += 1) {
    out.data[i * 4 + 3] = Math.round((soft[i] / 255) * img.data[i * 4 + 3]);
  }
  if (trim && !invert) {
    const box = contentBounds(out);
    if (box) return crop(out, box);
  }
  return out;
}

/**
 * 孔洞填补（简易 inpaint）。
 *
 * 挖走主体后留下的洞，用「迭代扩散」补：每一轮把已知像素的色向未知区扩散
 * 一点、再把已知区盖回去，几十轮后洞就被周围的墙色/衣色平滑填满 ——
 * 对墙壁、虚化背景这类低频背景效果很好，且零依赖。
 */
export function inpaintFill(img, hole, iterations = 24, blurRadius = 6) {
  const { width: w, height: h } = img;
  const out = {
    width: w,
    height: h,
    data: new Uint8ClampedArray(img.data),
  };
  const d = out.data;
  const src = img.data;

  /*
   * 初始化用「十字拉伸」而不是全图均值：每个洞像素取左右最近已知像素做水平插值、
   * 上下最近已知像素做垂直插值，四者平均。墙壁 / 虚化背景这类低频区域一插就平；
   * 用全图均值会留一块明显发灰的补丁（之前那个"白耳朵鬼影"就是这么来的）。
   *
   * 最近已知位置预先两趟扫出索引，避免每个洞像素再扫一遍整行 —— 否则大洞会退化成 O(n²)。
   */
  const prevX = new Int32Array(w);
  const nextX = new Int32Array(w);
  const hFill = new Float32Array(w * h * 3);

  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let last = -1;
    for (let x = 0; x < w; x += 1) {
      prevX[x] = last;
      if (!hole[row + x]) last = x;
    }
    let nxt = -1;
    for (let x = w - 1; x >= 0; x -= 1) {
      nextX[x] = nxt;
      if (!hole[row + x]) nxt = x;
    }
    for (let x = 0; x < w; x += 1) {
      if (!hole[row + x]) continue;
      const a = prevX[x];
      const b = nextX[x];
      const base = (row + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        if (a >= 0 && b >= 0) {
          const t = (x - a) / (b - a);
          hFill[base + c] = src[(row + a) * 4 + c] + (src[(row + b) * 4 + c] - src[(row + a) * 4 + c]) * t;
        } else if (a >= 0) {
          hFill[base + c] = src[(row + a) * 4 + c];
        } else if (b >= 0) {
          hFill[base + c] = src[(row + b) * 4 + c];
        } else {
          hFill[base + c] = 128;
        }
      }
    }
  }

  const prevY = new Int32Array(h);
  const nextY = new Int32Array(h);
  for (let x = 0; x < w; x += 1) {
    let last = -1;
    for (let y = 0; y < h; y += 1) {
      prevY[y] = last;
      if (!hole[y * w + x]) last = y;
    }
    let nxt = -1;
    for (let y = h - 1; y >= 0; y -= 1) {
      nextY[y] = nxt;
      if (!hole[y * w + x]) nxt = y;
    }
    for (let y = 0; y < h; y += 1) {
      const i = y * w + x;
      if (!hole[i]) continue;
      const a = prevY[y];
      const b = nextY[y];
      for (let c = 0; c < 3; c += 1) {
        let v;
        if (a >= 0 && b >= 0) {
          const t = (y - a) / (b - a);
          v = src[(a * w + x) * 4 + c] + (src[(b * w + x) * 4 + c] - src[(a * w + x) * 4 + c]) * t;
        } else if (a >= 0) {
          v = src[(a * w + x) * 4 + c];
        } else if (b >= 0) {
          v = src[(b * w + x) * 4 + c];
        } else {
          v = 128;
        }
        d[i * 4 + c] = Math.round((hFill[i * 3 + c] + v) / 2);
      }
      d[i * 4 + 3] = 255;
    }
  }

  // 再跑几轮扩散 + 轻模糊，把十字拉伸的交界磨平
  const rounds = Math.max(1, Math.round(iterations / 4));
  for (let it = 0; it < rounds; it += 1) {
    const blurred = boxBlurPass(
      { width: w, height: h, data: new Uint8ClampedArray(d) },
      blurRadius,
    );
    for (let i = 0; i < w * h; i += 1) {
      if (!hole[i]) continue;
      d[i * 4] = blurred.data[i * 4];
      d[i * 4 + 1] = blurred.data[i * 4 + 1];
      d[i * 4 + 2] = blurred.data[i * 4 + 2];
      d[i * 4 + 3] = 255;
    }
  }
  return out;
}

/** 双线性缩放（合成换主体必备，最近邻会出锯齿）。 */
export function bilinearResize(img, w, h) {
  const sw = img.width;
  const sh = img.height;
  const out = new Uint8ClampedArray(w * h * 4);
  const kx = sw / w;
  const ky = sh / h;
  for (let y = 0; y < h; y += 1) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x += 1) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = img.data[(y0 * sw + x0) * 4 + c];
        const p01 = img.data[(y0 * sw + x1) * 4 + c];
        const p10 = img.data[(y1 * sw + x0) * 4 + c];
        const p11 = img.data[(y1 * sw + x1) * 4 + c];
        out[o + c] = lerp(lerp(p00, p01, wx), lerp(p10, p11, wx), wy);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** alpha-over 合成：把 overlay 贴到 base 的 (x, y) 上（可整体调不透明度）。 */
export function compositeOver(base, overlay, x, y, opacity = 1) {
  const out = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
  const bx = Math.round(x);
  const by = Math.round(y);
  for (let sy = 0; sy < overlay.height; sy += 1) {
    const dy = by + sy;
    if (dy < 0 || dy >= base.height) continue;
    for (let sx = 0; sx < overlay.width; sx += 1) {
      const dx = bx + sx;
      if (dx < 0 || dx >= base.width) continue;
      const si = (sy * overlay.width + sx) * 4;
      const a = (overlay.data[si + 3] / 255) * opacity;
      if (a <= 0) continue;
      const di = (dy * base.width + dx) * 4;
      for (let c = 0; c < 3; c += 1) {
        out.data[di + c] = Math.round(
          overlay.data[si + c] * a + out.data[di + c] * (1 - a),
        );
      }
      out.data[di + 3] = Math.max(out.data[di + 3], Math.round(overlay.data[si + 3] * opacity));
    }
  }
  return out;
}

/** 接触阴影：在 (cx, cy) 画一枚模糊椭圆暗斑压在主体脚下，把新猫「钉」在地上/墙上。 */
export function softShadow(base, { cx, cy, rx = 200, ry = 40, opacity = 0.45, blur = 18 } = {}) {
  const { width: w, height: h } = base;
  const shadow = {
    width: w,
    height: h,
    data: new Uint8ClampedArray(w * h * 4),
  };
  for (let y = Math.max(0, Math.floor(cy - ry * 2)); y < Math.min(h, cy + ry * 2); y += 1) {
    for (let x = Math.max(0, Math.floor(cx - rx * 2)); x < Math.min(w, cx + rx * 2); x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d <= 1) {
        const i = (y * w + x) * 4;
        shadow.data[i + 3] = Math.round(255 * (1 - d));
      }
    }
  }
  const soft = gaussianBlur(shadow, blur);
  return compositeOver(base, soft, 0, 0, opacity);
}

/** 屏幕混合的单色层（光效的底层算子）：1-(1-base)(1-glow)。 */
function screenLayer(base, glow) {
  const out = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
  const d = out.data;
  const g = glow.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = (g[i + 3] / 255) * (g[i] / 255);
    if (a <= 0) continue;
    for (let c = 0; c < 3; c += 1) {
      const b = d[i + c] / 255;
      const s = g[i] / 255;
      d[i + c] = Math.round((1 - (1 - b) * (1 - s)) * 255 * a + d[i + c] * (1 - a));
    }
  }
  return out;
}

/**
 * 径向光斑（背景光效）：以 (cx, cy) 为中心的一团柔光，screen 混合。
 * 让主体背后亮起来，主体轮廓立刻跳出来 —— 「炫」的主要来源。
 */
export function radialGlow(
  base,
  { cx, cy, radius = 400, color = [255, 220, 160], strength = 0.55, falloff = 2 },
) {
  const { width: w, height: h } = base;
  const glow = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  const g = glow.data;
  const [r, gg, b] = color;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h, Math.ceil(cy + radius));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const dist = Math.hypot(x - cx, y - cy) / radius;
      if (dist >= 1) continue;
      const v = Math.pow(1 - dist, falloff) * strength;
      const i = (y * w + x) * 4;
      g[i] = r;
      g[i + 1] = gg;
      g[i + 2] = b;
      g[i + 3] = Math.round(255 * Math.min(1, v));
    }
  }
  return screenLayer(base, glow);
}

/**
 * 自然光束：从某一条边斜打进来的一层暖光，screen 混合。
 * 与径向光斑的区别是方向性 —— 模拟窗光/日光从画面外射进来的感觉。
 */
export function lightBeam(
  base,
  { side = "top", extent = 0.75, color = [255, 214, 170], strength = 0.4, falloff = 1.6 } = {},
) {
  const { width: w, height: h } = base;
  const glow = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  const g = glow.data;
  const [r, gg, b] = color;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let t;
      if (side === "top") t = y / (h * extent);
      else if (side === "bottom") t = (h - 1 - y) / (h * extent);
      else if (side === "left") t = x / (w * extent);
      else t = (w - 1 - x) / (w * extent);
      if (t >= 1) continue;
      const v = Math.pow(1 - t, falloff) * strength;
      if (v <= 0) continue;
      const i = (y * w + x) * 4;
      g[i] = r;
      g[i + 1] = gg;
      g[i + 2] = b;
      g[i + 3] = Math.round(255 * Math.min(1, v));
    }
  }
  return screenLayer(base, glow);
}

/** 暗角：四角压暗（乘法），主体更聚焦。strength 0-1。 */
export function vignette(base, { strength = 0.35, extent = 0.75 } = {}) {
  const out = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
  const { width: w, height: h } = base;
  const cx = w / 2;
  const cy = h / 2;
  const maxD = Math.hypot(cx, cy) * extent;
  const d = out.data;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dist = Math.hypot(x - cx, y - cy) / maxD;
      if (dist <= 1) continue;
      const k = 1 - Math.min(strength, (dist - 1) * strength * 1.5);
      const i = (y * w + x) * 4;
      d[i] = Math.round(d[i] * k);
      d[i + 1] = Math.round(d[i + 1] * k);
      d[i + 2] = Math.round(d[i + 2] * k);
    }
  }
  return out;
}
