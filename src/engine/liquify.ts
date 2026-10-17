/**
 * 液化内核（推 / 膨胀 / 收缩 / 旋转 / 重建）。
 *
 * 与修饰工具最大的不同：液化**不就地改像素**，而是维护一张「位移场」——
 * 每个像素记录「该从原图的哪个位置取色」。这样做有三个好处：
 *
 *   1. 反复涂抹不糊。每次都从同一张原图重采样，来回推十遍和推一遍一样干净，
 *      就地改像素则会一轮轮插值，边缘很快烂掉。
 *   2. 「重建画笔」才有意义。要还原就得有「原来的样子」可回，位移场朝 0 收敛
 *      即可，无需另存快照。
 *   3. 可实时预览。位移场只在本笔尖半径内变化，重建也只重算那一小块，
 *      不必每帧重扫全图。
 *
 * 位移场按「反向映射」定义：`out(p) = src(p + d(p))`。反向映射保证目标图
 * 每个像素都能取到值（正向映射会在拉伸区留空洞），代价只是「往外推」时
 * 边界像素被拉长 —— 与 PS 的表现一致。
 *
 * 本文件不碰画布、不碰 DOM：只认「RGBA 字节 + 宽高」，于是它既能在无 DOM 的
 * 测试环境里跑，也能被绘画侧复用（同一套形变可以拿去当笔刷动力学的底层）。
 */
import {
  cloneRaster,
  createRaster,
  intersectRect,
  type Raster,
  type Rect,
  sampleBilinear,
} from "./raster";

/* ------------------------------------------------------------------ 参数 */

export type LiquifyMode = "push" | "bloat" | "pinch" | "twirl" | "restore";

/** 液化工具参数。 */
export interface LiquifySettings {
  /** 笔尖直径（像素） */
  size: number;
  /** 硬度 0–100：100 为实边（影响范围像印章），0 为从中心就开始衰减 */
  hardness: number;
  /** 力度 1–100 */
  strength: number;
  /** 间距 1–50（%）：相邻笔尖中心的距离占直径的百分比 */
  spacing: number;
  /** 当前模式 */
  mode: LiquifyMode;
}

export const DEFAULT_LIQUIFY: LiquifySettings = {
  size: 120,
  hardness: 50,
  strength: 50,
  spacing: 12,
  mode: "push",
};

/** 五种模式的介绍文案（界面用，集中放这里免得两处对不上）。 */
export const LIQUIFY_MODES: readonly LiquifyMode[] = [
  "push",
  "bloat",
  "pinch",
  "twirl",
  "restore",
];

/* -------------------------------------------------------------- 位移场 */

/** 每像素一个二维偏移（单位：像素）。 */
export interface LiquifyField {
  width: number;
  height: number;
  dx: Float32Array;
  dy: Float32Array;
}

/** 建一张恒等（全零）位移场。 */
export function createField(width: number, height: number): LiquifyField {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return { width: w, height: h, dx: new Float32Array(w * h), dy: new Float32Array(w * h) };
}

/** 深拷贝位移场。 */
export function cloneField(f: LiquifyField): LiquifyField {
  return {
    width: f.width,
    height: f.height,
    dx: new Float32Array(f.dx),
    dy: new Float32Array(f.dy),
  };
}

