/**
 * 绘制内核（画笔 / 橡皮 / 油漆桶 / 吸管 / 渐变）。
 *
 * 笔画引擎对齐 MyPaint 的 libmypaint，而不是「一个事件盖一个章」：
 *
 * 1. 输入点先被当作「虚拟光标」，按真实时间做指数低通（slow_tracking），
 *    把鼠标的折线与抖动磨成顺滑曲线；
 * 2. 再按「累积笔尖数」投放笔尖 —— 每落一个笔尖，才把落笔点朝虚拟光标
 *    推进一点点（slow_tracking_per_dab），跨事件用分数累积（partial dabs）。
 *
 * 因此笔尖间距只由半径与间距百分比决定，跟事件频率完全无关：快拖、慢拖、
 * 稀疏事件都不会断成虚线，也不会因插值抖动而拉稀。
 *
 * 一笔先画在独立的「笔画缓冲」上，抬笔时再整体按不透明度合成到图层：
 * 同一笔内来回涂抹不会越描越黑，不透明度才是可预期的（与 PS 一致）。
 */
import { cloneSurface, createSurface, mustCtx } from "./surface";

/**
 * 笔尖材质。
 *
 *  · `round`   圆头 —— 最常规的软硬圆笔
 *  · `pencil`  铅笔 —— 细颗粒，边缘有缺口，叠涂出沙沙的铅灰
 *  · `chalk`   粉笔 / 炭条 —— 大颗粒、边缘破碎，干媒介的主力
 *  · `bristle` 排毛 —— 平行毛束，一笔下去自带丝状笔触（油画 / 排笔）
 *  · `spray`   喷雾 —— 圆内随机撒点，喷枪 / 噪点
 */
export type BrushTip = "round" | "pencil" | "chalk" | "bristle" | "spray";

/**
 * 笔迹纹理：按一张可平铺的 256×256 纹理削减笔迹的 alpha，
 * 让同一支笔在纸纹 / 画布上留下对应的肌理。
 */
export type BrushTexture = "none" | "paper" | "canvas" | "grain" | "dots";

/** 画笔参数。 */
export interface BrushSettings {
  /** 笔尖直径（像素，满压感时） */
  size: number;
  /** 笔尖材质（决定笔迹的骨架） */
  tip: BrushTip;
  /** 笔迹纹理（纸纹 / 画布 / 颗粒 / 斑点） */
  texture: BrushTexture;
  /** 纹理缩放 50–400（%），越大纹理颗粒越粗 */
  textureScale: number;
  /** 纹理深度 0–100（%），0 为不削笔迹，越高肌理越明显 */
  textureDepth: number;
  /** 颜色抖动 0–100（%）：每个笔尖在色相环上随机偏移，画出彩色颗粒 */
  hueJitter: number;
  /** 硬度 0–100：100 为实边，0 为完全羽化 */
  hardness: number;
  /** 不透明度 0–100，作用于整笔 */
  opacity: number;
  /** 流量 1–100：单个笔尖的浓度，决定一笔之内的叠加速度 */
  flow: number;
  /** 间距 1–50（%）：相邻笔尖中心的距离占直径的百分比，越小越顺滑 */
  spacing: number;
  /** 颜色，`#rrggbb` */
  color: string;
  /**
   * 抖动 / 散布 0–100（%）：每个笔尖在「半径 × jitter%」范围内随机偏移。
   * 0 是规整的一条带；往上走笔迹开始松散，配合低流量就是喷枪、粉笔、噪点。
   */
  jitter: number;
  /** 笔尖圆度 10–100（%）：100 是正圆，越小越扁 —— 排笔 / 书法 / 油画笔锋靠它。 */
  roundness: number;
  /** 笔尖旋转角度 0–360（度）：只在圆度 < 100 时看得出效果。 */
  angle: number;
  /**
   * 稳定（平滑）0–100（%）：墨迹跟随指针的缓冲量。
   * 0 完全跟手（笔迹直接落在指针上，快笔会有折角）；
   * 越高运笔越顺滑，但墨迹落后指针越明显（手感发"飘"）。
   */
  smoothing: number;
  /**
   * 拉绳模式：笔尖像被一根绳拴在指针上，指针要先拉出「绳长」画笔才前进。
   * 绳长 = 稳定度 × 100px，所以稳定度仍是那根滑杆，拉绳只是换一种跟随方式。
   */
  pulledString: boolean;
  /** 指针停住时画笔是否继续追过去（对应 PS 的 Stroke Catch-Up） */
  catchUp: boolean;
  /** 抬笔时是否把笔迹末端吸附到最后一个输入点（Catch-Up On Stroke End） */
  catchUpOnEnd: boolean;

  /* ---------------- 形状动态 ---------------- */
  /** 大小抖动 0–100（%）：每个笔尖随机缩小 */
  sizeJitter: number;
  /** 大小抖动的下限 0–100（%），抖动最多缩到基础直径的这个比例 */
  sizeMin: number;
  /** 角度抖动 0–100（%）：100% 对应 ±180°，每个笔尖随机转向 */
  angleJitter: number;
  /** 圆度抖动 0–100（%）：每个笔尖随机压扁 */
  roundnessJitter: number;
  /** 圆度抖动的下限 10–100（%） */
  roundnessMin: number;
  /** 水平翻转抖动：50% 概率把笔尖左右镜像 */
  flipX: boolean;
  /** 垂直翻转抖动：50% 概率把笔尖上下镜像 */
  flipY: boolean;

  /* ---------------- 散布 ---------------- */
  /** 每个落点的笔尖数 1–16；1 是规整单笔尖，往上是一簇 */
  scatterCount: number;
  /** 散布数量的随机削减 0–100（%） */
  scatterCountJitter: number;
  /** true 为双轴随机散布，false 只沿笔迹法线方向甩开 */
  scatterBothAxes: boolean;

  /* ---------------- 颜色动态 ---------------- */
  /** 饱和度抖动 0–100（%） */
  saturationJitter: number;
  /** 明度抖动 0–100（%） */
  brightnessJitter: number;

  /* ---------------- 传递 ---------------- */
  /** 不透明度抖动 0–100（%） */
  opacityJitter: number;
  /** 不透明度抖动的下限 0–100（%） */
  opacityMin: number;
  /** 流量抖动 0–100（%） */
  flowJitter: number;
  /** 流量抖动的下限 0–100（%） */
  flowMin: number;

  /* ---------------- 纹理 ---------------- */
  /** 纹理反相：把「凸起着墨」换成「凹陷着墨」 */
  textureInvert: boolean;
  /** 纹理亮度 -100–100：整体加深 / 提亮肌理 */
  textureBrightness: number;
  /** 纹理对比度 -100–100：越大颗粒越硬、越分明 */
  textureContrast: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
  size: 32,
  tip: "round",
  texture: "none",
  textureScale: 100,
  textureDepth: 0,
  hueJitter: 0,
  hardness: 80,
  opacity: 100,
  flow: 100,
  spacing: 8,
  color: "#17171c",
  jitter: 0,
  roundness: 100,
  angle: 0,
  smoothing: 40,
  pulledString: false,
  catchUp: true,
  catchUpOnEnd: true,

  sizeJitter: 0,
  sizeMin: 0,
  angleJitter: 0,
  roundnessJitter: 0,
  roundnessMin: 10,
  flipX: false,
  flipY: false,

  scatterCount: 1,
  scatterCountJitter: 0,
  scatterBothAxes: true,

