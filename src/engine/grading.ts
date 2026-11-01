/**
 * 调色台内核（对齐达芬奇 Resolve 的 Color 页思路）。
 *
 * 一次调用把「一级校色 + 四个色轮 + 色彩切片器 + 曲线」全算完，输出新像素：
 *
 *   ① 一级校色：色温 / 色调 / 对比度 / 轴心 / Lift·Gamma·Gain（分通道）
 *   ② 色轮：Dark / Shadow / Light / Global —— 按亮度分档叠加色偏、曝光、饱和
 *   ③ 色彩切片器：按色相区间（红 / 皮肤 / 黄 / 绿 / 青 / 蓝 / 品红）分别调
 *   ④ 曲线：RGB 复合 + 分通道（控制点由调用方传入，与「曲线」调整层同源）
 *
 * 前四项里凡是「只跟单个像素自己的值有关」的部分（白平衡、LGG、对比度、
 * 曲线）预先烘成三张 256 项 LUT，逐像素只查表；只有需要亮度 / 色相上下文的
 * 部分（阴影高光、色轮、切片器、全局饱和）走逐像素分支。
 *
 * 全部是纯函数：RGB 字节数组进、出，不碰 DOM —— 界面、导出、MCP 共用一份。
 */
import { makeBuffer, type RgbaBuffer } from "./filters/kernels";

/* ------------------------------------------------------------ 参数定义 */

export interface GradeParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  dec?: number;
  unit?: string;
  group: string;
}

const P = (
  id: string,
  label: string,
  group: string,
  min: number,
  max: number,
  def = 0,
  step = 1,
  unit = "",
): GradeParamDef => ({ id, label, min, max, step, def, unit, group });

/** 切片器的七个色域（色相中心按度给出，与 Resolve 的切分一致）。 */
export const SLICER_RANGES: { key: string; label: string; center: number }[] = [
  { key: "red", label: "红色", center: 0 },
  { key: "skin", label: "皮肤", center: 25 },
  { key: "yellow", label: "黄色", center: 60 },
  { key: "green", label: "绿色", center: 120 },
  { key: "cyan", label: "青色", center: 180 },
  { key: "blue", label: "蓝色", center: 240 },
  { key: "magenta", label: "品红", center: 300 },
];

/** 色轮四档。 */
export const GRADE_WHEELS: { key: string; label: string }[] = [
  { key: "dark", label: "暗部 Dark" },
  { key: "shad", label: "阴影 Shadow" },
  { key: "light", label: "亮部 Light" },
  { key: "glob", label: "全局 Global" },
];

/** 调色台的全部参数（数值型，直接进调整层的 params）。 */
export const GRADE_PARAMS: GradeParamDef[] = [
  /* 一级校色 */
  P("temp", "色温", "一级 · 白平衡", -100, 100, 0, 1),
  P("tint", "色调", "一级 · 白平衡", -100, 100, 0, 1),
  P("contrast", "对比度", "一级 · 色调", -100, 100, 0, 1),
  P("pivot", "轴心", "一级 · 色调", 0, 100, 50, 1),
  P("midDetail", "中间调对比", "一级 · 色调", -100, 100, 0, 1),
  P("liftR", "暗部 R", "一级 · 暗部 Lift", -100, 100, 0, 1),
  P("liftG", "暗部 G", "一级 · 暗部 Lift", -100, 100, 0, 1),
  P("liftB", "暗部 B", "一级 · 暗部 Lift", -100, 100, 0, 1),
  P("gammaR", "中间调 R", "一级 · 中间调 Gamma", -100, 100, 0, 1),
  P("gammaG", "中间调 G", "一级 · 中间调 Gamma", -100, 100, 0, 1),
  P("gammaB", "中间调 B", "一级 · 中间调 Gamma", -100, 100, 0, 1),
  P("gainR", "亮部 R", "一级 · 亮部 Gain", -100, 100, 0, 1),
  P("gainG", "亮部 G", "一级 · 亮部 Gain", -100, 100, 0, 1),
  P("gainB", "亮部 B", "一级 · 亮部 Gain", -100, 100, 0, 1),
  P("shadow", "阴影", "一级 · 整体", -100, 100, 0, 1),
  P("highlight", "高光", "一级 · 整体", -100, 100, 0, 1),
  P("sat", "饱和度", "一级 · 整体", -100, 100, 0, 1),
  P("hue", "色相", "一级 · 整体", -180, 180, 0, 1, "°"),
  P("blackOffset", "黑场偏移", "一级 · 整体", -100, 100, 0, 1),
  /* 色轮 */
  ...GRADE_WHEELS.flatMap((w) => [
    P(`${w.key}X`, "色相 X", `色轮 · ${w.label}`, -100, 100, 0, 1),
    P(`${w.key}Y`, "色相 Y", `色轮 · ${w.label}`, -100, 100, 0, 1),
    P(`${w.key}Exp`, "曝光", `色轮 · ${w.label}`, -100, 100, 0, 1),
    P(`${w.key}Sat`, "饱和", `色轮 · ${w.label}`, -100, 100, 0, 1),
  ]),
  /* 色彩切片器 */
  ...SLICER_RANGES.flatMap((r) => [
    P(`sl_${r.key}_hue`, `${r.label} · 色相`, `切片器 · ${r.label}`, -60, 60, 0, 1, "°"),
    P(`sl_${r.key}_sat`, `${r.label} · 饱和`, `切片器 · ${r.label}`, -100, 100, 0, 1),
    P(`sl_${r.key}_lum`, `${r.label} · 亮度`, `切片器 · ${r.label}`, -100, 100, 0, 1),
  ]),
];

