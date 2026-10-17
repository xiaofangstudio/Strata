/**
 * 修饰内核（仿制图章 / 修复画笔 / 模糊 / 锐化 / 减淡 / 加深 / 海绵）。
 *
 * 落笔骨架与画笔同源（见 `paint.ts`）：虚拟光标按真实时间低通、按笔尖间距
 * 投放笔尖、跨事件用分数累积。区别只在「落笔动作」——
 * 画笔往图层上落色，修饰工具在笔尖覆盖区内做像素算子。
 *
 * 效果强度按「覆盖率」累积：每一笔先在一张独立的覆盖率画布上叠出
 * 「某个像素被笔尖扫过多少」，然后按下式作用到图层：
 *
 *     结果 = 原图 ⊕ 算子(原图)，混合权重 = 覆盖率 × 选区遮罩
 *
 * 关键在于算子永远读「原图」而不是「当前结果」，所以同一块区域反复施加
 * 同一个覆盖率，得到的结果完全一致 —— 增量刷新与一次性刷新等价，
 * 才能做到「边拖边看效果」而不必每帧重扫全图。
 */
import { cloneSurface, createSurface, mustCtx } from "./surface";

/* ------------------------------------------------------------------ 参数 */

export type RetouchMode =
  | "clone"
  | "heal"
  | "blur"
  | "sharpen"
  | "dodge"
  | "burn"
  | "sponge";

/** 海绵：降饱和 / 提饱和。 */
export type SpongeMode = "desaturate" | "saturate";
/** 减淡 / 加深的作用范围（与 PS 的「范围」一致）。 */
export type ToneRange = "shadows" | "midtones" | "highlights";

/** 修饰工具参数。 */
export interface RetouchSettings {
  /** 笔尖直径（像素） */
  size: number;
  /** 硬度 0–100：100 为实边，0 为完全羽化 */
  hardness: number;
  /** 力度 1–100：一笔扫过的最大强度 */
  strength: number;
  /** 间距 1–50（%）：相邻笔尖中心的距离占直径的百分比 */
  spacing: number;
  /** 当前修饰方式 */
  mode: RetouchMode;
  /** 海绵模式 */
  sponge: SpongeMode;
  /** 减淡 / 加深的范围 */
  range: ToneRange;
}

export const DEFAULT_RETOUCH: RetouchSettings = {
  size: 48,
  hardness: 50,
  strength: 50,
  spacing: 12,
  mode: "blur",
  sponge: "desaturate",
  range: "midtones",
};

/** 需要先「取样」才能用的修饰方式（仿制图章 / 修复画笔，PS 里是 Alt + 单击）。 */
export function needsSample(mode: RetouchMode): boolean {
  return mode === "clone" || mode === "heal";
}

/** 矩形（文档坐标，整数像素）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Pt {
  x: number;
  y: number;
}

/* ---------------------------------------------------------------- 数学 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 亮度（Rec.601），减淡 / 加深 / 海绵都要用。 */
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

const mixv = (a: number, b: number, t: number) => a + (b - a) * t;

/** 指数衰减 —— 与 libmypaint 一致的平滑基石。 */
function expDecay(timeConstant: number, t: number): number {
  if (timeConstant <= 0.001) return 0;
  return Math.exp(-t / timeConstant);
}

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

/** 压感 → 半径系数（与画笔同一张曲线，手感一致）。 */
const PRESSURE_RADIUS: Curve = [
  [0, 0.35],
  [0.25, 0.65],
  [0.5, 0.85],
  [0.75, 0.95],
  [1, 1],
];

/** 压感 → 力度系数。 */
const PRESSURE_STRENGTH: Curve = [
  [0, 0.45],
  [0.5, 0.9],
  [1, 1],
];

/** 力度按作用范围分配（与 PS 的「范围」一致）。 */
function toneWeight(l: number, range: ToneRange): number {
  if (range === "shadows") return clamp(1 - l / 255, 0, 1);
  if (range === "highlights") return clamp(l / 255, 0, 1);
  return clamp(1 - Math.abs(l - 127.5) / 127.5, 0, 1);
}