  saturationJitter: 0,
  brightnessJitter: 0,

  opacityJitter: 0,
  opacityMin: 0,
  flowJitter: 0,
  flowMin: 0,

  textureInvert: false,
  textureBrightness: 0,
  textureContrast: 0,
};

/** `#rgb` / `#rrggbb` → `rgba(...)`。非法输入退回黑色。 */
export function rgba(hex: string, a: number): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(0,0,0,${a})`;
  const n = Number.parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** `#rrggbb` → 0–255 三元组。 */
function rgbTriple(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 0–255 三元组 → `#rrggbb`。 */
export function toHex(r: number, g: number, b: number): string {
  const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ *
 * libmypaint 的常量与工具
 * ------------------------------------------------------------------ */

/** 笔尖半径上下限，与 libmypaint 的 ACTUAL_RADIUS_MIN/MAX 一致。 */
const ACTUAL_RADIUS_MIN = 0.2;
const ACTUAL_RADIUS_MAX = 1000;
/** 单次事件允许的最大时间跨度（秒）；超过就按它算。 */
const MAX_DTIME = 0.5;
/** 时间跨度的下限（秒）。0.1ms 对应 10kHz 采样，真实设备永远到不了。 */
const MIN_DTIME = 0.0001;
/** 时间戳不可用时的名义间隔（秒），取 120Hz 一帧的长度。 */
const NOMINAL_DTIME = 0.008;
/** 单次事件最多产生的笔尖数，纯粹是防呆护栏（正常远达不到）。 */
const MAX_DABS_PER_EVENT = 4096;
/** 拉绳模式在稳定度 100% 时的绳长（像素），与 PhotoCraft 的 MAX_STRING_PX 一致。 */
const MAX_STRING_PX = 100;

/**
 * 指数衰减 —— 返回 t 秒后「还剩下多少比例」。
 *
 * 这是 libmypaint 全部平滑的基石：时间常数越小，跟随越紧。
 */
function expDecay(timeConstant: number, t: number): number {
  if (timeConstant <= 0.001) return 0;
  return Math.exp(-t / timeConstant);
}

/** 分段线性映射曲线，对应 MyPaint 的 mapping（`[[x, y], ...]`）。 */
type Curve = ReadonlyArray<readonly [number, number]>;

function sampleCurve(curve: Curve, x: number): number {
  const n = curve.length;
  if (n === 0) return x;
  if (x <= curve[0][0]) return curve[0][1];
  if (x >= curve[n - 1][0]) return curve[n - 1][1];
  for (let i = 1; i < n; i += 1) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return curve[n - 1][1];
}

/** 压感 → 半径系数（1 = 设定的笔尖半径）。鼠标恒为 0.5 → 0.85 倍。 */
const PRESSURE_RADIUS: Curve = [
  [0, 0.3],
  [0.25, 0.62],
  [0.5, 0.85],
  [0.75, 0.95],
  [1, 1],
];

/** 压感 → 单笔尖浓度系数（对应 mypaint 的 opaque_multiply）。 */
const PRESSURE_OPAQUE: Curve = [
  [0, 0.2],
  [0.15, 0.65],
  [0.4, 0.97],
  [0.6, 1],
  [1, 1],
];

/**
 * 贴图里圆的最小半径。
 *
 * 贴图是「一张固定的小图，按比例缩放贴出去」；如果按笔尖真实半径出图，
 * 细笔的贴图只有几个像素，再缩到亚像素就丢样了。给一个下限，让缩放的
 * 倍率始终落在双线性插值能处理的范围内。
 */
const TIP_MIN_RADIUS = 8;
/**
 * 贴图超采样目标直径（像素）。
 *
 * 贴图是「画一次、之后一直缩小着贴」。缩小时双线性只取样 4 个纹素，倍率一大
 * 就会出现硬边锯齿 —— 低压感细笔（目标半径只有基准的 0.3 倍）最明显，实测
 * 边缘呈台阶状。所以贴图按「至少这么大」的超采样倍率出图，缩小后边缘由
 * 若干像素共同平均，天然抗锯齿；倍率上限 4 倍，避免大笔刷时贴图爆内存。
 */
const TIP_SS_DIAM = 64;
const TIP_SS_MAX = 4;
/** 落笔半径小于它就直接画矢量圆：亚像素下比缩放贴图更干净。 */
const VECTOR_DAB_RADIUS = 2;

/** 预渲染的笔尖贴图。 */
export interface Tip {
  /** 同一形状的一组配色；颜色抖动 > 0 时会有多张不同色相的贴图 */
  canvases: HTMLCanvasElement[];
  /** 圆在贴图里的半径，绘制时按 `r / radius` 缩放 */
  radius: number;
}

/** 32 位字符串散列：给程序化笔尖 / 纹理一个稳定的随机种子。 */
function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而快、结果确定的伪随机数发生器。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RGB → HSL（h 0–360，s / l 0–1）。 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

/** HSL → `#rrggbb`。 */
function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return toHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

/** 在色相环上偏移 `deg` 度（保持饱和度与明度）。 */
function shiftHue(hex: string, deg: number): string {
  if (Math.abs(deg) < 0.01) return hex;
  const [r, g, b] = rgbTriple(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToHex(h + deg, s, l);
}

/**
 * 在贴图里画出某种笔尖的 alpha 形状。
 *
 * 所有「颗粒」尺寸都按 `rs`（贴图半径）成比例，缩小贴图时颗粒跟着缩小，
 * 细笔不会因为超采样把颗粒抹平。
 */
function paintTip(
  g: CanvasRenderingContext2D,
  c: number,
  rs: number,
  color: string,
  hardness: number,
  kind: BrushTip,
  seed: number,
): void {
  const rand = mulberry32(seed);
  const hard = clamp(hardness, 0, 100);
  const TAU = Math.PI * 2;

  if (kind === "spray") {
    // 喷雾：圆内随机撒点，越靠外越稀疏，不做实心底。
    const count = clamp(Math.round(rs * rs * 0.5), 60, 900);
    for (let i = 0; i < count; i += 1) {
      const a = rand() * TAU;
      const d = Math.sqrt(rand()) * rs * 0.96;
      const r = rs * (0.02 + rand() * 0.045);
      g.fillStyle = rgba(color, 0.45 + rand() * 0.45);
      g.beginPath();
      g.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, Math.max(0.5, r), 0, TAU);
      g.fill();
    }
    return;
  }

  // 基础圆 / 羽化圆
  g.beginPath();
  if (hard >= 99) {
    g.fillStyle = rgba(color, 1);
    g.arc(c, c, rs, 0, TAU);
    g.fill();
  } else {
    const inner = Math.min(rs * (hard / 100), rs - 0.01);
    const rg = g.createRadialGradient(c, c, Math.max(0, inner), c, c, rs);
    rg.addColorStop(0, rgba(color, 1));
    rg.addColorStop(1, rgba(color, 0));
    g.fillStyle = rg;
    g.arc(c, c, rs, 0, TAU);
    g.fill();
  }

  if (kind === "round") return;

  g.globalCompositeOperation = "destination-out";
  if (kind === "pencil") {
    // 铅笔：中等颗粒的缺口 + 一圈细碎的边缘蚀刻
    const large = 26 + Math.round(rs * 0.25);
    for (let i = 0; i < large; i += 1) {
      const a = rand() * TAU;
      const d = Math.sqrt(rand()) * rs * 0.94;
      const r = rs * (0.08 + rand() * 0.15);
      g.beginPath();
      g.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, r, 0, TAU);
      g.fill();
    }
    const fine = 90;
    for (let i = 0; i < fine; i += 1) {
      const a = rand() * TAU;
      const d = Math.sqrt(rand()) * rs;
      const r = rs * (0.02 + rand() * 0.05);
      g.beginPath();
      g.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, Math.max(0.5, r), 0, TAU);
      g.fill();
    }
  } else if (kind === "chalk") {
    // 粉笔 / 炭条：大颗粒、边缘被啃掉
    for (let i = 0; i < 46; i += 1) {
      const a = rand() * TAU;
      const d = Math.sqrt(rand()) * rs * 0.96;
      const r = rs * (0.11 + rand() * 0.22);
      g.beginPath();
      g.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, r, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 14; i += 1) {
      const a = rand() * TAU;
      const d = rs * (0.82 + rand() * 0.18);
      const r = rs * (0.1 + rand() * 0.2);
      g.beginPath();
      g.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, r, 0, TAU);
      g.fill();
    }
  } else if (kind === "bristle") {
    // 排毛：平行毛束之间留缝，笔迹自带丝状条纹
    const n = 9;
    const step = (rs * 2) / n;
    g.strokeStyle = "#000000";
    g.lineCap = "round";
    for (let i = 0; i < n; i += 1) {
      const x = -rs + step * (i + 0.5) + (rand() * 2 - 1) * step * 0.1;
      const len = rs * (0.84 + rand() * 0.16);
      g.lineWidth = Math.max(1, step * (0.34 + rand() * 0.12));
      g.beginPath();
      g.moveTo(c + x, c - len);
      g.lineTo(c + x, c + len);
      g.stroke();
    }
  }
  g.globalCompositeOperation = "source-over";
}