/** 位移场是否等于恒等（用来判断「这一笔到底动没动像素」）。 */
export function fieldIsIdentity(f: LiquifyField, eps = 0.01): boolean {
  const { dx, dy } = f;
  for (let i = 0; i < dx.length; i += 1) {
    if (dx[i] > eps || dx[i] < -eps || dy[i] > eps || dy[i] < -eps) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- 重建 */

/**
 * 按位移场把 `src` 重采样进 `dst`（两者尺寸必须一致）。
 *
 * `rect` 限定时只重算该矩形，界面每帧只重建笔尖扫过的那一块。
 * 越界采样按边缘夹取（见 `sampleBilinear`），所以往外推不会在边界外
 * 取到透明像素，形变不会顺带啃掉画布边缘。
 */
export function warpInto(
  src: Raster,
  field: LiquifyField,
  dst: Raster,
  rect?: Rect,
): void {
  const w = src.width;
  const h = src.height;
  const r: Rect = rect
    ? intersectRect(rect, { x: 0, y: 0, width: w, height: h })
    : { x: 0, y: 0, width: w, height: h };
  if (r.width <= 0 || r.height <= 0) return;
  const { dx, dy } = field;
  const tmp = new Float32Array(4);
  for (let y = r.y; y < r.y + r.height; y += 1) {
    const row = y * w;
    for (let x = r.x; x < r.x + r.width; x += 1) {
      const i = row + x;
      sampleBilinear(src, x + dx[i], y + dy[i], tmp);
      const o = i * 4;
      dst.data[o] = tmp[0];
      dst.data[o + 1] = tmp[1];
      dst.data[o + 2] = tmp[2];
      dst.data[o + 3] = tmp[3];
    }
  }
}

/** 一次性重建整张图（非交互路径用，比如「确定」时落盘）。 */
export function warp(src: Raster, field: LiquifyField): Raster {
  const dst = createRaster(src.width, src.height);
  warpInto(src, field, dst);
  return dst;
}

/* -------------------------------------------------------------- 笔尖几何 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 指数衰减 —— 与画笔 / 修饰工具同一套平滑基石。 */
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

/* ---------------------------------------------------------------- 骨架 */

const ACTUAL_RADIUS_MIN = 0.5;
const ACTUAL_RADIUS_MAX = 1000;
const MAX_DTIME = 5;
const MIN_DTIME = 0.0001;
/** 时间戳不可信时用的名义间隔（秒），取 120Hz 一帧的长度。 */
const NOMINAL_DTIME = 0.008;
const MAX_DABS_PER_EVENT = 4096;
/** 单个笔尖相对半径的位移上限：拖再快也不会把一个笔尖甩出去半张图。 */
const PUSH_MAX = 0.75;
/** 膨胀 / 收缩单个笔尖的极限位移（占半径比例）。 */
const BLOOM_STEP = 0.08;
/** 旋转单个笔尖的极限角度（弧度）。 */
const TWIRL_STEP = 0.16;

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** 影响力权重：中心 1、半径处 0，且边界一阶导为 0（不留圆环接缝）。 */
function influence(dist: number, radius: number, hardness: number): number {
  if (radius <= 0 || dist >= radius) return 0;
  // 硬度越高羽化带越窄；全硬时仍留 2% 的过渡带，否则边缘会是硬台阶。
  const band = Math.max(0.02, 1 - clamp(hardness, 0, 100) / 100);
  const u = clamp((1 - dist / radius) / band, 0, 1);
  // smoothstep：自身与一阶导在两端都连续
  return u * u * (3 - 2 * u);
}

/**
 * 一次液化笔画。
 *
 * 生命周期：begin → extend（若干次）→ finish；每次 `pull()` 把新落下的笔尖
 * 作用到位移场、重建脏矩形，抬笔时把 `result` 整张写回图层即可。
 *
 * 位移场可以由外部传入（`options.field`），这样「上次液化还没确定时再拖一笔」
 * 能接着上一笔累积，而不是每次重开都要从头推。
 */
export class LiquifyStroke {
  private readonly src: Raster;
  private readonly settings: LiquifySettings;
  private readonly outRaster: Raster;
  private readonly fieldRef: LiquifyField;
  private readonly baseRadius: number;
  private readonly dabsPerActualRadius: number;
  private readonly strengthBase: number;
  private readonly slowTracking = 4;
  private readonly slowTrackingPerDab = 2;

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
  /** 上一个真正落下笔尖的位置：推模式按「两笔尖之间的位移」搬运像素。 */
  private dabX = 0;
  private dabY = 0;
  private dirty: Rect | null = null;
  private changed = false;

  constructor(
    src: Raster,
    settings: LiquifySettings,
    options: { field?: LiquifyField } = {},
  ) {
    this.src = src;
    this.settings = settings;
    this.outRaster = cloneRaster(src);
    this.fieldRef = options.field ?? createField(src.width, src.height);

    this.baseRadius = clamp(settings.size / 2, ACTUAL_RADIUS_MIN, ACTUAL_RADIUS_MAX);
    const spacingPct = clamp(settings.spacing, 1, 50);
    this.dabsPerActualRadius = 50 / spacingPct;
    this.strengthBase = clamp(settings.strength / 100, 0.01, 1);
  }

  /** 当前结果像素（供界面即时回显）。 */
  get result(): Raster {
    return this.outRaster;
  }

  /** 当前位移场（供界面保存 / 继续涂抹）。 */
  get field(): LiquifyField {
    return this.fieldRef;
  }

  /** 本笔是否真的动过像素（抬笔时据此决定要不要入历史）。 */
  get touched(): boolean {
    return this.changed;
  }

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
    this.dabX = x;
    this.dabY = y;
    this.started = true;
    this.drawDab(0, 0);
  }

  /** 追加一个采样点。 */
  extend(x: number, y: number, pressure = 0.5, time = now()): void {
    if (!this.started) {
      this.begin(x, y, pressure, time);
      return;
    }
    let dtime = (time - this.lastTime) / 1000;
    const usable = Number.isFinite(dtime) && dtime > MIN_DTIME && dtime <= MAX_DTIME;
    // 时间戳不可信时退回名义间隔，但绝不退化到「逐个采样点吸附」——
    // 那会把虚拟光标钉死原地，笔尖全挤成一堆孤点（与画笔同一坑）。
    if (!usable) dtime = NOMINAL_DTIME;
    this.lastTime = time;
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
      this.drawDab(this.x - this.dabX, this.y - this.dabY);
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
    return (dist / this.ar) * this.dabsPerActualRadius + dt * 0;
  }

  private radiusFor(pressure: number): number {
    return clamp(
      this.baseRadius * sampleCurve(PRESSURE_RADIUS, pressure),
      ACTUAL_RADIUS_MIN,
      ACTUAL_RADIUS_MAX,
    );
  }

  /**
   * 在虚拟光标处作用一个笔尖。
   *
   * `mx / my` 是「自上一个笔尖以来输入移动了多少」：推模式直接按这段位移搬运
   * 像素，于是整笔的总搬运量恰好等于拖动距离 × 力度 —— 拖多远就推多远，
   * 手感与 PS 的「推移」一致，也不会因为间距调小而越推越猛。
   */
  private drawDab(mx: number, my: number): void {
    const r = this.ar;
    const strength =
      this.strengthBase * sampleCurve(PRESSURE_STRENGTH, this.pressure);
    const hardness = this.settings.hardness;
    const mode = this.settings.mode;

    // 单笔尖的位移上限：拖太快时按比例截断，避免位移场被一次甩出巨大畸变
    const moveLen = Math.hypot(mx, my);
    const moveMax = r * PUSH_MAX;
    let mvx = mx;
    let mvy = my;
    if (mode === "push" && moveLen > moveMax && moveLen > 0) {
      const k = moveMax / moveLen;
      mvx *= k;
      mvy *= k;
    }

    const cx = this.ax;
    const cy = this.ay;
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(this.src.width - 1, Math.ceil(cx + r));
    const y1 = Math.min(this.src.height - 1, Math.ceil(cy + r));
    if (x1 < x0 || y1 < y0) return;

    const { dx, dy } = this.fieldRef;
    const w = this.src.width;
    let changed = false;

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const ux = x - cx;
        const uy = y - cy;
        const dist = Math.hypot(ux, uy);
        const inf = influence(dist, r, hardness);
        if (inf <= 0) continue;
        const i = y * w + x;

        if (mode === "push") {
          dx[i] -= mvx * inf * strength;
          dy[i] -= mvy * inf * strength;
        } else if (mode === "restore") {
          const k = clamp(inf * strength, 0, 1);
          dx[i] -= dx[i] * k;
          dy[i] -= dy[i] * k;
        } else {
          if (dist < 0.5) continue; // 笔尖正中心没有方向可言
          const nx = ux / dist;
          const ny = uy / dist;
          if (mode === "bloat" || mode === "pinch") {
            const amt = r * BLOOM_STEP * strength * inf * (mode === "bloat" ? 1 : -1);
            dx[i] -= nx * amt;
            dy[i] -= ny * amt;
          } else {
            // 旋转：把「中心指向该像素」的向量转过去，位移就是新旧之差
            const ang = TWIRL_STEP * strength * inf;
            const ca = Math.cos(ang);
            const sa = Math.sin(ang);
            const rx = ux * ca - uy * sa;
            const ry = ux * sa + uy * ca;
            dx[i] -= rx - ux;
            dy[i] -= ry - uy;
          }
        }
        changed = true;
      }
    }

    if (changed) this.changed = true;
    this.dabX = this.x;
    this.dabY = this.y;
    this.growDirty(cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2);
  }

  private growDirty(x0: number, y0: number, x1: number, y1: number): void {
    const { width: w, height: h } = this.src;
    const a = clamp(Math.floor(x0), 0, w);
    const b = clamp(Math.floor(y0), 0, h);
    const c = clamp(Math.ceil(x1), 0, w);
    const d = clamp(Math.ceil(y1), 0, h);
    if (c <= a || d <= b) return;
    const next: Rect = { x: a, y: b, width: c - a, height: d - b };
    const cur = this.dirty;
    if (!cur) {
      this.dirty = next;
      return;
    }
    const x = Math.min(cur.x, next.x);
    const y = Math.min(cur.y, next.y);
    const xn = Math.max(cur.x + cur.width, next.x + next.width);
    const yn = Math.max(cur.y + cur.height, next.y + next.height);
    this.dirty = { x, y, width: xn - x, height: yn - y };
  }

  /**
   * 抬笔收尾：把落后的虚拟光标吸附到最后一个输入点，补齐末尾笔尖。
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
   * 把新落下的笔尖重建到结果像素上，返回受影响矩形（无改动返回 null）。
   * 界面每帧调一次即可。
   */
  pull(): Rect | null {
    const rect = this.dirty;
    if (!rect) return null;
    this.dirty = null;
    warpInto(this.src, this.fieldRef, this.outRaster, rect);
    return rect;
  }

  /** 结束本笔（补末尾笔尖）；调用后仍需 pull() 才会重建到画布上。 */
  finish(): void {
    this.flush();
  }
}

