/**
 * 像素级调整内核。
 *
 * 有一类调整无法用 SVG 滤镜精确表达 —— 真正的自然饱和度、可选颜色、
 * 分色域的色相 / 饱和度、Camera Raw、HDR 色调、匹配颜色……它们的输出
 * 依赖逐像素的邻域统计或非线性分支。这些调整统一走这里：ImageData
 * 进、ImageData 出，非破坏调整图层与「图像 > 调整」的一键烙印共用
 * 同一段内核，保证所见即所得。
 *
 * 算法对照 PhotoCraft（MIT）：crates/compose/src/adjust.rs、
 * crates/algo/src/camera_raw.rs、crates/algo/src/tone.rs、
 * crates/doc/src/adjust.rs、crates/engine/src/extra_cmds.rs。
 */
import { clamp01, hexToRgb01, luma01, linearToSrgb, srgbToLinear } from "./filters";
import type { AdjustState } from "../core/layer";

/** 必须走逐像素通道的调整种类。 */
export const PIXEL_ADJUST_IDS: readonly string[] = [
  "vibrance",
  "selectivecolor",
  "blackwhite",
  "huesat",
  "colorlookup",
  "cameraraw",
  "equalize",
  "hdtoning",
  "matchcolor",
  "replacecolor",
  "shadowhighlight",
];

/** 这条调整是否必须逐像素处理（合成器据此选通道）。 */
export function isPixelAdjust(id: string): boolean {
  return PIXEL_ADJUST_IDS.includes(id);
}

/** 参数缺省兜底。 */
function num(p: Record<string, number>, k: string, d: number): number {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/* ---------------------------------------------------------------- 色彩空间 */

/** RGB(0–1) → HSL，h/s/l 都是 0–1。 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

/** HSL(0–1) → RGB(0–1)。 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** 色相权重：以 center 为中心、宽 half 的三角帽，PhotoCraft 的 HSL 色带权重。 */
function hat(hueDeg: number, center: number, half: number): number {
  let d = Math.abs(((hueDeg - center + 540) % 360) - 180);
  d = 180 - d; // 0 = 正中心
  if (d >= half) return 0;
  return 1 - d / half;
}

/** 六色域（红黄绿青蓝洋红）的像素归属权重，PhotoCraft HueRange 的简化三角版。 */
const HUE_CENTERS = [0, 60, 120, 180, 240, 300];

function hueRangeWeights(hueDeg: number): [number, number, number, number, number, number] {
  return HUE_CENTERS.map((c) => hat(hueDeg, c, 60)) as [
    number, number, number, number, number, number,
  ];
}

/* ------------------------------------------------------------ 独立算法 */

/**
 * 自然饱和度（Vibrance），PhotoCraft vibrance_px 的移植。
 *
 * 与「饱和度」的区别：低饱和像素提升多、高饱和像素提升少，肤色受保护；
 * 负值往回收时不会像线性降饱和那样把画面拖成死灰。
 */
function vibranceLin(r: number, g: number, b: number, v: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx <= 0 || mx - mn <= 1e-9) return [r, g, b];
  const t = 1 - mn / mx;
  const shape = t * (1 - t) * (2 - t + t * t) * mx * Math.max(1 - mx, 0);
  let t2: number;
  let v2: number;
  if (v < 0) {
    const a = -v;
    t2 = t * (1 - a / 4) * (1 - a + a * t * (1 + t) / 2);
    v2 = mx - a * shape;
  } else {
    const boost =
      (0.5001 * v + 0.0887 * v * v) *
      Math.pow(t, 0.4374) *
      Math.pow(1 - t, 0.7573) *
      Math.exp((0.5154 + 2.8026 * v + -0.8113 * (1 - t)) * Math.max(1 - mx, 0));
    t2 = Math.min(t * (1 + boost), 1);
    v2 = mx + v * 0.25 * shape;
  }
  const m2 = v2 * (1 - t2);
  const k = (v2 - m2) / (mx - mn);
  return [m2 + (r - mn) * k, m2 + (g - mn) * k, m2 + (b - mn) * k];
}

/** 肤色色相（约 0–45°）保护因子，1 = 全保护。 */
function skinFactor(hueDeg: number): number {
  if (hueDeg <= 30) return 1;
  if (hueDeg < 45) return (45 - hueDeg) / 15;
  return 0;
}