/** 中性参数表（全 0，轴心 50）。 */
export function neutralGrade(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of GRADE_PARAMS) out[d.id] = d.def;
  return out;
}

/** 参数是否完全中性（中性就不必跑整趟算子）。 */
export function gradeIsNeutral(p: Record<string, number>): boolean {
  for (const d of GRADE_PARAMS) {
    const v = p[d.id] ?? d.def;
    if (Math.abs(v - d.def) > 1e-6) return false;
  }
  return true;
}

/* -------------------------------------------------------------- 工具 */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lumaOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

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

/** 曲线求值：单调三次插值（与曲线调整层共用同一条算法，见 engine/filters）。 */
export type CurvePts = readonly { x: number; y: number }[];

/** 把控制点烘成 256 项查表。 */
export function curveToTable(pts: CurvePts | undefined): Float32Array {
  const t = new Float32Array(256);
  if (!pts || pts.length < 2) {
    for (let i = 0; i < 256; i += 1) t[i] = i / 255;
    return t;
  }
  for (let i = 0; i < 256; i += 1) t[i] = clamp01(monotoneAt(pts, i / 255));
  return t;
}

/** 单调三次 Hermite 求值（与 engine/filters.ts 的 monotoneAt 同一算法）。 */
function monotoneAt(points: CurvePts, x: number): number {
  const n = points.length;
  if (n === 0) return x;
  if (n === 1) return points[0].y;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[n - 1].x) return points[n - 1].y;
  const m: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    const dx = next.x - prev.x;
    m[i] = dx > 1e-9 ? (next.y - prev.y) / dx : 0;
  }
  let k = 0;
  while (k < n - 2 && x > points[k + 1].x) k += 1;
  const h = points[k + 1].x - points[k].x;
  if (h <= 1e-9) return points[k].y;
  const t = (x - points[k].x) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * points[k].y +
    (t3 - 2 * t2 + t) * h * m[k] +
    (-2 * t3 + 3 * t2) * points[k + 1].y +
    (t3 - t2) * h * m[k + 1]
  );
}

/* ------------------------------------------------------------ 主算子 */

export interface GradeCurves {
  rgb?: CurvePts;
  r?: CurvePts;
  g?: CurvePts;
  b?: CurvePts;
}

/** 四个色轮合成出的「按亮度分档」的 RGB 偏移。 */
interface WheelBank {
  dark: [number, number, number];
  shad: [number, number, number];
  light: [number, number, number];
  glob: [number, number, number];
  darkSat: number;
  shadSat: number;
  lightSat: number;
  globSat: number;
  darkExp: number;
  shadExp: number;
  lightExp: number;
  globExp: number;
}

/** 色轮坐标 (x,y ∈ -1..1) → RGB 偏移。向量方向即色相，长度即强度。 */
function wheelVector(x: number, y: number): [number, number, number] {
  const len = Math.hypot(x, y);
  if (len < 1e-6) return [0, 0, 0];
  // 屏幕坐标：右 = 红 0°，上 = 黄绿；色相角按 12 点钟为红顺时针排
  const hue = ((Math.atan2(x, -y) / (Math.PI * 2)) % 1 + 1) % 1;
  const [r, g, b] = hslToRgb(hue, 1, 0.5);
  const amp = Math.min(1, len) * 0.28;
  // 三个通道各自相对中性灰的偏移，合成后总和为 0（只偏色不改亮度）
  return [(r - 1 / 3) * amp * 3, (g - 1 / 3) * amp * 3, (b - 1 / 3) * amp * 3];
}

/**
 * 施加整台调色。
 *
 * @param src 源像素
 * @param p   参数表（缺项按中性处理）
 * @param curves 曲线（可选，与曲线调整层的控制点同构）
 */