/**
 * 把笔尖预渲染成一张小图。
 *
 * 逐点现算径向渐变是笔刷最大的性能黑洞；笔尖在一笔之内形状固定，
 * 一次画好、后面只做 drawImage，间距才能放心压密。
 */
function makeTip(
  radius: number,
  hardness: number,
  color: string,
  roundness = 100,
  angleDeg = 0,
  kind: BrushTip = "round",
  hueJitter = 0,
): Tip {
  const R = Math.max(radius, TIP_MIN_RADIUS);
  // 超采样倍率：细笔多倍出图再缩小，边缘才不会有台阶；粗笔 1 倍已足够。
  const ss = clamp(Math.ceil(TIP_SS_DIAM / (R * 2)), 1, TIP_SS_MAX);
  const rs = R * ss;
  const d = Math.ceil(rs * 2) + 2;

  // 颜色抖动：在 ±60° 内取 5 档色相，落笔时随机挑一张，画出彩色颗粒。
  const spread = (clamp(hueJitter, 0, 100) / 100) * 60;
  const factors = spread > 0.5 ? [-1, -0.5, 0, 0.5, 1] : [0];
  const seed = hashSeed(`${kind}|${Math.round(radius)}|${Math.round(hardness)}|${Math.round(roundness)}|${Math.round(angleDeg)}`);

  // 圆度 100 且不旋转时就是正圆；否则把椭圆「旋着压扁」画出来。
  // 缩放只作用于贴图本身，绘制端仍按正方形等比贴出，短轴自然短一截。
  const q = clamp(roundness, 10, 100) / 100;
  const straight = q >= 0.999 && angleDeg % 360 === 0;

  const canvases = factors.map((f, i) => {
    const canvas = document.createElement("canvas");
    canvas.width = d;
    canvas.height = d;
    const g = mustCtx(canvas);
    const c = d / 2;
    if (!straight) {
      g.translate(c, c);
      g.rotate((angleDeg * Math.PI) / 180);
      g.scale(1, q);
      g.translate(-c, -c);
    }
    paintTip(g, c, rs, shiftHue(color, f * spread), hardness, kind, seed + i * 7919);
    return canvas;
  });

  return { canvases, radius: rs };
}

/** 把一张预渲染笔尖按目标半径贴到画布上（预览与落笔共用）。 */
export function drawTipSprite(
  ctx: CanvasRenderingContext2D,
  tip: Tip,
  cx: number,
  cy: number,
  radius: number,
  variant = 0,
): void {
  const sprite = tip.canvases[Math.min(variant, tip.canvases.length - 1)];
  if (!sprite) return;
  const k = radius / tip.radius;
  const w = sprite.width * k;
  ctx.drawImage(sprite, cx - w / 2, cy - w / 2, w, w);
}

/* ------------------------------------------------------------------ *
 * 纸纹 / 画布纹理
 * ------------------------------------------------------------------ */

/** 纹理贴图边长（像素）。 */
const TEXTURE_TILE = 256;
/** 纹理贴图缓存：key 已按档位收敛，容量压小，拖滑杆也不会吃光内存。 */
const TEXTURE_CACHE = new Map<string, HTMLCanvasElement>();
const TEXTURE_CACHE_MAX = 24;

/** 可平铺的值噪声：格点首尾相接，双线性插值 + smoothstep。 */
function tileNoise(rand: () => number, size: number, period: number): Float32Array {
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i += 1) grid[i] = rand();

  const out = new Float32Array(size * size);
  const step = period / size;
  for (let y = 0; y < size; y += 1) {
    const fy = y * step;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const ya = (y0 % period) * period;
    const yb = ((y0 + 1) % period) * period;
    for (let x = 0; x < size; x += 1) {
      const fx = x * step;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const xa = x0 % period;
      const xb = (x0 + 1) % period;
      const top = grid[ya + xa] + (grid[ya + xb] - grid[ya + xa]) * sx;
      const bot = grid[yb + xa] + (grid[yb + xb] - grid[yb + xa]) * sx;
      out[y * size + x] = top + (bot - top) * sy;
    }
  }
  return out;
}

/**
 * 生成一张可平铺的「孔洞」贴图：像素值 = 该处要削掉多少 alpha。
 *
 * 纹理深度直接烘进贴图的 alpha，落笔时只做一次 `destination-out`，
 * 比反复叠遮罩既快又不会越描越深。
 */