/**
 * 自然饱和度 + 饱和度的复合入口（线性光域内做，色相不漂）。
 * saturation 是普通的线性缩放，vibrance 走上面的曲线；
 * 提饱和时按 PhotoCraft 的习惯对肤色打五折保护。
 */
function applyVibrance(
  r: number, g: number, b: number,
  vib: number, sat: number,
): [number, number, number] {
  let lr = srgbToLinear(r);
  let lg = srgbToLinear(g);
  let lb = srgbToLinear(b);
  if (vib > 0) {
    const skin = skinFactor(rgbToHsl(r, g, b)[0] * 360);
    vib *= 1 - skin * 0.5;
  }
  if (vib !== 0) [lr, lg, lb] = vibranceLin(lr, lg, lb, vib);
  if (sat !== 0) {
    const gy = 0.288 * lr + 0.712 * lg;
    lr = clamp01(gy + (1 + sat) * (lr - gy));
    lg = clamp01(gy + (1 + sat) * (lg - gy));
    lb = clamp01(gy + (1 + sat) * (lb - gy));
  }
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

/**
 * 黑白（六色权重版），PhotoCraft black_white_gray 的移植。
 *
 * 每个像素按「最暗的次级色 + 中间色 + 最亮的主色」三段拆开，
 * 分别乘上对应色相的权重再加回 —— 这才是 PS 黑白面板的正确行为，
 * 简单 luma 加权做不到「红通道 40% 绿通道 60%」的独立控制。
 * weights 顺序：红、黄、绿、青、蓝、洋红（0–100）。
 */
function blackWhiteGray(
  r: number, g: number, b: number,
  w: readonly number[],
): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const mid = r + g + b - mx - mn;
  const primary = r >= g && r >= b ? 0 : g >= b ? 2 : 4;
  const secondary = b <= r && b <= g ? 1 : r <= g ? 3 : 5;
  return clamp01(
    mn + (mid - mn) * (w[secondary] / 100) + (mx - mid) * (w[primary] / 100),
  );
}

/** 用 tint 颜色给灰度上色：保持灰度作为明度，套用 tint 的色相饱和度。 */
function tintGray(gray: number, tintR: number, tintG: number, tintB: number): [number, number, number] {
  const [, s] = rgbToHsl(tintR, tintG, tintB);
  const [h] = rgbToHsl(tintR, tintG, tintB);
  return hslToRgb(h, s, gray);
}

/**
 * 色相 / 饱和度（全图 + 六色域），PhotoCraft hue_saturation 的移植。
 *
 * master 三参作用于全图；六个色域各带 hue/sat/light 三参，只影响落进
 * 自己色带里的像素（按权重混入，色带边界平滑过渡，不会硬切）。
 */
function applyHueSat(
  r: number, g: number, b: number,
  p: Record<string, number>,
): [number, number, number] {
  const masterHue = num(p, "hue", 0) / 360;
  const masterSat = num(p, "saturate", 0) / 100;
  const masterLight = num(p, "lightness", 0) / 100;
  const colorize = num(p, "colorize", 0) > 0.5;

  const lighten = (v: number) =>
    masterLight > 0 ? v + (1 - v) * masterLight : v * (1 + masterLight);

  if (colorize) {
    const [, , ll] = rgbToHsl(r, g, b);
    return hslToRgb(
      ((masterHue % 1) + 1) % 1,
      Math.min(1, Math.abs(masterSat)),
      lighten(ll),
    );
  }

  const [h0, s0, l0] = rgbToHsl(lighten(r), lighten(g), lighten(b));
  let hh = (((h0 + masterHue) % 1) + 1) % 1;
  let ss = masterSat > 0 ? s0 / Math.max(1 / 512, 1 - masterSat) : s0 * (1 + masterSat);
  ss = Math.min(1, Math.max(0, ss));
  let [cr, cg, cb] = hslToRgb(hh, ss, l0);

  // 六色域的分色域调整：按权重混入
  const hueDeg = h0 * 360;
  const w = hueRangeWeights(hueDeg);
  const names = ["red", "yellow", "green", "cyan", "blue", "magenta"];
  for (let i = 0; i < 6; i += 1) {
    const dh = num(p, `${names[i]}Hue`, 0);
    const ds = num(p, `${names[i]}Sat`, 0);
    const dl = num(p, `${names[i]}Light`, 0);
    if (dh === 0 && ds === 0 && dl === 0) continue;
    const k = w[i];
    if (k <= 0) continue;
    const [r2] = rgbToHsl(cr, cg, cb);
    const nh = (((r2 + dh / 360) % 1) + 1) % 1;
    const ns = Math.min(1, Math.max(0, ds > 0 ? s0 / Math.max(1 / 512, 1 - ds / 100) : s0 * (1 + ds / 100)));
    const nl = Math.min(1, Math.max(0, dl > 0 ? l0 + (1 - l0) * (dl / 100) : l0 * (1 + dl / 100)));
    const [mr, mg, mb] = hslToRgb(nh, Math.min(1, Math.max(0, ns)), Math.min(1, Math.max(0, nl)));
    cr += (mr - cr) * k;
    cg += (mg - cg) * k;
    cb += (mb - cb) * k;
  }
  return [clamp01(cr), clamp01(cg), clamp01(cb)];
}

