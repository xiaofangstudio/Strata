/**
 * 钢笔路径描边：按 PS「描边路径 → 画笔工具 → 模拟压力」的语义，
 * 沿平滑曲线逐段画线，模拟压力时两端收尖。
 */
import { mustCtx } from "./surface";
import { penPressureWidth, samplePenPath, type PenPoint } from "../core/penPath";

export interface PenStrokeSettings {
  color: string;
  /** 画笔直径（px） */
  size: number;
  /** 流量 1–100 */
  flow: number;
  simulatePressure: boolean;
}

/** 把描边画到目标画布；调用方负责选区 / Alpha Lock 的裁剪与落库。 */
export function drawPenStroke(
  target: HTMLCanvasElement,
  points: readonly PenPoint[],
  settings: PenStrokeSettings,
): void {
  if (points.length < 2) return;
  const samples = samplePenPath(points);
  if (samples.length < 2) return;
  const ctx = mustCtx(target);
  ctx.save();
  ctx.strokeStyle = settings.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = Math.max(0.01, Math.min(1, settings.flow / 100));
  const diameter = Math.max(0.5, settings.size);
  for (let i = 1; i < samples.length; i += 1) {
    const t = i / (samples.length - 1);
    ctx.lineWidth = diameter * (settings.simulatePressure ? penPressureWidth(t) : 1);
    ctx.beginPath();
    ctx.moveTo(samples[i - 1].x, samples[i - 1].y);
    ctx.lineTo(samples[i].x, samples[i].y);
    ctx.stroke();
  }
  ctx.restore();
}