/**
 * 一次性对整张图应用一组位移场操作（非交互路径）。
 *
 * `ops` 里每个元素是一次笔尖涂抹：给出中心、半径、影响力与位移方向。
 * 便利函数，供「脚本化形变」与测试使用。
 */
export interface LiquifyOp {
  x: number;
  y: number;
  radius: number;
  /** 0–1，笔尖中心的影响力 */
  power: number;
  mode: LiquifyMode;
  /** 推模式的位移方向（像素）；其余模式用作方向参考 */
  dx?: number;
  dy?: number;
  /** 旋转模式的角度（弧度） */
  angle?: number;
  /** 硬度 0–100 */
  hardness?: number;
}

export function applyLiquifyOps(src: Raster, field: LiquifyField, ops: readonly LiquifyOp[]): void {
  const { dx, dy } = field;
  const w = src.width;
  const h = src.height;
  for (const op of ops) {
    const r = op.radius;
    const hardness = op.hardness ?? 50;
    const x0 = Math.max(0, Math.floor(op.x - r));
    const y0 = Math.max(0, Math.floor(op.y - r));
    const x1 = Math.min(w - 1, Math.ceil(op.x + r));
    const y1 = Math.min(h - 1, Math.ceil(op.y + r));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const ux = x - op.x;
        const uy = y - op.y;
        const dist = Math.hypot(ux, uy);
        const inf = influence(dist, r, hardness) * op.power;
        if (inf <= 0) continue;
        const i = y * w + x;
        if (op.mode === "push") {
          dx[i] -= (op.dx ?? 0) * inf;
          dy[i] -= (op.dy ?? 0) * inf;
        } else if (op.mode === "restore") {
          dx[i] -= dx[i] * inf;
          dy[i] -= dy[i] * inf;
        } else if (dist < 0.5) {
          continue;
        } else {
          const nx = ux / dist;
          const ny = uy / dist;
          if (op.mode === "bloat" || op.mode === "pinch") {
            const amt = r * BLOOM_STEP * inf * (op.mode === "bloat" ? 1 : -1);
            dx[i] -= nx * amt;
            dy[i] -= ny * amt;
          } else {
            const ang = (op.angle ?? TWIRL_STEP) * inf;
            const ca = Math.cos(ang);
            const sa = Math.sin(ang);
            const rx = ux * ca - uy * sa;
            const ry = ux * sa + uy * ca;
            dx[i] -= rx - ux;
            dy[i] -= ry - uy;
          }
        }
      }
    }
  }
}

/** 供外部直接取用衰减曲线（界面画笔尖预览时用得到）。 */
export { falloff as liquifyFalloff } from "./raster";