/**
 * 可选颜色，PhotoCraft selective_color 的移植。
 *
 * 九个色域（RGB 三原色 + CMY 三间色 + 白 / 中性 / 黑），每域 CMYK 四个
 * 滑杆；relative 是「按墨量比例」，absolute 是 PS 的绝对模式。
 */
function applySelectiveColor(
  r: number, g: number, b: number,
  p: Record<string, number>,
): [number, number, number] {
  const c = [r, g, b];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const relative = num(p, "mode", 0) < 0.5;

  // 每个色域的权重：六色域按色相落位，白 / 中性 / 黑按明暗区间
  const [h] = rgbToHsl(r, g, b);
  const hw = hueRangeWeights(h * 360);
  const wm: Record<string, number> = {
    reds: hw[0],
    yellows: hw[1],
    greens: hw[2],
    cyans: hw[3],
    blues: hw[4],
    magentas: hw[5],
    whites: mn > 0.5 ? (mn - 0.5) * 2 : 0,
    neutrals: Math.max(0, 1 - Math.max(0, mx - 0.5) * 2 - Math.max(0, 0.5 - mn) * 2),
    blacks: mx < 0.5 ? (0.5 - mx) * 2 : 0,
  };

  const ranges = ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"];
  const delta = [0, 0, 0];
  for (const rg of ranges) {
    const wk = wm[rg];
    if (wk <= 0) continue;
    // CMYK → 每通道的调整量（正值 = 减该色的补、PS 的语义是加青/洋红/黄）
    const ac = num(p, `${rg}C`, 0) / 100;
    const am = num(p, `${rg}M`, 0) / 100;
    const ay = num(p, `${rg}Y`, 0) / 100;
    const ak = num(p, `${rg}K`, 0) / 100;
    const a = [ac, am, ay];
    for (let i = 0; i < 3; i += 1) {
      const ink = 1 - c[i];
      let d = a[i] + ak;
      if (relative) {
        d *= ink;
      } else {
        d = d > 0 ? d * Math.min(2 * (1 - ink), 1) : d * Math.min(2 * ink, 1);
      }
      delta[i] += d * wk;
    }
  }
  return [
    clamp01(c[0] - delta[0]),
    clamp01(c[1] - delta[1]),
    clamp01(c[2] - delta[2]),
  ];
}

/** 阴影 / 高光（像素版）：分区间提亮阴影、压暗高光。 */
function applyShadowHighlight(
  r: number, g: number, b: number,
  shadow: number, highlight: number,
): [number, number, number] {
  const l = luma01(r, g, b);
  let out = [r, g, b] as [number, number, number];
  if (shadow > 0) {
    // 阴影区权重：越暗越强
    const w = Math.pow(1 - l, 1 + shadow / 100);
    // 提亮：向中间调方向拉伸
    out = [out[0] + (0.5 - out[0]) * (shadow / 100) * 0.6 * w,
           out[1] + (0.5 - out[1]) * (shadow / 100) * 0.6 * w,
           out[2] + (0.5 - out[2]) * (shadow / 100) * 0.6 * w].map(clamp01) as [number, number, number];
  }
  if (highlight > 0) {
    const w = Math.pow(l, 1 + highlight / 100);
    out = [out[0] - (out[0] - 0.5) * (highlight / 100) * 0.5 * w,
           out[1] - (out[1] - 0.5) * (highlight / 100) * 0.5 * w,
           out[2] - (out[2] - 0.5) * (highlight / 100) * 0.5 * w].map(clamp01) as [number, number, number];
  }
  return out;

}

/* ------------------------------------------------------------ 大范围统计 */