function buildTexture(
  texture: BrushTexture,
  scale: number,
  depth: number,
  invert = false,
  brightness = 0,
  contrast = 0,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const size = TEXTURE_TILE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = mustCtx(canvas);
  if (typeof g.createImageData !== "function") return null;

  const img = g.createImageData(size, size);
  const data = img.data;
  const rand = mulberry32(hashSeed(`texture|${texture}`));
  const s = clamp(scale, 50, 400) / 100;
  const d = clamp(depth, 0, 100) / 100;
  const inv = invert === true;
  // 亮度：整体抬 / 压孔洞，直观效果是「肌理变浅 / 变深」
  const bright = clamp(brightness, -100, 100) / 100;
  // 对比度：以 0.5 为轴拉开，越大颗粒越硬
  const cs = clamp(contrast, -100, 100) / 100;
  const cK = cs >= 0 ? 1 + cs * 2 : 1 + cs * 0.8;
  const TAU2 = Math.PI * 2;

  /** 周期格点：频率越高（缩放越大）格子越稀，颗粒越粗。 */
  const wave = (base: number) => Math.max(2, Math.round(base / s));
  /** 能整除贴图边长的花纹周期，平铺时不会在接缝处跳变。 */
  const cells = (px: number) => size / Math.max(2, Math.round(size / (px * s)));

  // 不同质感用不同噪声底：纸纹细密、画布有经纬、颗粒是纯随机、斑点是规则点阵
  const n1 = texture === "paper" ? tileNoise(rand, size, wave(12)) : null;
  const n2 = texture === "paper" ? tileNoise(rand, size, wave(34)) : null;
  const n3 = texture === "paper" ? tileNoise(rand, size, wave(80)) : null;
  const cell = texture === "canvas" ? cells(10) : texture === "dots" ? cells(16) : 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hole = 0;
      if (texture === "paper") {
        const n =
          0.6 * (n1 as Float32Array)[y * size + x] +
          0.3 * (n2 as Float32Array)[y * size + x] +
          0.1 * (n3 as Float32Array)[y * size + x];
        // 只有低于中位的「凹陷」才咬掉墨色，纸纹才不会把整笔磨淡
        hole = clamp((0.58 - n) * 2.4, 0, 1);
      } else if (texture === "canvas") {
        // 经纬线交叉处凸起（保留），线缝下陷（削掉）
        const wx = Math.abs(Math.sin((x / cell) * TAU2));
        const wy = Math.abs(Math.sin((y / cell) * TAU2));
        const weave = Math.max(wx, wy);
        hole = clamp((1 - weave) * 0.55 + (rand() - 0.5) * 0.22, 0, 1);
      } else if (texture === "grain") {
        hole = rand() * 0.9;
      } else if (texture === "dots") {
        const fx = ((x / cell) % 1) - 0.5;
        const fy = ((y / cell) % 1) - 0.5;
        hole = clamp(1 - Math.hypot(fx, fy) * 3.1, 0, 1) + (rand() - 0.5) * 0.12;
        hole = clamp(hole, 0, 1);
      }

      const i = (y * size + x) * 4;
      // 纹理反相：原本凸起着墨的地方改成凹陷着墨
      if (inv) hole = 1 - hole;
      hole = (hole - 0.5) * cK + 0.5 - bright * 0.5;
      // RGB 无关紧要（只取 alpha 做 destination-out），保持白色便于调试
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(clamp(hole, 0, 1) * d * 255);
    }
  }

  g.putImageData(img, 0, 0);
  return canvas;
}

/** 取（或生成）纹理贴图；缩放 / 深度 / 亮度 / 对比度按档位取整，避免滑杆拖动产生无限缓存。 */
function textureTile(
  texture: BrushTexture,
  scale: number,
  depth: number,
  invert = false,
  brightness = 0,
  contrast = 0,
): HTMLCanvasElement | null {
  if (!texture || texture === "none") return null;
  if (!(depth > 0)) return null;
  const sc = Math.round(clamp(scale, 50, 400) / 25) * 25;
  const dp = Math.round(clamp(depth, 0, 100) / 5) * 5;
  if (dp <= 0) return null;
  const br = Math.round(clamp(brightness, -100, 100) / 5) * 5;
  const ct = Math.round(clamp(contrast, -100, 100) / 5) * 5;
  const inv = invert === true;
  const key = `${texture}|${sc}|${dp}|${inv ? 1 : 0}|${br}|${ct}`;
  const hit = TEXTURE_CACHE.get(key);
  if (hit) return hit;
  const tile = buildTexture(texture, sc, dp, inv, br, ct);
  if (!tile) return null;
  if (TEXTURE_CACHE.size >= TEXTURE_CACHE_MAX) {
    const oldest = TEXTURE_CACHE.keys().next().value;
    if (oldest !== undefined) TEXTURE_CACHE.delete(oldest);
  }
  TEXTURE_CACHE.set(key, tile);
  return tile;
}

/** 在指定矩形内按纹理削减 alpha（destination-out，只影响已有笔迹）。 */
function applyTextureMask(
  ctx: CanvasRenderingContext2D,
  texture: BrushTexture,
  scale: number,
  depth: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  invert = false,
  brightness = 0,
  contrast = 0,
): void {
  if (x1 <= x0 || y1 <= y0) return;
  const tile = textureTile(texture, scale, depth, invert, brightness, contrast);
  if (!tile) return;
  if (typeof ctx.createPattern !== "function") return;
  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return;

  const prevOp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 1;
  ctx.fillStyle = pattern;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prevOp;
}

/**
 * 画笔预览小样：与落笔完全同源地画出笔尖形状、抖动、颜色抖动与纹理。
 *
 * 直径按对数映射 —— 1px 的铅笔与 500px 的大刷子在同一块预览里都看得见。
 */
export function drawBrushTipSample(
  ctx: CanvasRenderingContext2D,
  box: number,
  brush: BrushSettings,
  isEraser = false,
  /** 设备像素比：高分屏上按物理像素出图，小样才不糊 */
  ratio = 1,
): void {
  const pad = 2;
  const mid = box / 2;
  const k = Math.log(brush.size + 1) / Math.log(501);
  const r = (5 + k * (box - 10)) / 2;
  const color = isEraser ? "#969ea8" : brush.color;
  const tip = makeTip(
    r,
    brush.hardness,
    color,
    brush.roundness,
    brush.angle,
    brush.tip,
    isEraser ? 0 : brush.hueJitter,
  );

  // 画在离屏画布上：纹理要按整块小样一次性裁，不能逐个笔尖裁
  const k2 = Math.max(1, ratio);
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.round(box * k2));
  off.height = Math.max(1, Math.round(box * k2));
  const g = mustCtx(off);
  g.scale(k2, k2);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.globalAlpha = Math.max(0.1, clamp(brush.opacity, 0, 100) / 100);

  const variants = tip.canvases.length;
  const jit = clamp(brush.jitter, 0, 100) / 100;
  if (jit > 0.01) {
    // 环形撒几个偏移笔尖（位置固定，避免每次重绘乱跳），让松散程度可见
    const reach = r * jit;
    g.globalAlpha *= 0.6;
    for (let i = 0; i < 7; i += 1) {
      const a = (i / 7) * Math.PI * 2;
      const d = reach * (0.4 + 0.6 * ((i * 37) % 13) / 13);
      const rr = r * (0.55 + 0.15 * ((i * 17) % 5) / 5);
      drawTipSprite(g, tip, mid + Math.cos(a) * d, mid + Math.sin(a) * d, rr, i % variants);
    }
    g.globalAlpha /= 0.6;
  }
  // 中心用基准色那一张（5 档时下标 2 是 ±0°）
  drawTipSprite(g, tip, mid, mid, r, Math.floor(variants / 2));

  applyTextureMask(
    g,
    brush.texture,
    brush.textureScale,
    brush.textureDepth,
    Math.max(0, mid - r - pad),
    Math.max(0, mid - r - pad),
    Math.min(box, mid + r + pad),
    Math.min(box, mid + r + pad),
    brush.textureInvert === true,
    brush.textureBrightness,
    brush.textureContrast,
  );

  ctx.drawImage(off, 0, 0, box, box);
}

/**
 * 一笔。
 *
 * 生命周期：begin → extend（若干次） → finish。
 * `erase` 为 true 时从图层上擦除而不是画上。
 */
export class Stroke {
  private readonly buf: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** 预渲染的笔尖，逐点贴图 */
  private readonly tip: Tip;
  private readonly erase: boolean;
  private readonly settings: BrushSettings;

