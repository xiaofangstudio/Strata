/**
 * 界面动效数学原语（纯函数，不碰任何浏览器 API）。
 *
 * 把「缓动 / 补间 / 惯性平移 / 双指手势」从 10000+ 行的 EditorShell 里抽出来，
 * 好处有三：能单测、能在 TS 与 CSS 两套动效间共用同一组参数、reduced-motion
 * 时只要把 duration 调 0 就自动收敛成瞬时跳变。
 *
 * 设计参考 PhotoCraft 的 `flick_pan.rs`（指数摩擦 TAU=0.18s）与
 * `wheel_nav.rs`（NOTCH=1.1、no easing），但补上它明确标注缺失的
 * 「Animated zoom」与双指手势的连续插值。
 */

export type EasingFn = (t: number) => number;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 常用缓动。t 会被夹到 [0,1]，所有曲线保证 f(0)=0、f(1)=1。 */
export const EASING: Record<string, EasingFn> = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** 轻微回弹，只用于用户主动触发的反馈 */
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export interface Tween {
  readonly from: number;
  readonly to: number;
  readonly duration: number;
  readonly easing: EasingFn;
  /** elapsed 单位 ms；duration<=0 时直接返回 to（动效关闭时的瞬时收敛） */
  sample(elapsed: number): number;
  done(elapsed: number): boolean;
}

export function createTween(
  from: number,
  to: number,
  duration = 180,
  easing: EasingFn = EASING.outCubic,
): Tween {
  const d = Math.max(0, duration);
  return {
    from,
    to,
    duration: d,
    easing,
    sample(elapsed: number): number {
      if (d <= 0 || from === to) return to;
      const t = clamp(elapsed / d, 0, 1);
      return lerp(from, to, easing(t));
    },
    done(elapsed: number): boolean {
      return d <= 0 || elapsed >= d || from === to;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 画布缩放：把离散 ×1.1 步进换成带缓动的连续插值
 * ------------------------------------------------------------------ */

/** 滚轮一个刻度对应的倍率（对齐 PhotoCraft wheel_nav.rs NOTCH）。 */
export const ZOOM_NOTCH = 1.1;

/** n 个刻度的目标倍率；n 为负表示缩小。 */
export function zoomSteps(base: number, notches: number): number {
  return base * Math.pow(ZOOM_NOTCH, notches);
}

export interface ZoomAnim {
  from: number;
  to: number;
  elapsed: number;
  duration: number;
}

/** 开一段缩放动画；duration=0 表示动效关闭，调用方应直接取 to。 */
export function startZoom(from: number, to: number, duration = 160): ZoomAnim {
  return { from, to, elapsed: 0, duration: Math.max(0, duration) };
}

/** 推进一帧。返回新的动画状态（不可变）与当前应显示的倍率。 */
export function stepZoom(anim: ZoomAnim, dt: number): { anim: ZoomAnim; scale: number; done: boolean } {
  if (anim.duration <= 0) {
    return { anim, scale: anim.to, done: true };
  }
  const elapsed = anim.elapsed + Math.max(0, dt);
  const tween = createTween(anim.from, anim.to, anim.duration, EASING.outCubic);
  const done = tween.done(elapsed);
  return {
    anim: { ...anim, elapsed },
    scale: tween.sample(elapsed),
    done,
  };
}

/* ------------------------------------------------------------------ *
 * 惯性平移（flick pan）：指数摩擦的精确积分
 *    decay = exp(-dt/TAU)，位移 = v * TAU * (1 - decay)
 * ------------------------------------------------------------------ */

export const FLICK_TAU = 0.18; // 秒，时间常数
export const FLICK_MIN_START = 150; // pt/s，低于此速度不启动
export const FLICK_MIN_SPEED = 15; // pt/s，低于此速度停止
export const FLICK_MAX_SPEED = 6000; // pt/s，上限
export const FLICK_WINDOW = 0.08; // 秒，速度采样窗口
export const FLICK_MAX_DT = 0.1; // 秒，单帧最大步长

export interface FlickState {
  vx: number;
  vy: number;
}

export interface PointerSample {
  x: number;
  y: number;
  t: number; // 毫秒时间戳
}

/** 由最近一小段指针轨迹估计松手瞬间的速度（pt/s）。样本不足返回零速度。 */
export function flickFromSamples(samples: PointerSample[]): FlickState {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  // 取窗口内最早的那个样本，避免用整段历史把速度摊薄
  let first = samples[0];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > FLICK_WINDOW * 1000) break;
    first = samples[i];
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0.001) return { vx: 0, vy: 0 };
  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < FLICK_MIN_START) return { vx: 0, vy: 0 };
  if (speed > FLICK_MAX_SPEED) {
    const k = FLICK_MAX_SPEED / speed;
    vx *= k;
    vy *= k;
  }
  return { vx, vy };
}