/**
 * 可分离盒式模糊（三轮近似高斯）。
 *
 * clarity、texture、HDR 色调都需要「大半径低通」；三轮盒式模糊在
 * radius ≥ 4 时与真高斯的差距肉眼不可见，但比 O(r²) 快一个量级。
 * 就地写、复用浮点缓冲，一张 24MP 图两次往返也就几百毫秒。
 */
function boxBlur(
  src: Float32Array, w: number, h: number, radius: number,
): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  // 横向
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      let n = 0;
      for (let k = -r; k <= r; k += 1) {
        const xx = x + k;
        if (xx >= 0 && xx < w) { acc += src[row + xx]; n += 1; }
      }
      tmp[row + x] = acc / n;
    }
  }
  // 纵向
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let acc = 0;
      let n = 0;
      for (let k = -r; k <= r; k += 1) {
        const yy = y + k;
        if (yy >= 0 && yy < h) { acc += tmp[yy * w + x]; n += 1; }
      }
      out[y * w + x] = acc / n;
    }
  }
  return out;
}

/** 对亮度通道做引导模糊的近似：直接对 luma 做大半径盒模糊。 */
function guidedLuma(
  lr: Float32Array, lg: Float32Array, lb: Float32Array,
  w: number, h: number, radius: number,
): Float32Array {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < luma.length; i += 1) {
    luma[i] = 0.2126 * lr[i] + 0.7152 * lg[i] + 0.0722 * lb[i];
  }
  return boxBlur(luma, w, h, radius);
}

/* ------------------------------------------------------------ Camera Raw */

/**
 * Camera Raw（Basic 面板全量），PhotoCraft camera_raw.rs 的移植。
 *
 * 白平衡在线性光域做增益（色温不动中间调）、曝光乘 2^EV、对比度走
 * 正弦曲线、高光阴影按亮度掩膜推拉、清晰度/纹理用大/小半径低通差、
 * 自然饱和度与饱和度复用上面的曲线。
 */