  /* --- 由画笔参数推导出的「mypaint 设置」，一笔之内不变 --- */
  /** 满压感时的笔尖半径 */
  private readonly baseRadius: number;
  /** 每前进一个「实际半径」投放几个笔尖 */
  private readonly dabsPerActualRadius: number;
  private readonly dabsPerBasicRadius = 0;
  private readonly dabsPerSecond = 0;
  /** 虚拟光标的时间常数（单位 1/100 秒），由稳定度换算 */
  private readonly slowTracking: number;
  /** 落笔点的时间常数（单位：笔尖数），由稳定度换算 */
  private readonly slowTrackingPerDab: number;
  /** 拉绳模式：笔尖被绳拴住，指针先拉出绳长才前进 */
  private readonly pulledString: boolean;
  /** 指针停住时画笔是否继续追过去 */
  private readonly catchUp: boolean;
  /** 抬笔时是否吸附到最后一个输入点 */
  private readonly catchUpOnEnd: boolean;
  /** 绳长（像素）：稳定度 100% 对应 100px */
  private readonly stringLen: number;
  /** 速度低通的时间常数（秒） */
  private readonly speedSlowness = 0.05;
  /** 单笔尖基础浓度（= 流量） */
  private readonly opaqueBase: number;
  /** dabs-per-pixel 线性化强度 */
  private readonly opaqueLinearize = 0.5;
  /** 抖动：笔尖随机偏移的最大幅度，占半径的比例（0–1） */
  private readonly jitterAmp: number;

  /* --- 形状动态 --- */
  private readonly sizeJitterAmp: number;
  private readonly sizeMinAmp: number;
  private readonly angleJitterAmp: number;
  private readonly roundnessJitterAmp: number;
  private readonly roundnessMinAmp: number;
  private readonly roundnessBase: number;
  private readonly flipX: boolean;
  private readonly flipY: boolean;

  /* --- 散布 --- */
  private readonly scatterCount: number;
  private readonly scatterCountJitterAmp: number;
  private readonly scatterBothAxes: boolean;

  /* --- 颜色动态 --- */
  private readonly saturationJitterAmp: number;
  private readonly brightnessJitterAmp: number;

  /* --- 传递 --- */
  private readonly opacityJitterAmp: number;
  private readonly opacityMinAmp: number;
  private readonly flowJitterAmp: number;
  private readonly flowMinAmp: number;

  /* --- 可变状态 --- */
  /** 笔迹前进方向（单位向量），散布沿法线甩开时要用 */
  private dirX = 1;
  private dirY = 0;
  /** 虚拟光标（已按时间平滑） */
  private x = 0;
  private y = 0;
  private pressure = 0;
  /** 实际落笔点（再按笔尖数平滑，避免插值抖动） */
  private actualX = 0;
  private actualY = 0;
  private actualRadius = 1;
  /** 跨事件累积的「不足一个笔尖」的余量 */
  private partialDabs = 0;
  /** 低通后的速度（像素 / 秒） */
  private normSpeed = 0;
  private lastTime = 0;
  private started = false;
  /** 最后一个原始输入点：抬笔时用它把虚拟光标吸附过去，补掉末端断口 */
  private lastX = 0;
  private lastY = 0;
  private lastPressure = 0;
  /** 整笔的包围盒：抬笔时只在这块区域裁纹理 */
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  constructor(
    width: number,
    height: number,
    settings: BrushSettings,
    erase: boolean,
  ) {
    this.settings = settings;
    this.erase = erase;
    this.buf = document.createElement("canvas");
    this.buf.width = Math.max(1, Math.round(width));
    this.buf.height = Math.max(1, Math.round(height));
    this.ctx = mustCtx(this.buf);
    // 笔尖贴图一律是「缩小着贴」，插值质量必须显式拉满：默认的 low 在缩小
    // 倍率大于 2 时会丢样，硬边细笔的边缘会呈锯齿。
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";

    // 稳定度换算：0–100% → 0–100ms 的虚拟光标时间常数（40% 即原默认手感）；
    // 落笔点平滑（按笔尖数）同比例削弱（40% → 2，与原硬编码一致），
    // 两条平滑同时归零才是真正的「跟手」。
    const sm = clamp(settings.smoothing, 0, 100) / 100;
    this.slowTracking = sm * 10;
    this.slowTrackingPerDab = 5 * sm;
    this.pulledString = settings.pulledString === true;
    this.catchUp = settings.catchUp !== false;
    this.catchUpOnEnd = settings.catchUpOnEnd !== false;
    this.stringLen = sm * MAX_STRING_PX;

    this.baseRadius = clamp(settings.size / 2, ACTUAL_RADIUS_MIN, ACTUAL_RADIUS_MAX);
    // 间距 = 直径的 spacing%，换算成「每半径投放几个笔尖」：
    // spacing_px = radius / dpar，要让 spacing_px = 2r·spacing% 即得下面这条。
    const spacingPct = clamp(settings.spacing, 1, 50);
    this.dabsPerActualRadius = 50 / spacingPct;
    this.opaqueBase = clamp(settings.flow / 100, 0, 1);
    this.jitterAmp = clamp(settings.jitter, 0, 100) / 100;

    // 动态参数：全部归一到 0–1，抖动量为 0 时下面每条路径都不会被走到。
    this.sizeJitterAmp = clamp(settings.sizeJitter, 0, 100) / 100;
    this.sizeMinAmp = clamp(settings.sizeMin, 0, 100) / 100;
    this.angleJitterAmp = clamp(settings.angleJitter, 0, 100) / 100;
    this.roundnessJitterAmp = clamp(settings.roundnessJitter, 0, 100) / 100;
    this.roundnessMinAmp = clamp(settings.roundnessMin, 10, 100) / 100;
    this.roundnessBase = clamp(settings.roundness, 10, 100) / 100;
    this.flipX = settings.flipX === true;
    this.flipY = settings.flipY === true;
    this.scatterCount = Math.round(clamp(settings.scatterCount, 1, 16));
    this.scatterCountJitterAmp = clamp(settings.scatterCountJitter, 0, 100) / 100;
    this.scatterBothAxes = settings.scatterBothAxes !== false;
    this.saturationJitterAmp = clamp(settings.saturationJitter, 0, 100) / 100;
    this.brightnessJitterAmp = clamp(settings.brightnessJitter, 0, 100) / 100;
    this.opacityJitterAmp = clamp(settings.opacityJitter, 0, 100) / 100;
    this.opacityMinAmp = clamp(settings.opacityMin, 0, 100) / 100;
    this.flowJitterAmp = clamp(settings.flowJitter, 0, 100) / 100;
    this.flowMinAmp = clamp(settings.flowMin, 0, 100) / 100;

    // 橡皮只看 alpha 通道，颜色取什么都行
    this.tip = makeTip(
      this.baseRadius,
      settings.hardness,
      erase ? "#000000" : settings.color,
      settings.roundness,
      settings.angle,
      settings.tip,
      erase ? 0 : settings.hueJitter,
    );
  }

  /**
   * 笔画缓冲（只读）。
   *
   * 绘制过程中界面需要「未抬笔」的即时回显：把这张缓冲按当前不透明度叠在
   * 合成结果上即可，既不用提前改写图层，也不会污染撤销栈。
   */
  get buffer(): HTMLCanvasElement {
    return this.buf;
  }

  /** 落笔：初始化全部状态并投下第一个笔尖（点一下就是一个点）。 */
  begin(x: number, y: number, pressure = 0.5, time = now()): void {
    this.x = x;
    this.y = y;
    this.pressure = clamp(pressure, 0, 1);
    this.actualX = x;
    this.actualY = y;
    this.actualRadius = this.radiusFor(this.pressure);
    this.partialDabs = 0;
    this.normSpeed = 0;
    this.lastTime = time;
    this.lastX = x;
    this.lastY = y;
    this.lastPressure = this.pressure;
    this.started = true;
    this.drawDab();
  }