export function applyGrade(
  src: RgbaBuffer,
  p: Record<string, number>,
  curves?: GradeCurves,
): RgbaBuffer {
  const out = makeBuffer(src.width, src.height);
  const d = src.data;
  const o = out.data;

  const num = (k: string, def = 0): number => {
    const v = p[k];
    return typeof v === "number" && Number.isFinite(v) ? v : def;
  };

  /* ---- ① 三张 256 项 LUT：白平衡 + LGG + 对比度 + 曲线 ---- */
  const pivot = clamp01(num("pivot", 50) / 100);
  const contrast = 1 + (num("contrast") / 100) * 0.9;
  const temp = num("temp") / 100;
  const tint = num("tint") / 100;
  const chGain: [number, number, number] = [
    1 + temp * 0.25 + tint * 0.05,
    1 - tint * 0.16,
    1 - temp * 0.25 + tint * 0.05,
  ];
  const lift: [number, number, number] = [
    (num("liftR") / 100) * 0.5,
    (num("liftG") / 100) * 0.5,
    (num("liftB") / 100) * 0.5,
  ];
  const gain: [number, number, number] = [
    1 + num("gainR") / 100,
    1 + num("gainG") / 100,
    1 + num("gainB") / 100,
  ];
  const gammaExp: [number, number, number] = [
    1 / Math.max(0.05, 1 + (num("gammaR") / 100) * 0.9),
    1 / Math.max(0.05, 1 + (num("gammaG") / 100) * 0.9),
    1 / Math.max(0.05, 1 + (num("gammaB") / 100) * 0.9),
  ];
  const master = curveToTable(curves?.rgb);
  const lutR = curveToTable(curves?.r);
  const lutG = curveToTable(curves?.g);
  const lutB = curveToTable(curves?.b);

  const buildLut = (c: 0 | 1 | 2): Uint8ClampedArray => {
    const t = new Uint8ClampedArray(256);
    const perCh = c === 0 ? lutR : c === 1 ? lutG : lutB;
    for (let i = 0; i < 256; i += 1) {
      let v = i / 255;
      v *= gain[c]; // 亮部
      v = lift[c] + v * (1 - lift[c]); // 暗部抬底
      v = Math.pow(clamp01(v), gammaExp[c]); // 中间调
      v *= chGain[c]; // 白平衡
      v = (v - pivot) * contrast + pivot; // 对比度（绕轴心）
      v = clamp01(v);
      // 复合曲线 → 分通道曲线
      v = master[Math.round(v * 255)];
      v = perCh[Math.round(clamp01(v) * 255)];
      t[i] = Math.round(clamp01(v) * 255);
    }
    return t;
  };
  const rLut = buildLut(0);
  const gLut = buildLut(1);
  const bLut = buildLut(2);

  /* ---- ② 色轮 / 切片器 / 整体的逐像素系数 ---- */
  const wheels: WheelBank = {
    dark: wheelVector(num("darkX") / 100, num("darkY") / 100),
    shad: wheelVector(num("shadX") / 100, num("shadY") / 100),
    light: wheelVector(num("lightX") / 100, num("lightY") / 100),
    glob: wheelVector(num("globX") / 100, num("globY") / 100),
    darkSat: num("darkSat") / 100,
    shadSat: num("shadSat") / 100,
    lightSat: num("lightSat") / 100,
    globSat: num("globSat") / 100,
    darkExp: num("darkExp") / 100,
    shadExp: num("shadExp") / 100,
    lightExp: num("lightExp") / 100,
    globExp: num("globExp") / 100,
  };
  const shadow = num("shadow") / 100;
  const highlight = num("highlight") / 100;
  const midDetail = num("midDetail") / 100;
  const blackOffset = (num("blackOffset") / 100) * 0.12;
  const globalSat = num("sat") / 100;
  const globalHue = num("hue") / 360;

  const slicers = SLICER_RANGES.map((r) => ({
    center: r.center / 360,
    hue: num(`sl_${r.key}_hue`) / 360,
    sat: num(`sl_${r.key}_sat`) / 100,
    lum: num(`sl_${r.key}_lum`) / 100,
  })).filter((s) => s.hue !== 0 || s.sat !== 0 || s.lum !== 0);

  const anyWheel =
    wheels.dark.some((v) => v !== 0) ||
    wheels.shad.some((v) => v !== 0) ||
    wheels.light.some((v) => v !== 0) ||
    wheels.glob.some((v) => v !== 0);
  const anyWheelSat =
    wheels.darkSat !== 0 || wheels.shadSat !== 0 || wheels.lightSat !== 0 || wheels.globSat !== 0;
  const anyWheelExp =
    wheels.darkExp !== 0 || wheels.shadExp !== 0 || wheels.lightExp !== 0 || wheels.globExp !== 0;
  const needPixel =
    anyWheel ||
    anyWheelSat ||
    anyWheelExp ||
    shadow !== 0 ||
    highlight !== 0 ||
    midDetail !== 0 ||
    blackOffset !== 0 ||
    globalSat !== 0 ||
    globalHue !== 0 ||
    slicers.length > 0;

  const n = src.width * src.height;
  for (let i = 0; i < n; i += 1) {
    const k = i * 4;
    if (d[k + 3] === 0) {
      o[k + 3] = 0;
      continue;
    }
    let r = rLut[d[k]] / 255;
    let g = gLut[d[k + 1]] / 255;
    let b = bLut[d[k + 2]] / 255;

    if (needPixel) {
      let l = lumaOf(r, g, b);
      const wDark = (1 - l) * (1 - l) * (1 - l);
      const wLight = l * l * l;
      const wMid = Math.max(0, 1 - Math.abs(2 * l - 1));
      const wShad = wMid * (1 - l) * 2;
      const wGlob = 1;

      // 阴影 / 高光：按亮度加权的加性提降
      if (shadow !== 0) {
        const add = shadow * 0.32 * wDark;
        r += add;
        g += add;
        b += add;
      }
      if (highlight !== 0) {
        const add = highlight * 0.32 * wLight;
        r += add;
        g += add;
        b += add;
      }
      // 中间调对比：绕 0.5 的 S 形，权重压在中间调
      if (midDetail !== 0) {
        const k2 = 1 + midDetail * 0.8 * wMid;
        r = (r - 0.5) * k2 + 0.5;
        g = (g - 0.5) * k2 + 0.5;
        b = (b - 0.5) * k2 + 0.5;
      }
      // 色轮：四档色偏 + 分档曝光 + 分档饱和
      if (anyWheel) {
        const dw = [wDark, wShad, wLight, wGlob];
        const banks = [wheels.dark, wheels.shad, wheels.light, wheels.glob];
        for (let k3 = 0; k3 < 4; k3 += 1) {
          const w = dw[k3];
          if (w <= 0) continue;
          r += banks[k3][0] * w;
          g += banks[k3][1] * w;
          b += banks[k3][2] * w;
        }
      }
      if (anyWheelExp) {
        const exps = [wheels.darkExp, wheels.shadExp, wheels.lightExp, wheels.globExp];
        const dw = [wDark, wShad, wLight, wGlob];
        let f = 1;
        for (let k3 = 0; k3 < 4; k3 += 1) if (exps[k3] !== 0) f *= 1 + exps[k3] * 0.6 * dw[k3];
        r *= f;
        g *= f;
        b *= f;
      }
      if (anyWheelSat) {
        const sats = [wheels.darkSat, wheels.shadSat, wheels.lightSat, wheels.globSat];
        const dw = [wDark, wShad, wLight, wGlob];
        let amt = 0;
        for (let k3 = 0; k3 < 4; k3 += 1) if (sats[k3] !== 0) amt += sats[k3] * dw[k3];
        if (amt !== 0) {
          const ll = lumaOf(r, g, b);
          const f = 1 + amt;
          r = ll + (r - ll) * f;
          g = ll + (g - ll) * f;
          b = ll + (b - ll) * f;
        }
      }
      if (blackOffset !== 0) {
        r += blackOffset;
        g += blackOffset;
        b += blackOffset;
      }

      // 切片器 + 全局色相/饱和：都要色相上下文
      if (slicers.length > 0 || globalSat !== 0 || globalHue !== 0) {
        r = clamp01(r);
        g = clamp01(g);
        b = clamp01(b);
        let [h, s, li] = rgbToHsl(r, g, b);

        for (const sl of slicers) {
          // 以中心为峰、±32° 为半宽的余弦窗，避免硬边
          let dh = Math.abs(h - sl.center);
          if (dh > 0.5) dh = 1 - dh;
          if (dh > 0.09) continue;
          const w = 0.5 * (1 + Math.cos((dh / 0.09) * Math.PI));
          h += sl.hue * w;
          s = clamp01(s * (1 + sl.sat * w));
          li = clamp01(li * (1 + sl.lum * 0.6 * w));
        }
        if (globalHue !== 0) h += globalHue;
        if (globalSat !== 0) s = clamp01(s * (1 + globalSat));
        h = ((h % 1) + 1) % 1;
        const [r2, g2, b2] = hslToRgb(h, s, li);
        r = r2;
        g = g2;
        b = b2;
      }
    }

    o[k] = Math.round(clamp01(r) * 255);
    o[k + 1] = Math.round(clamp01(g) * 255);
    o[k + 2] = Math.round(clamp01(b) * 255);
    o[k + 3] = d[k + 3];
  }
  return out;
}