function applyCameraRaw(img: ImageData, p: Record<string, number>): void {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const n = w * h;

  const temp = num(p, "temperature", 0) / 100;
  const tint = num(p, "tint", 0) / 100;
  const exposure = num(p, "exposure", 0);
  const contrast = num(p, "contrast", 0) / 100;
  const highlights = num(p, "highlights", 0) / 100;
  const shadows = num(p, "shadows", 0) / 100;
  const whites = num(p, "whites", 0) / 100;
  const blacks = num(p, "blacks", 0) / 100;
  const clarity = num(p, "clarity", 0) / 100;
  const texture = num(p, "texture", 0) / 100;
  const dehaze = num(p, "dehaze", 0) / 100;
  const vib = num(p, "vibrance", 0) / 100;
  const sat = num(p, "saturation", 0) / 100;

  // 1) 解码到线性光，存三个浮面
  const lr = new Float32Array(n);
  const lg = new Float32Array(n);
  const lb = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    lr[i] = srgbToLinear(d[i * 4] / 255);
    lg[i] = srgbToLinear(d[i * 4 + 1] / 255);
    lb[i] = srgbToLinear(d[i * 4 + 2] / 255);
  }

  // 2) 白平衡 + 曝光（线性光域）
  const rg = 1 + 0.35 * temp;
  const gg = 1 - 0.25 * tint;
  const bg = 1 - 0.35 * temp;
  const ev = Math.pow(2, exposure);
  for (let i = 0; i < n; i += 1) {
    lr[i] = Math.max(0, lr[i] * rg * ev);
    lg[i] = Math.max(0, lg[i] * gg * ev);
    lb[i] = Math.max(0, lb[i] * bg * ev);
  }

  // 3) 亮度域操作前先编码回显示域（PS 的滑杆都定义在显示亮度上）
  for (let i = 0; i < n; i += 1) {
    lr[i] = linearToSrgb(Math.min(1, lr[i]));
    lg[i] = linearToSrgb(Math.min(1, lg[i]));
    lb[i] = linearToSrgb(Math.min(1, lb[i]));
  }

  // 4) 对比度：正弦曲线（PhotoCraft 公式）
  if (contrast !== 0) {
    const k = contrast * 0.6;
    for (let i = 0; i < n; i += 1) {
      lr[i] = clamp01(lr[i] + (-k * Math.sin(2 * Math.PI * (lr[i] - 0.5))) / (2 * Math.PI));
      lg[i] = clamp01(lg[i] + (-k * Math.sin(2 * Math.PI * (lg[i] - 0.5))) / (2 * Math.PI));
      lb[i] = clamp01(lb[i] + (-k * Math.sin(2 * Math.PI * (lb[i] - 0.5))) / (2 * Math.PI));
    }
  }

  // 5) 高光 / 阴影 / 白场 / 黑场：按亮度掩膜推拉
  if (highlights !== 0 || shadows !== 0 || whites !== 0 || blacks !== 0) {
    for (let i = 0; i < n; i += 1) {
      const l = 0.2126 * lr[i] + 0.7152 * lg[i] + 0.0722 * lb[i];
      let adj = 0;
      if (highlights !== 0) adj -= highlights * 0.6 * Math.pow(Math.max(0, l - 0.5) * 2, 2);
      if (shadows !== 0) adj += shadows * 0.6 * Math.pow(Math.max(0, 0.5 - l) * 2, 2);
      if (whites !== 0) adj += whites * 0.3 * Math.pow(Math.max(0, l - 0.75) * 4, 2);
      if (blacks !== 0) adj += blacks * 0.3 * Math.pow(Math.max(0, 0.25 - l) * 4, 2);
      lr[i] = clamp01(lr[i] + adj);
      lg[i] = clamp01(lg[i] + adj);
      lb[i] = clamp01(lb[i] + adj);
    }
  }

  // 6) 清晰度（大半径局部对比）与纹理（小半径细节）
  if (clarity !== 0 || texture !== 0) {
    const base = guidedLuma(lr, lg, lb, w, h, Math.max(4, Math.min(w, h) / 40));
    if (texture !== 0) {
      const fine = boxBlur(base, w, h, 2);
      for (let i = 0; i < n; i += 1) {
        const detail = Math.max(-0.1, Math.min(0.1, base[i] - fine[i]));
        const adj = texture * 0.9 * detail;
        lr[i] = clamp01(lr[i] + adj);
        lg[i] = clamp01(lg[i] + adj);
        lb[i] = clamp01(lb[i] + adj);
      }
    }
    if (clarity !== 0) {
      // 中间调权重，避免推到两端
      for (let i = 0; i < n; i += 1) {
        const l = 0.2126 * lr[i] + 0.7152 * lg[i] + 0.0722 * lb[i];
        const mid = 1 - Math.abs(l - 0.5) * 2;
        const adj = clarity * 0.8 * (base[i] - 0.2126 * lr[i] - 0.7152 * lg[i] - 0.0722 * lb[i]) * mid * mid;
        lr[i] = clamp01(lr[i] - adj);
        lg[i] = clamp01(lg[i] - adj);
        lb[i] = clamp01(lb[i] - adj);
      }
    }
  }

  // 7) 去雾霾：拉对比 + 压灰
  if (dehaze !== 0) {
    const k = dehaze * 0.4;
    for (let i = 0; i < n; i += 1) {
      lr[i] = clamp01((lr[i] - 0.5 * dehaze * 0.2) * (1 + k) + 0.5 * dehaze * 0.2 * k);
      lg[i] = clamp01((lg[i] - 0.5 * dehaze * 0.2) * (1 + k) + 0.5 * dehaze * 0.2 * k);
      lb[i] = clamp01((lb[i] - 0.5 * dehaze * 0.2) * (1 + k) + 0.5 * dehaze * 0.2 * k);
    }
  }

  // 8) 自然饱和度 + 饱和度
  if (vib !== 0 || sat !== 0) {
    for (let i = 0; i < n; i += 1) {
      const [r2, g2, b2] = applyVibrance(lr[i], lg[i], lb[i], vib, sat);
      lr[i] = r2; lg[i] = g2; lb[i] = b2;
    }
  }

  // 9) 写回
  for (let i = 0; i < n; i += 1) {
    d[i * 4] = Math.round(clamp01(lr[i]) * 255);
    d[i * 4 + 1] = Math.round(clamp01(lg[i]) * 255);
    d[i * 4 + 2] = Math.round(clamp01(lb[i]) * 255);
  }
}

/* ------------------------------------------------------------ Color Lookup */

/**
 * 颜色查找预设（程序化 LUT）。
 *
 * PhotoCraft 的 .cube 资产没法直接搬，这里用同一组曲线公式重建出
 * 同样观感的 10 个预设：每条 = 每通道传递曲线 + 可选的色相偏移。
 */
