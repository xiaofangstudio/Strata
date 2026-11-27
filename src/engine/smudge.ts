/**
 * 涂抹工具（smudge）。
 *
 * 画笔是「加」、橡皮是「减」、涂抹是「推」：每一颗笔尖先从**当前画布**
 * （含这一笔已经推过去的颜色）取一小块平均色，再把这个颜色按笔尖形状
 * 盖到当前位置。因为取样源是实时变化的，颜色会沿轨迹被一路带下去，
 * 得到的是真正的混色过渡，不是模糊滤镜冒充的。
 */
import { createSurface, mustCtx, readPixels } from "./surface";
import { radialPoints, type RadialConfig } from "../core/radialSymmetry";

export interface SmudgeSettings {
  /** 笔尖直径（文档像素） */
  size: number;
  /** 硬度 0–100：100 实边，0 完全羽化 */
  hardness: number;
  /** 流量 1–100：单颗笔尖浓度 */
  flow: number;
  /** 推挤强度 0–100：每次落笔尖混合多少取样色 */
  strength: number;
  /** 笔尖旋转角 −180…180 度；与 roundness < 100% 配合才可见 */
  angle?: number;
  /** 笔尖短轴 / 长轴百分比 1–100；100 为正圆 */
  roundness?: number;
  /** 径向对称参数；有值时每个笔尖按扇区同时推挤 */
  radial?: RadialConfig | null;
}

export interface SmudgeTipShape {
  angleDeg?: number;
  /** 1–100，100 为正圆 */
  roundness?: number;
}

/** 把角度规整到 −180…180 的整数；与画笔预设的整数角度口径一致。 */
export function normSmudgeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const rounded = Math.round(deg);
  const wrapped = (((rounded + 180) % 360) + 360) % 360;
  return wrapped - 180;
}

/**
 * 旋转椭圆的归一化距离：≤1 在笔尖内。
 * angle=0 且 roundness=100 时退化为正圆；短轴比例让角度真正改变取样 / 落笔形状。
 */
export function rotatedTipNorm(
  dx: number,
  dy: number,
  radius: number,
  shape?: SmudgeTipShape | null,
): number {
  const r = Math.max(0.5, radius);
  const angle = normSmudgeAngle(shape?.angleDeg ?? 0);
  const ratio = Math.max(0.01, Math.min(1, (shape?.roundness ?? 100) / 100));
  if (angle === 0) return Math.hypot(dx, dy / ratio) / r;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // 局部坐标 = R(-angle) · delta
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  return Math.hypot(lx, ly / ratio) / r;
}

/** 圆形范围内取平均色；范围外、透明像素参与会拉低颜色，故按 alpha 加权。 */
export function sampleAvg(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  shape?: SmudgeTipShape | null,
): [number, number, number, number] {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sa = 0;
  let weight = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (rotatedTipNorm(x - cx, y - cy, r, shape) > 1) continue;
      const i = (y * w + x) * 4;
      const a = data[i + 3] / 255;
      // 透明像素权重极低：空白画布不该把取样色稀释成黑色
      const wt = 0.02 + a;
      sr += data[i] * wt;
      sg += data[i + 1] * wt;
      sb += data[i + 2] * wt;
      sa += data[i + 3] * wt;
      weight += wt;
    }
  }
  if (weight === 0) return [0, 0, 0, 0];
  return [sr / weight, sg / weight, sb / weight, sa / weight];
}

/** 笔尖内的衰减：硬度以内满强度，边缘按 1.5 次幂羽化。 */
export function dabFalloff(dist: number, radius: number, hardness: number): number {
  if (dist >= radius) return 0;
  const edge = Math.max(0, Math.min(1, hardness / 100));
  const t = dist / radius;
  if (t <= edge) return 1;
  if (edge >= 1) return 0;
  return (1 - (t - edge) / (1 - edge)) ** 1.5;
}

/** 与 dabFalloff 同曲线的归一化版本，供旋转椭圆笔尖直接传 norm。 */
function dabFalloffNorm(norm: number, hardness: number): number {
  const edge = Math.max(0, Math.min(1, hardness / 100));
  if (norm >= 1) return 0;
  if (norm <= edge) return 1;
  if (edge >= 1) return 0;
  return (1 - (norm - edge) / (1 - edge)) ** 1.5;
}

/** 把颜色按笔尖形状混进像素数组（原地）。 */
export function smudgeStamp(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  color: readonly [number, number, number, number],
  amount: number,
  hardness: number,
  mask?: Uint8ClampedArray | null,
  shape?: SmudgeTipShape | null,
): void {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const fall = shape
        ? dabFalloffNorm(rotatedTipNorm(x - cx, y - cy, r, shape), hardness)
        : dabFalloff(Math.hypot(x - cx, y - cy), r, hardness);
      if (fall <= 0) continue;
      const i = (y * w + x) * 4;
      if (mask && mask[i + 3] < 8) continue;
      const a = Math.min(0.5, Math.max(0, amount * fall));
      data[i] += (color[0] - data[i]) * a;
      data[i + 1] += (color[1] - data[i + 1]) * a;
      data[i + 2] += (color[2] - data[i + 2]) * a;
      data[i + 3] += (color[3] - data[i + 3]) * a;
    }
  }
}

/**
 * 把一笔尖写进透明增量画布（source-over），而不是直接改底图。
 * 这样浮层预览只显示被推过的像素，图层不透明度 / 混合模式也不会被预览破坏。
 */