  /** 追加一个采样点。 */
  extend(x: number, y: number, pressure = 0.5, time = now()): void {
    if (!this.started) {
      this.begin(x, y, pressure, time);
      return;
    }
    let dtime = (time - this.lastTime) / 1000;
    // 时间戳是否可信：有限、确实在往前走、且没有夸张地跳。某些运行时把
    // getCoalescedEvents 的 timeStamp 一律填成同一个值（甚至 0），照单全收
    // 就会算出「零间隔」或「万亿分之一秒」。
    const usable = Number.isFinite(dtime) && dtime > MIN_DTIME && dtime <= MAX_DTIME;
    // 时间不可信时退回名义间隔继续做时间低通，绝不「跳过平滑、直接吸附到输
    // 入点」—— 那等于把每个原始采样点都当成折线拐角，细笔快拖会画成一段段
    // 直线（实测可见折角）。名义间隔下低通照常工作，笔迹依然是顺滑曲线。
    if (!usable) dtime = NOMINAL_DTIME;
    this.lastTime = time;
    // 无论时间戳是否可信都走同一条平滑路径；笔尖数量只由走过的距离决定
    //（dabsPerSecond = 0），不依赖事件频率，也就绝不会重建成「一连串孤点」。
    this.strokeTo(x, y, clamp(pressure, 0, 1), dtime);
  }

  /** libmypaint `stroke_to` 的主循环。`snap` 为真时跳过虚拟光标的时间低通。 */
  private strokeTo(
    x: number,
    y: number,
    pressure: number,
    dtime: number,
    snap = false,
  ): void {
    // 判断「指针停住」要拿上一个输入点比，不能先覆盖 lastX / lastY
    const still = x === this.lastX && y === this.lastY;
    this.lastX = x;
    this.lastY = y;
    this.lastPressure = pressure;

    // 1) 指针 → 虚拟光标：三条路径与 PhotoCraft 的 Smoother 一致
    if (snap) {
      // 抬笔收尾：直接吸附到最后一个输入点
    } else if (this.pulledString) {
      // 拉绳：只跟「超出绳长」的那一段，绳内的位移全部积攒着
      const dx = x - this.x;
      const dy = y - this.y;
      const d = Math.hypot(dx, dy);
      if (d > this.stringLen) {
        const k = (d - this.stringLen) / d;
        x = this.x + dx * k;
        y = this.y + dy * k;
      } else {
        x = this.x;
        y = this.y;
      }
    } else {
      // 指针停住且关闭追赶：画笔原地不动，不再落新笔尖
      if (still && !this.catchUp) return;
      // 指数低通：按真实时间归一化，事件频率不影响手感
      const fac = 1 - expDecay(this.slowTracking, 100 * dtime);
      x = this.x + (x - this.x) * fac;
      y = this.y + (y - this.y) * fac;
    }

    let dtimeLeft = dtime;
    let dabsMoved = this.partialDabs;
    let dabsTodo = this.countDabsTo(x, y, dtime);
    let guard = 0;

    // 2) 攒够一个笔尖就落一个，位置按两点线性插值推进
    while (dabsMoved + dabsTodo >= 1 && guard < MAX_DABS_PER_EVENT) {
      guard += 1;
      let stepDdab: number;
      if (dabsMoved > 0) {
        stepDdab = 1 - dabsMoved;
        dabsMoved = 0;
      } else {
        stepDdab = 1;
      }
      const frac = stepDdab / dabsTodo;
      const stepDtime = frac * dtimeLeft;
      this.updateStates(
        stepDdab,
        frac * (x - this.x),
        frac * (y - this.y),
        frac * (pressure - this.pressure),
        stepDtime,
      );
      this.drawDab();
      dtimeLeft -= stepDtime;
      dabsTodo = this.countDabsTo(x, y, dtimeLeft);
    }

    // 3) 不足一个笔尖：把状态推进到当前时间，余量留到下一次事件
    this.updateStates(dabsTodo, x - this.x, y - this.y, pressure - this.pressure, dtimeLeft);
    this.partialDabs = dabsMoved + dabsTodo;
  }

  /** 推进状态：位置、半径、落笔点平滑、速度平滑。 */
  private updateStates(
    stepDdab: number,
    stepDx: number,
    stepDy: number,
    stepDp: number,
    stepDt: number,
  ): void {
    if (!(stepDt > 0)) stepDt = 0.001;

    this.x += stepDx;
    this.y += stepDy;
    // 记下前进方向：关闭双轴散布时，笔尖只沿法线方向甩开
    const moveLen = Math.hypot(stepDx, stepDy);
    if (moveLen > 1e-6) {
      this.dirX = stepDx / moveLen;
      this.dirY = stepDy / moveLen;
    }
    this.pressure = clamp(this.pressure + stepDp, 0, 1);
    this.actualRadius = this.radiusFor(this.pressure);

    // 落笔点按笔尖数低通（SLOW_TRACKING_PER_DAB）
    const fac = 1 - expDecay(this.slowTrackingPerDab, stepDdab);
    this.actualX += (this.x - this.actualX) * fac;
    this.actualY += (this.y - this.actualY) * fac;

    // 速度低通：只用来让快笔略微变细，不参与间距计算
    const speed = Math.hypot(stepDx / stepDt, stepDy / stepDt);
    const facSpeed = 1 - expDecay(this.speedSlowness, stepDt);
    this.normSpeed += (speed - this.normSpeed) * facSpeed;
  }

  /** 计算从虚拟光标走到 (x, y) 一共要落多少个笔尖。 */
  private countDabsTo(x: number, y: number, dt: number): number {
    const dist = Math.hypot(x - this.x, y - this.y);
    return (
      (dist / this.actualRadius) * this.dabsPerActualRadius +
      (dist / this.baseRadius) * this.dabsPerBasicRadius +
      dt * this.dabsPerSecond
    );
  }

  /** 当前压感下的笔尖半径。 */
  private radiusFor(pressure: number): number {
    const fromPressure = sampleCurve(PRESSURE_RADIUS, pressure);
    const fromSpeed = 1 - 0.1 * clamp(this.normSpeed / 3000, 0, 1);
    return clamp(this.baseRadius * fromPressure * fromSpeed, ACTUAL_RADIUS_MIN, ACTUAL_RADIUS_MAX);
  }