/** 推进一帧惯性，返回本帧位移与衰减后的速度。dt 单位秒。 */
export function stepFlick(
  state: FlickState,
  dt: number,
  tau = FLICK_TAU,
): { dx: number; dy: number; next: FlickState; done: boolean } {
  const step = clamp(dt, 0, FLICK_MAX_DT);
  const decay = Math.exp(-step / tau);
  const dx = state.vx * tau * (1 - decay);
  const dy = state.vy * tau * (1 - decay);
  const vx = state.vx * decay;
  const vy = state.vy * decay;
  const done = Math.hypot(vx, vy) < FLICK_MIN_SPEED;
  return { dx, dy, next: { vx, vy }, done };
}

/* ------------------------------------------------------------------ *
 * 双指手势（pinch / rotate）：纯几何，吃两指坐标吐连续增量
 * ------------------------------------------------------------------ */

export interface Point {
  x: number;
  y: number;
}

export interface PinchMetrics {
  distance: number;
  angleDeg: number;
  centerX: number;
  centerY: number;
}

export function pinchMetrics(a: Point, b: Point): PinchMetrics {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    distance: Math.hypot(dx, dy),
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
    centerX: (a.x + b.x) / 2,
    centerY: (a.y + b.y) / 2,
  };
}

/** 把角度差归一到 (-180,180]，避免跨 ±180° 时旋转突然跳一整圈。 */
export function normalizeAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export interface PinchDelta {
  scale: number;
  rotationDeg: number;
  dx: number;
  dy: number;
}

/** 相邻两帧双指状态 → 缩放比 / 旋转角 / 双指中心平移量。 */
export function pinchDelta(prev: PinchMetrics, next: PinchMetrics): PinchDelta {
  return {
    scale: prev.distance > 0.5 ? clamp(next.distance / prev.distance, 0.1, 10) : 1,
    rotationDeg: normalizeAngle(next.angleDeg - prev.angleDeg),
    dx: next.centerX - prev.centerX,
    dy: next.centerY - prev.centerY,
  };
}

/* ------------------------------------------------------------------ *
 * 变换控件 / 图钉反馈：手柄出现与抓取的插值状态（供 canvas 每帧读取）
 * ------------------------------------------------------------------ */

export interface HandleAnim {
  /** 0=完全隐藏，1=完全显示 */
  appear: number;
  /** 0=未 hover，1=完全 hover */
  hover: number;
  /** 0=未抓取，1=抓取中 */
  grab: number;
}

export const HANDLE_ANIM_INIT: HandleAnim = { appear: 0, hover: 0, grab: 0 };

/** 朝目标值做指数平滑，dt 单位毫秒，speed 越大追得越快。 */
export function approach(current: number, target: number, dt: number, speed = 0.018): number {
  const k = 1 - Math.exp(-Math.max(0, dt) * speed);
  const next = current + (target - current) * k;
  return Math.abs(next - target) < 0.001 ? target : next;
}

export function stepHandleAnim(
  state: HandleAnim,
  target: { visible: boolean; hovered: boolean; dragging: boolean },
  dt: number,
  enabled = true,
): HandleAnim {
  if (!enabled) {
    return {
      appear: target.visible ? 1 : 0,
      hover: target.hovered ? 1 : 0,
      grab: target.dragging ? 1 : 0,
    };
  }
  return {
    appear: approach(state.appear, target.visible ? 1 : 0, dt, 0.022),
    hover: approach(state.hover, target.hovered ? 1 : 0, dt, 0.03),
    grab: approach(state.grab, target.dragging ? 1 : 0, dt, 0.035),
  };
}

/** 手柄半径：出现时放大、hover 再放大一点、抓取时轻微收缩（「抓住了」）。 */
export function handleRadius(base: number, anim: HandleAnim): number {
  return base * anim.appear * (1 + anim.hover * 0.18 - anim.grab * 0.1);
}