/* ---------------------------------------------------------------- 模糊 */

/**
 * 可分离箱式模糊（跑两遍逼近高斯）。
 *
 * 只在这里用一次的原因：修饰工具全都在「算子(原图)」这一侧工作，
 * 原图一笔之内不变，模糊结果自然一笔只算一次。半径与笔尖挂钩，
 * 大笔尖配大半径，小笔尖给的是细柔，不是一团糊。
 */
function boxBlur(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  passes = 2,
): Uint8ClampedArray {
  const r = Math.max(1, Math.round(radius));
  let cur = new Uint8ClampedArray(src);
  const tmp = new Uint8ClampedArray(src.length);
  for (let p = 0; p < passes; p += 1) {
    blurAxis(cur, tmp, w, h, r, true);
    blurAxis(tmp, cur, w, h, r, false);
  }
  return cur;
}

/** 沿一条轴做滑动窗平均；边缘按边界像素延拓。 */
function blurAxis(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  horizontal: boolean,
): void {
  const n = horizontal ? w : h;
  const outer = horizontal ? h : w;
  const win = radius * 2 + 1;
  const at = (s: number, i: number) =>
    horizontal ? (s * w + i) * 4 : (i * w + s) * 4;
  for (let s = 0; s < outer; s += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        sum += src[at(s, clamp(k, 0, n - 1)) + c];
      }
      for (let i = 0; i < n; i += 1) {
        dst[at(s, i) + c] = sum / win;
        sum +=
          src[at(s, clamp(i + radius + 1, 0, n - 1)) + c] -
          src[at(s, clamp(i - radius, 0, n - 1)) + c];
      }
    }
  }
}

/* ------------------------------------------------------------ 笔尖贴图 */

interface Tip {
  canvas: HTMLCanvasElement;
  radius: number;
}

/**
 * 覆盖率笔尖：一张纯白羽化圆盘。
 *
 * 覆盖率和颜色无关，一笔之内形状固定，所以一次画好、后面只做 drawImage，
 * 间距才敢压密。
 */
function makeCoverTip(radius: number, hardness: number): Tip {
  const R = Math.max(radius, 8);
  const d = Math.ceil(R * 2) + 2;
  const canvas = createSurface(d, d);
  const g = mustCtx(canvas);
  const c = d / 2;
  if (hardness >= 99) {
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.fill();
    return { canvas, radius: R };
  }
  const inner = Math.min(R * (hardness / 100), R - 0.01);
  const rg = g.createRadialGradient(c, c, Math.max(0, inner), c, c, R);
  rg.addColorStop(0, "rgba(255,255,255,1)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg;
  g.beginPath();
  g.arc(c, c, R, 0, Math.PI * 2);
  g.fill();
  return { canvas, radius: R };
}

/* ---------------------------------------------------------------- 骨架 */

const ACTUAL_RADIUS_MIN = 0.5;
const ACTUAL_RADIUS_MAX = 1000;
const MAX_DTIME = 5;
const MIN_DTIME = 0.0001;
/** 时间戳不可信时用的名义间隔（秒），取 120Hz 一帧的长度。 */
const NOMINAL_DTIME = 0.008;
const MAX_DABS_PER_EVENT = 4096;
const VECTOR_DAB_RADIUS = 2;
/** 覆盖率低于它的像素直接跳过（省掉大量 no-op 像素）。 */
const WEIGHT_EPS = 0.002;

const CODE: Record<RetouchMode, number> = {
  clone: 0,
  heal: 1,
  blur: 2,
  sharpen: 3,
  dodge: 4,
  burn: 5,
  sponge: 6,
};

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: x1 - x, height: y1 - y };
}

/**
 * 一次修饰笔画。
 *
 * 生命周期：begin → extend（若干次）→ finish；
 * 每次 `pull()` 把新落下的笔尖作用到结果画布并取走脏矩形，
 * 抬笔时再把 `result` 整张写回图层即可。
 */
