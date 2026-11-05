/**
 * 数位板输入解析（六项差距全修 · 第 2 项）。
 *
 * Windows Ink 在 WebView2 里全量上报 Pointer Events：pressure / tiltX / tiltY /
 * twist / buttons。PhotoCraft 的 tablet crate 在 Windows 上根本没有实现
 * （只有 macOS AppKit + Linux X11），字段语义参考其 `Sample{pressure,tilt_x,
 * tilt_y,rotation,eraser}`（ArtCraft PhotoCraft, MIT/Apache-2.0），
 * 但输入通道走浏览器标准，不引任何原生 crate。
 *
 * 本文件全部是纯函数：不碰 DOM、不碰 React，方便在 node 环境下单测。
 */

/** 一次指针采样的数位板字段。 */
export interface PenSample {
  /** 0–1；鼠标 / 触摸给 0.5 由上层兜底 */
  pressure: number;
  /** 笔相对垂直于屏幕平面的左右倾角，-90…90 度 */
  tiltX: number;
  /** 笔相对垂直于屏幕平面的前后倾角，-90…90 度 */
  tiltY: number;
  /** 笔杆绕自身轴的旋转，0…359 度（浏览器叫 twist） */
  twist: number;
  /** 是否按下了擦除笔端 / 笔身侧面被识别为橡皮 */
  eraser: boolean;
  pointerType: string;
}

/** 能被 penSampleOf 解析的最小形状：原生 PointerEvent 与 React 合成事件都满足。 */
export interface PenEventLike {
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  buttons?: number;
  button?: number;
  pointerType?: string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function penSampleOf(ev: PenEventLike | undefined | null): PenSample {
  const pressure = typeof ev?.pressure === "number" && Number.isFinite(ev.pressure) ? ev.pressure : 0;
  const buttons = typeof ev?.buttons === "number" ? ev.buttons : 0;
  // bit 5 (32) = pen eraser button；部分驱动只在 button 里报 5
  const eraser = (buttons & 32) !== 0 || ev?.button === 5;
  return {
    pressure: clamp(pressure, 0, 1),
    tiltX: clamp(typeof ev?.tiltX === "number" ? ev.tiltX : 0, -90, 90),
    tiltY: clamp(typeof ev?.tiltY === "number" ? ev.tiltY : 0, -90, 90),
    twist: clamp(typeof ev?.twist === "number" ? ev.twist : 0, 0, 359),
    eraser,
    pointerType: ev?.pointerType ?? "mouse",
  };
}

/**
 * 压感取值：笔用真实压力，鼠标 / 触摸退回 0.5。
 * enabled=false 时一律 0.5（用户关掉压感映射）。
 */
export function penPressureOf(sample: PenSample, enabled: boolean): number {
  if (!enabled) return 0.5;
  if (sample.pointerType === "pen" && sample.pressure > 0) return Math.min(1, sample.pressure);
  if (sample.pressure > 0 && sample.pressure !== 0.5) return Math.min(1, sample.pressure);
  return 0.5;
}

/** 倾角换算成对笔尖贴图的形变。 */
export interface TiltStamp {
  /** 笔尖在短轴方向的缩放（1 = 正圆，越小越扁） */
  roundnessScale: number;
  /** 笔尖旋转角度（度），压扁方向垂直于笔杆倾斜方向 */
  spinDeg: number;
  /** 归一化倾角 0–1，供上层做强度映射 */
  tilt: number;
}

/**
 * tiltX / tiltY 合成为倾角与方位角，再叠上笔杆自转。
 * strengthPct 0–100 决定最大压扁程度；0 强度或笔垂直时返回恒等变换。
 */
export function tiltToBrush(sample: PenSample, strengthPct: number): TiltStamp {
  const strength = clamp(strengthPct, 0, 100) / 100;
  const tilt = Math.min(1, Math.hypot(sample.tiltX, sample.tiltY) / 90);
  if (strength <= 0 || tilt < 0.02) {
    return { roundnessScale: 1, spinDeg: 0, tilt };
  }
  const azimuth = (Math.atan2(sample.tiltY, sample.tiltX) * 180) / Math.PI;
  return {
    roundnessScale: Math.max(0.12, 1 - strength * tilt),
    spinDeg: (azimuth + 90 + sample.twist + 360) % 360,
    tilt,
  };
}
