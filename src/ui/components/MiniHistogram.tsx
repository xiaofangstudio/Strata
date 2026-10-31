/**
 * 迷你直方图（嵌在色阶 / 曲线等调整面板里）。
 *
 * 为什么要有：调色阶时盯着三条滑杆盲调是很痛苦的 —— 得看到亮度分布才知道
 * 黑白场该往哪推。PS 的色阶对话框顶上就是一张直方图，这里补上同一件事。
 *
 * 数据源是外壳的合成画布（`compRef`），按最长边 512 抽样统计，成本封顶。
 * 画的是亮度分布（细灰）叠一层 RGB 均值（品牌蓝），黑白场用竖线标出来。
 */
import { useEffect, useRef } from "react";
import { computeHistogram } from "./HistogramPanel";

interface Props {
  source: HTMLCanvasElement | null;
  /** 合成前进一次就 +1，驱动重算 */
  version: number;
  /** 黑场 / 白场 / 伽马（0–255 与 0.1–9.99），有值时画参考线 */
  black?: number;
  white?: number;
  gamma?: number;
  height?: number;
}

export default function MiniHistogram({ source, version, black, white, gamma, height = 64 }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = c.clientWidth || 240;
    c.width = Math.max(1, Math.round(cssW * dpr));
    c.height = Math.max(1, Math.round(height * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = height;

    ctx.clearRect(0, 0, w, h);
    // 底：浅格，方便读数
    ctx.fillStyle = "rgba(128,128,140,0.08)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(128,128,140,0.18)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const x = (w * i) / 4;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    const stats = source ? computeHistogram(source) : null;
    if (!stats) {
      ctx.fillStyle = "rgba(140,140,150,0.55)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("暂无数据", w / 2, h / 2 + 4);
      return;
    }

    // 归一化：用分位数裁掉极端峰值，免得一个超高峰把整张图压平
    const bins = stats.lum;
    const sorted = Array.from(bins).filter((v) => v > 0).sort((a, b) => a - b);
    const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 1;
    const peak = Math.max(1, Math.min(stats.max, p99 || stats.max));

    // 亮度柱（灰色填充）
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < 256; i += 1) {
      const x = (i / 255) * w;
      const y = h - Math.min(1, bins[i] / peak) * (h - 2);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = "rgba(140,140,155,0.45)";
    ctx.fill();

    // RGB 均值曲线（品牌蓝）
    ctx.beginPath();
    for (let i = 0; i < 256; i += 1) {
      const v = (stats.r[i] + stats.g[i] + stats.b[i]) / 3;
      const x = (i / 255) * w;
      const y = h - Math.min(1, v / peak) * (h - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(111,192,255,0.95)";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 黑白场参考线
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    if (typeof black === "number") {
      const x = (Math.max(0, Math.min(255, black)) / 255) * w;
      ctx.strokeStyle = "rgba(30,30,40,0.6)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    if (typeof white === "number") {
      const x = (Math.max(0, Math.min(255, white)) / 255) * w;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    if (typeof gamma === "number" && gamma > 0.05) {
      // 伽马中点参考
      const mid = Math.pow(0.5, 1 / gamma) * 255;
      const x = (Math.max(0, Math.min(255, mid)) / 255) * w;
      ctx.strokeStyle = "rgba(111,192,255,0.5)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }, [source, version, black, white, gamma, height]);

  return (
    <canvas
      ref={ref}
      className="mini-hist"
      style={{ width: "100%", height, display: "block", borderRadius: 6 }}
      aria-label="亮度直方图"
    />
  );
}