export class RetouchStroke {
  private readonly w: number;
  private readonly h: number;
  private readonly settings: RetouchSettings;
  /** 原图（整笔不变的参考） */
  private readonly orig: Uint8ClampedArray;
  /** 结果像素（就地推进） */
  private readonly out: Uint8ClampedArray;
  private readonly outCanvas: HTMLCanvasElement;
  private readonly outCtx: CanvasRenderingContext2D;
  /** 覆盖率画布：alpha 即「扫过多少」 */
  private readonly cover: HTMLCanvasElement;
  private readonly coverCtx: CanvasRenderingContext2D;
  private readonly mask: HTMLCanvasElement | null;
  private readonly anchor: Pt | null;

  /* --- 由参数推导，一笔之内不变 --- */
  private readonly baseRadius: number;
  private readonly dabsPerActualRadius: number;
  private readonly strengthBase: number;
  private readonly tip: Tip;
  private readonly slowTracking = 4;
  private readonly slowTrackingPerDab = 2;
  private readonly blurRadius: number;
  private readonly healRadius: number;

  /* --- 懒算的一次性数据 --- */
  private blurData: Uint8ClampedArray | null = null;
  private softData: Uint8ClampedArray | null = null;

  /* --- 可变状态 --- */
  private x = 0;
  private y = 0;
  private pressure = 0.5;
  private ax = 0;
  private ay = 0;
  private ar = 1;
  private partial = 0;
  private lastTime = 0;
  private started = false;
  private lx = 0;
  private ly = 0;
  private lp = 0.5;
  /** 仿制 / 修复的取样偏移 */
  private offX = 0;
  private offY = 0;
  private sampled = false;
  /** 自上次 pull 以来新增笔尖覆盖的包围盒 */
  private dirty: Rect | null = null;

  constructor(
    layer: HTMLCanvasElement,
    settings: RetouchSettings,
    options: { anchor?: Pt | null; mask?: HTMLCanvasElement | null } = {},
  ) {
    this.w = layer.width;
    this.h = layer.height;
    this.settings = settings;
    this.mask = options.mask ?? null;
    this.anchor = options.anchor ?? null;

    const img = mustCtx(layer).getImageData(0, 0, this.w, this.h);
    this.orig = new Uint8ClampedArray(img.data);
    this.out = new Uint8ClampedArray(img.data);

    this.outCanvas = cloneSurface(layer);
    this.outCtx = mustCtx(this.outCanvas);
    this.cover = createSurface(this.w, this.h);
    this.coverCtx = mustCtx(this.cover);

    this.baseRadius = clamp(settings.size / 2, ACTUAL_RADIUS_MIN, ACTUAL_RADIUS_MAX);
    const spacingPct = clamp(settings.spacing, 1, 50);
    this.dabsPerActualRadius = 50 / spacingPct;
    this.strengthBase = clamp(settings.strength / 100, 0.01, 1);
    this.tip = makeCoverTip(this.baseRadius, settings.hardness);
    // 模糊半径跟笔尖走：细笔细柔、粗笔粗柔
    this.blurRadius = clamp(Math.round(this.baseRadius / 6), 1, 12);
    this.healRadius = clamp(Math.round(this.baseRadius / 3), 3, 48);
  }

  /** 结果画布（供界面即时回显）。 */
  get result(): HTMLCanvasElement {
    return this.outCanvas;
  }

  /** 本笔是否真的改动了像素（抬笔时据此决定要不要入历史）。 */
  get touched(): boolean {
    return this.changed;
  }

  private changed = false;

  /** 落笔：初始化状态并投下第一个笔尖。 */
  begin(x: number, y: number, pressure = 0.5, time = now()): void {
    this.x = x;
    this.y = y;
    this.pressure = clamp(pressure, 0, 1);
    this.ax = x;
    this.ay = y;
    this.ar = this.radiusFor(this.pressure);
    this.partial = 0;
    this.lastTime = time;
    this.lx = x;
    this.ly = y;
    this.lp = this.pressure;
    this.started = true;
    if (this.anchor && !this.sampled) {
      // 取样点与落笔点的差就是整笔的搬运偏移；之后源窗随笔尖一起走
      this.offX = Math.round(this.anchor.x - x);
      this.offY = Math.round(this.anchor.y - y);
      this.sampled = true;
    }
    this.drawDab();
  }