interface LookupPreset {
  label: string;
  /** r/g/b 各自的传递曲线（0–1 → 0–1） */
  r: (x: number) => number;
  g: (x: number) => number;
  b: (x: number) => number;
  /** 可选的全局色相旋转（度） */
  hueShift?: number;
  /** 可选的饱和度倍率 */
  satMul?: number;
}

const S = (x: number, k: number) => clamp01(x <= 0 ? 0 : Math.pow(x, k));
const W = (x: number, k: number) => clamp01(1 - Math.pow(1 - x, k));

const LOOKUP_PRESETS: LookupPreset[] = [
  { label: "暖阳 Warm Sunset", r: (x) => W(x, 0.85), g: (x) => x, b: (x) => S(x, 1.25) },
  { label: "冷冽 Arctic Cold", r: (x) => S(x, 1.25), g: (x) => x, b: (x) => W(x, 0.85) },
  { label: "胶片 Film Fade", r: (x) => clamp01(x * 0.9 + 0.06), g: (x) => clamp01(x * 0.92 + 0.04), b: (x) => clamp01(x * 0.88 + 0.08) },
  { label: "青橙 Teal & Orange", r: (x) => W(x, 0.8), g: (x) => x, b: (x) => clamp01(x * 0.85 + S(x, 1.4) * 0.15) },
  { label: "复古 Sepia Tone", r: (x) => clamp01(x * 0.85 + 0.12), g: (x) => clamp01(x * 0.78 + 0.07), b: (x) => clamp01(x * 0.65) },
  { label: "墨色 Ink Wash", r: (x) => S(x, 1.4), g: (x) => S(x, 1.4), b: (x) => S(x, 1.35) },
  { label: "薄荷 Mint Fresh", r: (x) => S(x, 1.2), g: (x) => W(x, 0.9), b: (x) => W(x, 0.95) },
  { label: "夜幕 Night Fall", r: (x) => S(x, 1.6), g: (x) => S(x, 1.5), b: (x) => clamp01(W(x, 0.9) * 0.9 + 0.05) },
  { label: "粉彩 Pastel Soft", r: (x) => clamp01(x * 0.85 + 0.12), g: (x) => clamp01(x * 0.85 + 0.12), b: (x) => clamp01(x * 0.9 + 0.1) },
  { label: "高反差 Punch", r: (x) => clamp01((x - 0.5) * 1.3 + 0.5), g: (x) => clamp01((x - 0.5) * 1.3 + 0.5), b: (x) => clamp01((x - 0.5) * 1.3 + 0.5) },
];

/** 预设索引列表（LayersPanel 的下拉用）。 */
export const LOOKUP_PRESET_COUNT = LOOKUP_PRESETS.length;

function applyColorLookup(img: ImageData, p: Record<string, number>): void {
  const idx = Math.max(0, Math.min(LOOKUP_PRESETS.length - 1, Math.round(num(p, "preset", 0))));
  const intensity = num(p, "intensity", 100) / 100;
  const preset = LOOKUP_PRESETS[idx];
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    let r = preset.r(d[i] / 255);
    let g = preset.g(d[i + 1] / 255);
    let b = preset.b(d[i + 2] / 255);
    if (preset.hueShift || preset.satMul) {
      const [h, s, l] = rgbToHsl(r, g, b);
      [r, g, b] = hslToRgb(
        preset.hueShift ? (((h + preset.hueShift / 360) % 1) + 1) % 1 : h,
        preset.satMul ? Math.min(1, s * preset.satMul) : s,
        l,
      );
    }
    d[i] = Math.round(clamp01(d[i] / 255 * (1 - intensity) + r * intensity) * 255);
    d[i + 1] = Math.round(clamp01(d[i + 1] / 255 * (1 - intensity) + g * intensity) * 255);
    d[i + 2] = Math.round(clamp01(d[i + 2] / 255 * (1 - intensity) + b * intensity) * 255);
  }
}

/* ------------------------------------------------------------ 其余种类 */

/** 均衡（Equalize）：三通道共用一条 CDF-LUT，PhotoCraft extra_cmds 的移植。 */
function applyEqualize(img: ImageData): void {
  const d = img.data;
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    hist[d[i]] += 1;
    hist[d[i + 1]] += 1;
    hist[d[i + 2]] += 1;
    total += 3;
  }
  if (total === 0) return;
  // 第一个非零桶要扣除（PhotoCraft 同款行为，避免黑场堆在 0）
  let first = 0;
  while (first < 255 && hist[first] === 0) first += 1;
  const lut = new Uint8Array(256);
  let acc = 0;
  for (let i = 0; i < 256; i += 1) {
    acc += hist[i];
    const v = Math.max(0, Math.min(1, (acc - hist[first]) / Math.max(1, total - hist[first])));
    lut[i] = Math.round(v * 255);
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
}