  /** 贴一个笔尖（散布时是一簇）。 */
  private drawDab(): void {
    // 单笔尖浓度 = 流量 × 压感系数，再做 dabs-per-pixel 线性化：
    // 让「一个笔尖宽度扫过去」的总浓度约等于流量，间距变化时手感才一致。
    let opaque = clamp(this.opaqueBase * sampleCurve(PRESSURE_OPAQUE, this.pressure), 0, 1);
    let dabsPerPixel = (this.dabsPerActualRadius + this.dabsPerBasicRadius) * 2;
    if (dabsPerPixel < 1) dabsPerPixel = 1;
    dabsPerPixel = 1 + this.opaqueLinearize * (dabsPerPixel - 1);
    opaque = clamp(1 - Math.pow(1 - opaque, 1 / dabsPerPixel), 0, 1);

    const c = this.ctx;

    // 散布数量：数量抖动只会往下削，绝不越过设定值
    let count = this.scatterCount;
    if (count > 1 && this.scatterCountJitterAmp > 0) {
      const keep = 1 - Math.random() * this.scatterCountJitterAmp;
      count = clamp(Math.round(count * keep), 1, count);
    }

    for (let i = 0; i < count; i += 1) {
      let alpha = opaque;
      if (this.flowJitterAmp > 0) {
        alpha *= Math.max(this.flowMinAmp, 1 - Math.random() * this.flowJitterAmp);
      }
      if (this.opacityJitterAmp > 0) {
        alpha *= Math.max(this.opacityMinAmp, 1 - Math.random() * this.opacityJitterAmp);
      }
      c.globalAlpha = clamp(alpha, 0, 1);

      // 大小抖动：缩到基础直径的 [minimum, 100%] 之间
      let r = this.actualRadius;
      if (this.sizeJitterAmp > 0) {
        const keep = Math.max(this.sizeMinAmp, 1 - Math.random() * this.sizeJitterAmp);
        r = clamp(r * keep, ACTUAL_RADIUS_MIN, ACTUAL_RADIUS_MAX);
      }

      // 抖动 / 散布：只在「画出去」这一步偏移笔尖，不动虚拟光标与落笔点，
      // 所以轨迹仍是一条平滑曲线，只是沿路撒得更松散。
      let px = this.actualX;
      let py = this.actualY;
      if (this.jitterAmp > 0) {
        const amp = r * this.jitterAmp;
        if (this.scatterBothAxes) {
          px += (Math.random() * 2 - 1) * amp;
          py += (Math.random() * 2 - 1) * amp;
        } else {
          // 只沿笔迹法线甩开
          const d = (Math.random() * 2 - 1) * amp;
          px += -this.dirY * d;
          py += this.dirX * d;
        }
      }

      // 饱和度 / 明度抖动：整颗笔尖统一走画布滤镜
      let filter = "";
      if (this.saturationJitterAmp > 0 || this.brightnessJitterAmp > 0) {
        const sat = this.saturationJitterAmp > 0
          ? clamp(100 + (Math.random() * 2 - 1) * this.saturationJitterAmp * 100, 0, 200)
          : 100;
        const bri = this.brightnessJitterAmp > 0
          ? clamp(100 + (Math.random() * 2 - 1) * this.brightnessJitterAmp * 100, 20, 200)
          : 100;
        filter = `saturate(${sat}%) brightness(${bri}%)`;
      }

      // 亚像素笔尖：缩放贴图会丢样，直接画矢量圆更干净（此处已看不见羽化）
      if (r < VECTOR_DAB_RADIUS) {
        c.fillStyle = this.erase ? "#000000" : this.settings.color;
        if (filter) c.filter = filter;
        c.beginPath();
        c.arc(px, py, r, 0, Math.PI * 2);
        c.fill();
        if (filter) c.filter = "none";
        this.trackDab(px, py, r);
        continue;
      }

      // 颜色抖动：同一形状有 5 档色相，每个笔尖随机挑一张，叠出彩色颗粒
      const variant =
        this.tip.canvases.length > 1
          ? Math.floor(Math.random() * this.tip.canvases.length)
          : 0;

      // 角度 / 圆度 / 翻转抖动：都作用在贴图绘制这一下
      const spin = this.angleJitterAmp > 0
        ? (Math.random() * 2 - 1) * 180 * this.angleJitterAmp
        : 0;
      let qScale = 1;
      if (this.roundnessJitterAmp > 0) {
        const q = Math.max(
          this.roundnessMinAmp,
          this.roundnessBase * (1 - Math.random() * this.roundnessJitterAmp),
        );
        qScale = clamp(q / this.roundnessBase, 0.01, 1);
      }
      const fx = this.flipX && Math.random() < 0.5 ? -1 : 1;
      const fy = this.flipY && Math.random() < 0.5 ? -1 : 1;

      // 默认参数一定要走这条最干净的路径：一次平移 + 一次 drawImage
      if (spin === 0 && qScale === 1 && fx === 1 && fy === 1 && !filter) {
        drawTipSprite(c, this.tip, px, py, r, variant);
      } else {
        c.save();
        if (filter) c.filter = filter;
        c.translate(px, py);
        if (spin !== 0) c.rotate((spin * Math.PI) / 180);
        if (qScale !== 1 || fx !== 1 || fy !== 1) c.scale(fx, qScale * fy);
        drawTipSprite(c, this.tip, 0, 0, r, variant);
        if (filter) c.filter = "none";
        c.restore();
      }
      this.trackDab(px, py, r);
    }
  }

  /** 记下这个笔尖的外接矩形（含抖动余量），供纹理裁剪定界。 */
  private trackDab(x: number, y: number, r: number): void {
    const pad = r + 2;
    if (x - pad < this.minX) this.minX = x - pad;
    if (y - pad < this.minY) this.minY = y - pad;
    if (x + pad > this.maxX) this.maxX = x + pad;
    if (y + pad > this.maxY) this.maxY = y + pad;
  }

  /** 抬笔合成前，按纹理把笔迹的 alpha 咬掉一层（整笔只咬一次）。 */
  private textureStroke(): void {
    if (this.minX === Infinity) return;
    const x0 = clamp(Math.floor(this.minX), 0, this.buf.width);
    const y0 = clamp(Math.floor(this.minY), 0, this.buf.height);
    const x1 = clamp(Math.ceil(this.maxX), 0, this.buf.width);
    const y1 = clamp(Math.ceil(this.maxY), 0, this.buf.height);
    applyTextureMask(
      this.ctx,
      this.settings.texture,
      this.settings.textureScale,
      this.settings.textureDepth,
      x0,
      y0,
      x1,
      y1,
      this.settings.textureInvert === true,
      this.settings.textureBrightness,
      this.settings.textureContrast,
    );
  }

  /**
   * 抬笔收尾：把虚拟光标吸附到最后一个输入点并补齐末尾的笔尖。
   *
   * 虚拟光标是时间低通的，稳态下会落后真实指针 `速度 × slow_tracking`；
   * 不冲刷的话快拖的笔画末端会差一截（实测 30–240px）。
   */
  private flush(): void {
    if (!this.started) return;
    // 与 PhotoCraft 的 Catch-Up On Stroke End 一致：关掉就停在绳/低通当前的位置
    if (this.catchUpOnEnd) {
      // 吸附式再走一遍主循环：dabs 会沿「旧光标 → 输入点」这段补齐
      this.strokeTo(this.lastX, this.lastY, this.lastPressure, MIN_DTIME, true);
    }
    // 不足一个笔尖的余量直接抹掉，避免下次落笔凭空多出一个点
    this.x = this.lastX;
    this.y = this.lastY;
    this.partialDabs = 0;
  }

  /** 把整笔合成到目标图层。mask 非空时只在选区内落笔（按 alpha 羽化）。 */
  finish(layer: HTMLCanvasElement, mask?: HTMLCanvasElement | null): void {
    // 先把落后的虚拟光标追平，否则末端会缺一截
    this.flush();
    // 整笔的纹理只裁一次：逐笔尖裁既慢，又会越叠越深
    this.textureStroke();
    const ctx = mustCtx(layer);
    ctx.save();
    ctx.globalAlpha = this.settings.opacity / 100;
    if (this.erase) {
      // 橡皮：笔画缓冲当作遮罩，从图层上抠掉
      ctx.globalCompositeOperation = "destination-out";
    }
    ctx.drawImage(mask ? clipTo(this.buf, mask) : this.buf, 0, 0);
    ctx.restore();
  }
}