  /** 追加一个采样点。 */
  extend(x: number, y: number, pressure = 0.5, time = now()): void {
    if (!this.started) {
      this.begin(x, y, pressure, time);
      return;
    }
    let dtime = (time - this.lastTime) / 1000;
    this.lastTime = time;
    // 时间戳不可信（同值 / 0 / NaN）时退回名义间隔。绝不能退到 MIN_DTIME：
    // 那会把时间低通系数压到近乎 0，虚拟光标钉死原地，笔尖全挤成一堆孤点。
    if (!Number.isFinite(dtime) || dtime <= MIN_DTIME) dtime = NOMINAL_DTIME;
    if (dtime > MAX_DTIME) {
      this.begin(x, y, pressure, time);
      return;
    }
    this.strokeTo(x, y, clamp(pressure, 0, 1), dtime);
  }

  /** 主循环：虚拟光标时间低通 + 按间距投放笔尖。 */
  private strokeTo(x: number, y: number, pressure: number, dtime: number, snap = false): void {
    this.lx = x;
    this.ly = y;
    this.lp = pressure;

    const fac = snap ? 1 : 1 - expDecay(this.slowTracking, 100 * dtime);
    x = this.x + (x - this.x) * fac;
    y = this.y + (y - this.y) * fac;

    let dtimeLeft = dtime;
    let moved = this.partial;
    let todo = this.countDabsTo(x, y, dtime);
    let guard = 0;

    while (moved + todo >= 1 && guard < MAX_DABS_PER_EVENT) {
      guard += 1;
      let step: number;
      if (moved > 0) {
        step = 1 - moved;
        moved = 0;
      } else {
        step = 1;
      }
      const frac = step / todo;
      const stepDt = frac * dtimeLeft;
      this.updateStates(
        step,
        frac * (x - this.x),
        frac * (y - this.y),
        frac * (pressure - this.pressure),
        stepDt,
      );
      this.drawDab();
      dtimeLeft -= stepDt;
      todo = this.countDabsTo(x, y, dtimeLeft);
    }

    this.updateStates(todo, x - this.x, y - this.y, pressure - this.pressure, dtimeLeft);
    this.partial = moved + todo;
  }

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
    this.pressure = clamp(this.pressure + stepDp, 0, 1);
    this.ar = this.radiusFor(this.pressure);
    const fac = 1 - expDecay(this.slowTrackingPerDab, stepDdab);
    this.ax += (this.x - this.ax) * fac;
    this.ay += (this.y - this.ay) * fac;
  }

  private countDabsTo(x: number, y: number, dt: number): number {
    const dist = Math.hypot(x - this.x, y - this.y);
    return (
      (dist / this.ar) * this.dabsPerActualRadius +
      (dist / this.baseRadius) * 0 +
      dt * 0
    );
  }

  private radiusFor(pressure: number): number {
    return clamp(
      this.baseRadius * sampleCurve(PRESSURE_RADIUS, pressure),
      ACTUAL_RADIUS_MIN,
      ACTUAL_RADIUS_MAX,
    );
  }

  /** 投一个覆盖率笔尖，并把包围盒并进脏矩形。 */
  private drawDab(): void {
    let a = clamp(this.strengthBase * sampleCurve(PRESSURE_STRENGTH, this.pressure), 0, 1);
    // 与画笔同一套「dabs-per-pixel 线性化」：一个笔尖宽度扫过去，
    // 总覆盖率约等于力度，间距改动手感才不会变。
    let dabsPerPixel = this.dabsPerActualRadius * 2;
    if (dabsPerPixel < 1) dabsPerPixel = 1;
    dabsPerPixel = 1 + 0.5 * (dabsPerPixel - 1);
    a = 1 - Math.pow(1 - a, 1 / dabsPerPixel);

    const r = this.ar;
    const c = this.coverCtx;
    c.globalAlpha = a;
    if (r < VECTOR_DAB_RADIUS) {
      c.fillStyle = "#ffffff";
      c.beginPath();
      c.arc(this.ax, this.ay, r, 0, Math.PI * 2);
      c.fill();
    } else {
      const k = r / this.tip.radius;
      const size = this.tip.canvas.width * k;
      c.drawImage(this.tip.canvas, this.ax - size / 2, this.ay - size / 2, size, size);
    }
    c.globalAlpha = 1;
    this.growDirty(this.ax - r - 2, this.ay - r - 2, this.ax + r + 2, this.ay + r + 2);
  }

  private growDirty(x0: number, y0: number, x1: number, y1: number): void {
    const a = clamp(Math.floor(x0), 0, this.w);
    const b = clamp(Math.floor(y0), 0, this.h);
    const c = clamp(Math.ceil(x1), 0, this.w);
    const d = clamp(Math.ceil(y1), 0, this.h);
    if (c <= a || d <= b) return;
    const next = { x: a, y: b, width: c - a, height: d - b };
    const cur = this.dirty;
    if (!cur) {
      this.dirty = next;
      return;
    }
    const x = Math.min(cur.x, next.x);
    const y = Math.min(cur.y, next.y);
    const x1n = Math.max(cur.x + cur.width, next.x + next.width);
    const y1n = Math.max(cur.y + cur.height, next.y + next.height);
    this.dirty = { x, y, width: x1n - x, height: y1n - y };
  }

  /**
   * 抬笔收尾：把落后的虚拟光标吸附到最后一个输入点，补齐末尾的笔尖。
   * 不冲刷的话快拖的笔画末端会缺一截（与画笔同一处理）。
   */
  private flush(): void {
    if (!this.started) return;
    this.strokeTo(this.lx, this.ly, this.lp, MIN_DTIME, true);
    this.x = this.lx;
    this.y = this.ly;
    this.partial = 0;
  }

  /**
   * 把新落下的笔尖作用到结果画布，返回受影响矩形（无改动返回 null）。
   *
   * 界面每帧调一次即可：既做即时回显，也顺手把画面推进到最新状态。
   */
  pull(): Rect | null {
    const rect = this.dirty;
    if (!rect) return null;
    this.dirty = null;
    this.apply(rect);
    return rect;
  }

  /** 结束本笔（补末尾笔尖）；调用后仍需 pull() 才会落到画布上。 */
  finish(): void {
    this.flush();
  }

  /* -------------------------------------------------------- 像素算子 */

  private blurOf(): Uint8ClampedArray {
    if (!this.blurData) {
      this.blurData = boxBlur(this.orig, this.w, this.h, this.blurRadius, 2);
    }
    return this.blurData;
  }

  private softOf(): Uint8ClampedArray {
    if (!this.softData) {
      this.softData = boxBlur(this.orig, this.w, this.h, this.healRadius, 2);
    }
    return this.softData;
  }

  private apply(rect: Rect): void {
    const r = intersect(rect, { x: 0, y: 0, width: this.w, height: this.h });
    if (r.width <= 0 || r.height <= 0) return;

    const code = CODE[this.settings.mode];
    // 仿制 / 修复没取样就什么也不做，绝不猜一个源
    if ((code === 0 || code === 1) && !this.sampled) return;

    const cov = this.coverCtx.getImageData(r.x, r.y, r.width, r.height).data;
    const msk = this.mask
      ? mustCtx(this.mask).getImageData(r.x, r.y, r.width, r.height).data
      : null;
    const orig = this.orig;
    const out = this.out;
    const w = this.w;
    const h = this.h;
    const offX = this.offX;
    const offY = this.offY;
    const range = this.settings.range;
    const spongeAdd = this.settings.sponge === "saturate";
    const blur = code === 2 || code === 3 ? this.blurOf() : null;
    const soft = code === 1 ? this.softOf() : null;
    let changed = false;

    for (let ly = 0; ly < r.height; ly += 1) {
      const ay = r.y + ly;
      for (let lx = 0; lx < r.width; lx += 1) {
        const ci = (ly * r.width + lx) * 4;
        let weight = cov[ci + 3] / 255;
        if (msk) weight *= msk[ci + 3] / 255;
        if (weight <= WEIGHT_EPS) continue;

        const ai = (ay * w + lx + r.x) * 4;
        const br = orig[ai];
        const bg = orig[ai + 1];
        const bb = orig[ai + 2];

        if (code === 0) {
          // 仿制图章：从源窗搬同一块像素过来
          const sx = lx + r.x + offX;
          const sy = ay + offY;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const si = (sy * w + sx) * 4;
          out[ai] = mixv(br, orig[si], weight);
          out[ai + 1] = mixv(bg, orig[si + 1], weight);
          out[ai + 2] = mixv(bb, orig[si + 2], weight);
          out[ai + 3] = mixv(orig[ai + 3], orig[si + 3], weight);
        } else if (code === 1 && soft) {
          // 修复画笔：纹理仍旧取自源窗，颜色按「目标低频 − 源低频」对齐，
          // 于是接缝处的明暗自然咬合，不出现方块状补丁。
          const sx = lx + r.x + offX;
          const sy = ay + offY;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const si = (sy * w + sx) * 4;
          out[ai] = mixv(br, clamp(orig[si] + soft[ai] - soft[si], 0, 255), weight);
          out[ai + 1] = mixv(bg, clamp(orig[si + 1] + soft[ai + 1] - soft[si + 1], 0, 255), weight);
          out[ai + 2] = mixv(bb, clamp(orig[si + 2] + soft[ai + 2] - soft[si + 2], 0, 255), weight);
          out[ai + 3] = mixv(orig[ai + 3], orig[si + 3], weight);
        } else if (code === 2 && blur) {
          out[ai] = mixv(br, blur[ai], weight);
          out[ai + 1] = mixv(bg, blur[ai + 1], weight);
          out[ai + 2] = mixv(bb, blur[ai + 2], weight);
        } else if (code === 3 && blur) {
          // 锐化 = 反锐化遮罩：原图 + 1.1 ×（原图 − 模糊）
          out[ai] = mixv(br, clamp(br + (br - blur[ai]) * 1.1, 0, 255), weight);
          out[ai + 1] = mixv(bg, clamp(bg + (bg - blur[ai + 1]) * 1.1, 0, 255), weight);
          out[ai + 2] = mixv(bb, clamp(bb + (bb - blur[ai + 2]) * 1.1, 0, 255), weight);
        } else if (code === 4 || code === 5) {
          // 减淡 / 加深：按亮度落在哪个范围决定这一笔能推多远
          const k = weight * toneWeight(lum(br, bg, bb), range);
          if (k > WEIGHT_EPS) {
            const dir = code === 4 ? 1 : -1;
            out[ai] = clamp(br + (dir > 0 ? 255 - br : -br) * k, 0, 255);
            out[ai + 1] = clamp(bg + (dir > 0 ? 255 - bg : -bg) * k, 0, 255);
            out[ai + 2] = clamp(bb + (dir > 0 ? 255 - bb : -bb) * k, 0, 255);
          }
        } else if (code === 6) {
          // 海绵：朝灰点靠（降饱和）或朝灰点的反方向拉开（提饱和）
          const gray = lum(br, bg, bb);
          if (spongeAdd) {
            out[ai] = clamp(gray + (br - gray) * (1 + weight), 0, 255);
            out[ai + 1] = clamp(gray + (bg - gray) * (1 + weight), 0, 255);
            out[ai + 2] = clamp(gray + (bb - gray) * (1 + weight), 0, 255);
          } else {
            out[ai] = mixv(br, gray, weight);
            out[ai + 1] = mixv(bg, gray, weight);
            out[ai + 2] = mixv(bb, gray, weight);
          }
        } else {
          continue;
        }
        changed = true;
      }
    }

    if (!changed) return;
    this.changed = true;
    this.putRect(r);
  }

  /** 把结果像素里的一小块写回结果画布。 */
  private putRect(r: Rect): void {
    const sub = new ImageData(r.width, r.height);
    for (let ly = 0; ly < r.height; ly += 1) {
      const from = ((r.y + ly) * this.w + r.x) * 4;
      sub.data.set(this.out.subarray(from, from + r.width * 4), ly * r.width * 4);
    }
    this.outCtx.putImageData(sub, r.x, r.y);
  }
}