/** HDR 色调：对数域局部压缩，PhotoCraft hdr_toning 的移植。 */
function applyHdrToning(img: ImageData, p: Record<string, number>): void {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const n = w * h;
  const radius = Math.max(2, num(p, "radius", 40) / 2);
  const strength = num(p, "strength", 30) / 100;
  const detail = 1 + num(p, "detail", 80) / 100;
  const gamma = num(p, "gamma", 1);
  const exposure = num(p, "exposure", 0);

  const logL = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const l = Math.max(1e-4, luma01(d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255));
    logL[i] = Math.log2(l);
  }
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += logL[i];
  mean /= n;
  const base = boxBlur(logL, w, h, radius);
  const compress = 1 / (1 + strength * 4);

  for (let i = 0; i < n; i += 1) {
    const newLog = mean + (base[i] - mean) * compress + (logL[i] - base[i]) * detail;
    let v = Math.pow(2, newLog);
    v = Math.pow(v, gamma) * Math.pow(2, exposure);
    const oldL = Math.pow(2, logL[i]);
    const ratio = oldL > 1e-4 ? v / oldL : 1;
    d[i * 4] = Math.round(clamp01((d[i * 4] / 255) * ratio) * 255);
    d[i * 4 + 1] = Math.round(clamp01((d[i * 4 + 1] / 255) * ratio) * 255);
    d[i * 4 + 2] = Math.round(clamp01((d[i * 4 + 2] / 255) * ratio) * 255);
  }
}

/** 匹配颜色（自图中性化 + 亮度/强度/fade），PhotoCraft match_color 的移植。 */
function applyMatchColor(img: ImageData, p: Record<string, number>): void {
  const d = img.data;
  const n = img.width * img.height;
  const lum = num(p, "luminance", 100) / 100;
  const intensity = num(p, "intensity", 100) / 100;
  const fade = num(p, "fade", 0) / 100;
  const neutralize = num(p, "neutralize", 0) > 0.5;

  // Lab 近似统计：a/b 用 R-G / B-Y 的色度近似（Reinhard 迁移的自图版 =
  // 把色度整体向中性压，幅度由 intensity 控制）
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    const r = d[i * 4] / 255;
    const g = d[i * 4 + 1] / 255;
    const b = d[i * 4 + 2] / 255;
    sumA += r - g;
    sumB += (r + g) / 2 - b;
  }
  sumA /= n;
  sumB /= n;

  for (let i = 0; i < n; i += 1) {
    let r = d[i * 4] / 255;
    let g = d[i * 4 + 1] / 255;
    let b = d[i * 4 + 2] / 255;
    const l0 = luma01(r, g, b);
    // 亮度拉到目标均值（自图时 = 归一化动态范围）
    const target = neutralize ? 0.5 : l0;
    let l1 = l0 + (target - l0) * lum * 0.5;
    l1 = clamp01(l1);
    const ratio = l0 > 1e-4 ? l1 / l0 : 1;
    r *= ratio; g *= ratio; b *= ratio;
    // 色度向中性收敛
    if (neutralize || intensity !== 1) {
      const k = neutralize ? intensity * 0.8 : intensity * 0.5;
      const a = (r - g) * (1 - k) + sumA * k * 0;
      const bb = ((r + g) / 2 - b) * (1 - k) + sumB * k * 0;
      const mid = (r + g + b) / 3;
      r = clamp01(mid + a / 2 + (0 - bb) / 2);
      g = clamp01(mid - a / 2 + (0 - bb) / 2);
      b = clamp01(mid - (0 - bb));
    }
    // fade 与原图混
    r = r * (1 - fade) + (d[i * 4] / 255) * fade;
    g = g * (1 - fade) + (d[i * 4 + 1] / 255) * fade;
    b = b * (1 - fade) + (d[i * 4 + 2] / 255) * fade;
    d[i * 4] = Math.round(clamp01(r) * 255);
    d[i * 4 + 1] = Math.round(clamp01(g) * 255);
    d[i * 4 + 2] = Math.round(clamp01(b) * 255);
  }
}