/** 把 src 按 mask 的 alpha 裁一刀，返回一张新画布（不动机身）。 */
function clipTo(src: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = cloneSurface(src);
  const c = mustCtx(out);
  c.globalCompositeOperation = "destination-in";
  c.drawImage(mask, 0, 0);
  c.globalCompositeOperation = "source-over";
  return out;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** 吸管：取某点颜色，返回 `#rrggbb`。越界返回 null。 */
export function pickColor(
  surface: HTMLCanvasElement,
  x: number,
  y: number,
): string | null {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= surface.width || py >= surface.height) return null;
  const d = mustCtx(surface).getImageData(px, py, 1, 1).data;
  return toHex(d[0], d[1], d[2]);
}

/**
 * 油漆桶：按容差做四邻域洪水填充。
 *
 * 逐像素扫描，用显式栈而不是递归 —— 大图上递归会爆栈。
 */
export function floodFill(
  surface: HTMLCanvasElement,
  sx: number,
  sy: number,
  color: string,
  tolerance = 32,
  /** 非空时只在选区内扩散：选区之外一律视作「不相近」，洪水到此为止 */
  mask?: HTMLCanvasElement | null,
): boolean {
  const w = surface.width;
  const h = surface.height;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;

  const ctx = mustCtx(surface);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [tr, tg, tb] = rgbTriple(color);

  const at = (x: number, y: number) => (y * w + x) * 4;
  const seed = at(x0, y0);
  const sr = d[seed];
  const sg = d[seed + 1];
  const sb = d[seed + 2];
  const sa = d[seed + 3];

  // 目标色与新色一致就没必要跑
  if (sr === tr && sg === tg && sb === tb && sa === 255) return false;

  const md = mask ? mustCtx(mask).getImageData(0, 0, w, h).data : null;
  // 落点在选区之外时什么也不做
  if (md && md[seed + 3] === 0) return false;

  const tol = tolerance * tolerance * 4;
  const near = (i: number) => {
    if (md && md[i + 3] === 0) return false;
    const dr = d[i] - sr;
    const dg = d[i + 1] - sg;
    const db = d[i + 2] - sb;
    const da = d[i + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };

  const filled = new Uint8Array(w * h);
  const stack: number[] = [x0, y0];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    let left = x;
    while (left >= 0 && !filled[y * w + left] && near(at(left, y))) left -= 1;
    left += 1;
    let right = x;
    while (right < w && !filled[y * w + right] && near(at(right, y))) right += 1;
    right -= 1;
    for (let i = left; i <= right; i += 1) {
      filled[y * w + i] = 1;
      const p = at(i, y);
      d[p] = tr;
      d[p + 1] = tg;
      d[p + 2] = tb;
      d[p + 3] = 255;
      if (y > 0) {
        const up = (y - 1) * w + i;
        if (!filled[up] && near(at(i, y - 1))) stack.push(i, y - 1);
      }
      if (y < h - 1) {
        const dn = (y + 1) * w + i;
        if (!filled[dn] && near(at(i, y + 1))) stack.push(i, y + 1);
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return true;
}

/**
 * 渐变类型，与 PS 的五个选项一一对应：
 *  · `linear`    线性 —— 沿拖拽方向由起点色渐变到终点色
 *  · `radial`    径向 —— 由起点向外扩散成一个圆形
 *  · `angle`     角度 —— 绕起点旋转一周，起点方向为起始色、对侧为终点色
 *  · `reflected` 对称 —— 以起点为中心向两端镜像
 *  · `diamond`   菱形 —— 按「到渐变轴的切比雪夫距离」铺开成菱形
 */
export type GradientStyle = "linear" | "radial" | "angle" | "reflected" | "diamond";

const TAU = Math.PI * 2;

/**
 * 渐变填充：两点决定方向与长度，`style` 决定形状。
 *
 * 线性与径向交给 canvas 原生渐变（快且带硬件抗锯齿）；角度 / 对称 / 菱形
 * 画布没有对应原语，按像素算 —— 反正一次填充就是一次历史记录，几百毫秒
 * 换五种类型齐活，比「点进去没反应」强得多。
 *
 * mask 非空时只在选区内显色（与画笔、油漆桶共用同一套选区语义）。
 */
export function gradientFill(
  surface: HTMLCanvasElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  colorA: string,
  colorB: string,
  style: GradientStyle = "linear",
  mask?: HTMLCanvasElement | null,
): void {
  const ctx = mustCtx(surface);
  // 无选区时直接画到目标上，省一张暂存
  const target = mask ? createSurface(surface.width, surface.height) : surface;
  const tc = mask ? mustCtx(target) : ctx;
  const w = target.width;
  const h = target.height;
  const vx = to.x - from.x;
  const vy = to.y - from.y;
  const len = Math.hypot(vx, vy);

  if (len < 1e-3) {
    // 起终点重合：整幅铺满起始色（与 PS 里「原地轻点一下」的表现一致）
    tc.save();
    tc.fillStyle = colorA;
    tc.fillRect(0, 0, w, h);
    tc.restore();
  } else if (style === "linear" || style === "radial") {
    const g =
      style === "linear"
        ? tc.createLinearGradient(from.x, from.y, to.x, to.y)
        : tc.createRadialGradient(from.x, from.y, 0, from.x, from.y, len);
    g.addColorStop(0, colorA);
    g.addColorStop(1, colorB);
    tc.save();
    tc.fillStyle = g;
    tc.fillRect(0, 0, w, h);
    tc.restore();
  } else {
    const a = rgbTriple(colorA);
    const b = rgbTriple(colorB);
    const dA = b[0] - a[0];
    const dB = b[1] - a[1];
    const dC = b[2] - a[2];
    const img = tc.getImageData(0, 0, w, h);
    const data = img.data;
    const invLen2 = 1 / (len * len);
    const base = Math.atan2(vy, vx);
    for (let y = 0; y < h; y += 1) {
      const dy = y - from.y;
      for (let x = 0; x < w; x += 1) {
        const dx = x - from.x;
        // t 是「沿渐变的进度」：0 = 起点色，1 = 终点色
        let t: number;
        if (style === "reflected") {
          t = Math.abs((dx * vx + dy * vy) * invLen2);
        } else if (style === "diamond") {
          const p = (dx * vx + dy * vy) / len;
          const q = (dy * vx - dx * vy) / len;
          t = (Math.abs(p) + Math.abs(q)) / len;
        } else {
          let ang = Math.atan2(dy, dx) - base;
          ang = ((ang % TAU) + TAU) % TAU;
          // 0 → 起点色，π（正对侧）→ 终点色，2π 回到起点色
          const u = ang / Math.PI;
          t = u <= 1 ? u : 2 - u;
        }
        if (t > 1) t = 1;
        else if (t < 0) t = 0;
        const i = (y * w + x) * 4;
        data[i] = a[0] + dA * t;
        data[i + 1] = a[1] + dB * t;
        data[i + 2] = a[2] + dC * t;
        data[i + 3] = 255;
      }
    }
    tc.putImageData(img, 0, 0);
  }

  if (!mask) return;
  tc.globalCompositeOperation = "destination-in";
  tc.drawImage(mask, 0, 0);
  tc.globalCompositeOperation = "source-over";
  ctx.drawImage(target, 0, 0);
}