export function smudgeDeltaStamp(
  delta: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  color: readonly [number, number, number, number],
  amount: number,
  hardness: number,
  mask?: Uint8ClampedArray | null,
  shape?: SmudgeTipShape | null,
): void {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  const sa = Math.max(0, Math.min(1, color[3] / 255));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const fall = shape
        ? dabFalloffNorm(rotatedTipNorm(x - cx, y - cy, r, shape), hardness)
        : dabFalloff(Math.hypot(x - cx, y - cy), r, hardness);
      if (fall <= 0) continue;
      const i = (y * w + x) * 4;
      if (mask && mask[i + 3] < 8) continue;
      const src = Math.min(0.5, Math.max(0, amount * fall)) * sa;
      if (src <= 0) continue;
      const dst = delta[i + 3] / 255;
      const out = src + dst * (1 - src);
      if (out <= 0) continue;
      delta[i] = (color[0] * src + delta[i] * dst * (1 - src)) / out;
      delta[i + 1] = (color[1] * src + delta[i + 1] * dst * (1 - src)) / out;
      delta[i + 2] = (color[2] * src + delta[i + 2] * dst * (1 - src)) / out;
      delta[i + 3] = out * 255;
    }
  }
}

export class SmudgeStroke {
  private readonly w: number;
  private readonly h: number;
  /** 当前画布像素（取样源，一笔之内实时更新） */
  private readonly data: Uint8ClampedArray;
  /** 只含被推过区域的增量像素（预览 / 落库都用它） */
  private readonly delta: Uint8ClampedArray;
  private readonly maskData: Uint8ClampedArray | null;
  private readonly settings: SmudgeSettings;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private lx = 0;
  private ly = 0;
  private started = false;

  constructor(
    source: HTMLCanvasElement,
    settings: SmudgeSettings,
    mask: HTMLCanvasElement | null = null,
  ) {
    this.w = source.width;
    this.h = source.height;
    this.settings = settings;
    this.data = new Uint8ClampedArray(readPixels(source).data);
    this.delta = new Uint8ClampedArray(this.w * this.h * 4);
    this.maskData = mask ? new Uint8ClampedArray(readPixels(mask).data) : null;
    this.canvas = createSurface(this.w, this.h);
    this.ctx = mustCtx(this.canvas);
  }

  /** 预览画布：与 Stroke.buffer 一样叠在合成结果上，所见即所得。 */
  get buffer(): HTMLCanvasElement {
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(this.delta), this.w, this.h), 0, 0);
    return this.canvas;
  }

  private dab(x: number, y: number, radius: number, pressure: number): void {
    const r = Math.max(1, (radius / 2) * (0.4 + pressure * 0.6));
    const amount =
      (this.settings.strength / 100) *
      (this.settings.flow / 100) *
      (0.25 + pressure * 0.75);
    const shape: SmudgeTipShape = {
      angleDeg: this.settings.angle ?? 0,
      roundness: this.settings.roundness ?? 100,
    };
    const cfg = this.settings.radial;
    const points = cfg
      ? radialPoints(x, y, {
          ...cfg,
          center: cfg.center ?? { x: this.w / 2, y: this.h / 2 },
        })
      : [{ x, y }];
    for (const p of points) {
      // 每个扇区各自取样：颜色沿各自方向被推走，不是把同一个颜色贴 N 份
      const color = sampleAvg(this.data, this.w, this.h, p.x, p.y, Math.max(1, r * 0.7), shape);
      smudgeDeltaStamp(
        this.delta,
        this.w,
        this.h,
        p.x,
        p.y,
        r,
        color,
        amount,
        this.settings.hardness,
        this.maskData,
        shape,
      );
      // 取样源同步推进：下一颗笔尖取到的就是刚刚被推过去的颜色
      smudgeStamp(
        this.data,
        this.w,
        this.h,
        p.x,
        p.y,
        r,
        color,
        amount,
        this.settings.hardness,
        this.maskData,
        shape,
      );
    }
  }

  begin(x: number, y: number, pressure = 0.5): void {
    this.lx = x;
    this.ly = y;
    this.started = true;
    this.dab(x, y, this.settings.size, pressure);
  }

  extend(x: number, y: number, pressure = 0.5): void {
    if (!this.started) return this.begin(x, y, pressure);
    const step = Math.max(1, this.settings.size * 0.12);
    const dx = x - this.lx;
    const dy = y - this.ly;
    const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
    for (let i = 1; i <= count; i += 1) {
      const t = i / count;
      this.dab(this.lx + dx * t, this.ly + dy * t, this.settings.size, pressure);
    }
    this.lx = x;
    this.ly = y;
  }

  /** 抬笔落库：先按选区裁一次，透明处不覆盖原图层。 */
  finish(target: HTMLCanvasElement): void {
    if (!this.started) return;
    const masked = createSurface(this.w, this.h);
    const mc = mustCtx(masked);
    mc.drawImage(this.buffer, 0, 0);
    if (this.maskData) {
      const maskCanvas = createSurface(this.w, this.h);
      mustCtx(maskCanvas).putImageData(
        new ImageData(new Uint8ClampedArray(this.maskData), this.w, this.h),
        0,
        0,
      );
      mc.save();
      mc.globalCompositeOperation = "destination-in";
      mc.drawImage(maskCanvas, 0, 0);
      mc.restore();
    }
    mustCtx(target).drawImage(masked, 0, 0);
    this.started = false;
  }
}