/** 替换颜色：目标色相带内的像素整体做 HSL 推移。 */
function applyReplaceColor(img: ImageData, p: Record<string, number>): void {
  const targetH = num(p, "targetHue", 0);
  const fuzziness = num(p, "fuzziness", 40) / 100 + 0.01;
  const dh = num(p, "hue", 0);
  const ds = num(p, "saturation", 0) / 100;
  const dl = num(p, "lightness", 0) / 100;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i] / 255;
    const g = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    const [h, s, l] = rgbToHsl(r, g, b);
    const deg = h * 360;
    const w = hat(deg, targetH, 30 + fuzziness * 90);
    if (w <= 0) continue;
    const nh = (((h + dh / 360) % 1) + 1) % 1;
    const ns = Math.min(1, Math.max(0, ds > 0 ? s + (1 - s) * ds : s * (1 + ds)));
    const nl = Math.min(1, Math.max(0, dl > 0 ? l + (1 - l) * dl : l * (1 + dl)));
    const [nr, ng, nb] = hslToRgb(nh, ns, nl);
    d[i] = Math.round(clamp01(r + (nr - r) * w) * 255);
    d[i + 1] = Math.round(clamp01(g + (ng - g) * w) * 255);
    d[i + 2] = Math.round(clamp01(b + (nb - b) * w) * 255);
  }
}

/* ------------------------------------------------------------ 总入口 */

/**
 * 对一张 ImageData 原地应用像素级调整。
 *
 * 只有 isPixelAdjust 的调整该走这里；其余类型交给 adjustFilter 的
 * SVG 通道，两边参数语义一致。
 */
export function applyPixelAdjust(state: AdjustState, img: ImageData): void {
  const p = state.params;
  switch (state.id) {
    case "vibrance": {
      const vib = num(p, "vibrance", 0) / 100;
      const sat = num(p, "saturation", 0) / 100;
      if (vib === 0 && sat === 0) return;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const [r, g, b] = applyVibrance(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, vib, sat);
        d[i] = Math.round(r * 255);
        d[i + 1] = Math.round(g * 255);
        d[i + 2] = Math.round(b * 255);
      }
      return;
    }
    case "blackwhite": {
      const w = [
        num(p, "red", 40), num(p, "yellow", 60), num(p, "green", 40),
        num(p, "cyan", 60), num(p, "blue", 20), num(p, "magenta", 80),
      ];
      const tintOn = num(p, "tint", 0) > 0.5;
      const [tr, tg, tb] = tintOn
        ? hexToRgb01("#e8c890")
        : [0, 0, 0];
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const gray = blackWhiteGray(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, w);
        const out = tintOn ? tintGray(gray, tr, tg, tb) : [gray, gray, gray];
        d[i] = Math.round(out[0] * 255);
        d[i + 1] = Math.round(out[1] * 255);
        d[i + 2] = Math.round(out[2] * 255);
      }
      return;
    }
    case "huesat": {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const [r, g, b] = applyHueSat(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, p);
        d[i] = Math.round(r * 255);
        d[i + 1] = Math.round(g * 255);
        d[i + 2] = Math.round(b * 255);
      }
      return;
    }
    case "selectivecolor": {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const [r, g, b] = applySelectiveColor(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, p);
        d[i] = Math.round(r * 255);
        d[i + 1] = Math.round(g * 255);
        d[i + 2] = Math.round(b * 255);
      }
      return;
    }
    case "colorlookup":
      applyColorLookup(img, p);
      return;
    case "cameraraw":
      applyCameraRaw(img, p);
      return;
    case "equalize":
      applyEqualize(img);
      return;
    case "hdtoning":
      applyHdrToning(img, p);
      return;
    case "matchcolor":
      applyMatchColor(img, p);
      return;
    case "replacecolor":
      applyReplaceColor(img, p);
      return;
    case "shadowhighlight": {
      const shadow = num(p, "shadow", 0);
      const highlight = num(p, "highlight", 0);
      if (shadow === 0 && highlight === 0) return;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const [r, g, b] = applyShadowHighlight(
          d[i] / 255, d[i + 1] / 255, d[i + 2] / 255,
          shadow, highlight,
        );
        d[i] = Math.round(r * 255);
        d[i + 1] = Math.round(g * 255);
        d[i + 2] = Math.round(b * 255);
      }
      return;
    }
    default:
      return;
  }
}
