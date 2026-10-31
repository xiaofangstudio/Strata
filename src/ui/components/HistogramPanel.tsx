/**
 * 直方图面板（对齐 PhotoCraft 的 rgb_histogram.rs / PS 的直方图面板）。
 *
 * 每次合成结果变化（面板 version 前进）就重算一次 256 桶的 R/G/B/明度
 * 分布，画成叠加式柱状图；大图按固定步长抽样，采样量封顶，不卡 UI。
 * 通道可切：颜色（RGB 三通道叠加）/ 明度 / R / G / B。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { zh } from "../../i18n/zh-CN";
import "./HistogramPanel.css";

type Channel = "colors" | "luminosity" | "r" | "g" | "b";

interface Props {
  /** 最近一次合成的整档画布（compRef 的内容），由外壳负责更新 */
  source: HTMLCanvasElement | null;
  /** 帧号：合成每前进一次就 +1，驱动重算 */
  version: number;
}

const BINS = 256;
/** 抽样上限：超过这个像素数就按步长跳采，统计形状不变、计算量封顶 */
const MAX_SAMPLES = 262144;

export interface HistStats {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  lum: Uint32Array;
  max: number;
  mean: number;
  median: number;
  pixels: number;
}

/** 复用一块小画布做降采样，读像素量和原图大小脱钩（4000×3000 也只读 512²）。 */
let sampleCanvas: HTMLCanvasElement | null = null;

export function computeHistogram(src: HTMLCanvasElement): HistStats | null {
  const w = src.width;
  const h = src.height;
  if (w === 0 || h === 0) return null;
  // 先按比例缩到最长边 512，再统计。分布形状不变，getImageData 的成本封顶。
  const fit = Math.min(1, 512 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * fit));
  const sh = Math.max(1, Math.round(h * fit));
  if (!sampleCanvas) sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = sw;
  sampleCanvas.height = sh;
  const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, sw, sh);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, sw, sh);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch {
    return null;
  }
  const total = sw * sh;
  const step = total > MAX_SAMPLES ? Math.ceil(Math.sqrt(total / MAX_SAMPLES)) : 1;

  const r = new Uint32Array(BINS);
  const g = new Uint32Array(BINS);
  const b = new Uint32Array(BINS);
  const lum = new Uint32Array(BINS);
  let sum = 0;
  let count = 0;
  for (let y = 0; y < sh; y += step) {
    for (let x = 0; x < sw; x += step) {
      const i = (y * sw + x) * 4;
      const a = data[i + 3];
      if (a === 0) continue;
      const rv = data[i];
      const gv = data[i + 1];
      const bv = data[i + 2];
      // 纯白底上透明像素按白色计，与 PS「按合成结果统计」一致
      const k = a / 255;
      const rr = Math.round(rv * k + 255 * (1 - k));
      const gg = Math.round(gv * k + 255 * (1 - k));
      const bb = Math.round(bv * k + 255 * (1 - k));
      r[rr] += 1;
      g[gg] += 1;
      b[bb] += 1;
      const lv = Math.round(0.299 * rr + 0.587 * gg + 0.114 * bb);
      lum[lv] += 1;
      sum += lv;
      count += 1;
    }
  }
  let max = 0;
  for (let i = 0; i < BINS; i += 1) {
    if (r[i] > max) max = r[i];
    if (g[i] > max) max = g[i];
    if (b[i] > max) max = b[i];
  }
  // 中间值：按明度桶找累计中点
  let median = 0;
  let acc = 0;
  const half = count / 2;
  for (let i = 0; i < BINS; i += 1) {
    acc += lum[i];
    if (acc >= half) {
      median = i;
      break;
    }
  }
  return { r, g, b, lum, max, mean: count ? sum / count : 0, median, pixels: count };
}

export default function HistogramPanel({ source, version }: Props) {
  const [channel, setChannel] = useState<Channel>("colors");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stats = useMemo(() => (source ? computeHistogram(source) : null), [source, version]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 256;
    const h = 110;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 底部参考刻度：黑场 / 中灰 / 白场
    ctx.strokeStyle = "rgba(128,128,128,0.35)";
    ctx.beginPath();
    for (const t of [0.25, 0.5, 0.75]) {
      ctx.moveTo(t * w, 0);
      ctx.lineTo(t * w, h);
    }
    ctx.stroke();

    if (!stats || stats.max === 0) return;
    const scaleV = (v: number) => Math.min(1, Math.pow(v / stats.max, 0.5));

    const drawOne = (arr: Uint32Array, color: string, composite: GlobalCompositeOperation) => {
      ctx.globalCompositeOperation = composite;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < BINS; i += 1) {
        ctx.lineTo((i / (BINS - 1)) * w, h - scaleV(arr[i]) * (h - 2));
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    };

    if (channel === "colors") {
      // RGB 三通道「加色」叠加，重叠处趋白 —— 与 PS 的「颜色」直方图一致
      drawOne(stats.r, "rgba(220,60,60,0.75)", "lighter");
      drawOne(stats.g, "rgba(60,190,80,0.75)", "lighter");
      drawOne(stats.b, "rgba(80,120,230,0.75)", "lighter");
    } else if (channel === "luminosity") {
      const m = stats.lum.reduce((a, v) => Math.max(a, v), 0) || 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(160,160,160,0.9)";
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < BINS; i += 1) {
        ctx.lineTo((i / (BINS - 1)) * w, h - Math.min(1, Math.pow(stats.lum[i] / m, 0.5)) * (h - 2));
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    } else {
      const arr = channel === "r" ? stats.r : channel === "g" ? stats.g : stats.b;
      drawOne(arr, "rgba(190,190,190,0.9)", "source-over");
    }
    ctx.globalCompositeOperation = "source-over";
  }, [stats, channel]);

  return (
    <section className="dock-panel" aria-label={zh.panel.histogram}>
      <div className="dock-head">
        <span>{zh.panel.histogram}</span>
        <select
          className="hist-channel"
          value={channel}
          aria-label={zh.panel.histogram}
          onChange={(e) => setChannel(e.target.value as Channel)}
        >
          <option value="colors">{zh.panel.histColors}</option>
          <option value="luminosity">{zh.panel.histLum}</option>
          <option value="r">R</option>
          <option value="g">G</option>
          <option value="b">B</option>
        </select>
      </div>
      <div className="hist-body">
        <canvas ref={canvasRef} className="hist-canvas" aria-hidden="true" />
        <div className="hist-stats">
          <span>{zh.panel.histMean}: {stats ? stats.mean.toFixed(1) : "—"}</span>
          <span>{zh.panel.histMedian}: {stats ? String(stats.median) : "—"}</span>
          <span>{zh.panel.histPixels}: {stats ? stats.pixels.toLocaleString() : "—"}</span>
        </div>
      </div>
    </section>
  );
}
