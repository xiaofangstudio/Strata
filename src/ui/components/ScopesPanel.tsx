/**
 * 色彩示波器面板（波形图 / 分量 Parade / 矢量图）。
 *
 * 与直方图面板同一套节奏：外壳每合成一帧就把 version +1，面板拿到画布后
 * 按当前模式重算密度、画到 canvas 上。逐像素密度用 engine/scopes.ts 的纯函数，
 * 这里只负责画 —— 数学不进 UI，UI 不进数学。
 *
 * 作图的三处刻意统一：波形与矢量都用发光的点（越密越亮）而不是实心块，
 * 才能在深色面板上看清稀疏的边缘；网格一律虚线淡灰，不跟数据抢注意力。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { zh } from "../../i18n/zh-CN";
import {
  binIntensity,
  computeParade,
  computeVectorscope,
  computeWaveform,
  type ScopeBins,
} from "../../engine/scopes";
import { readPixels } from "../../engine/surface";
import "./ScopesPanel.css";

type ScopeMode = "waveform" | "parade" | "vector";

interface Props {
  /** 最近一次合成的画布（外壳负责更新） */
  source: HTMLCanvasElement | null;
  /** 帧号：合成前进一次 +1，驱动重算 */
  version: number;
}

const MODES: { id: ScopeMode; label: string }[] = [
  { id: "waveform", label: zh.panel.scopeWaveform },
  { id: "parade", label: zh.panel.scopeParade },
  { id: "vector", label: zh.panel.scopeVector },
];

export default function ScopesPanel({ source, version }: Props) {
  const [mode, setMode] = useState<ScopeMode>("waveform");
  const wrapRef = useRef<HTMLCanvasElement>(null);

  const data = useMemo(() => {
    if (!source || source.width < 1 || source.height < 1) return null;
    // 大图降采样：示波器看的是分布形状，没必要按原分辨率全扫一遍
    let img: { data: Uint8ClampedArray; width: number; height: number } | null = null;
    try {
      img = readPixels(source);
    } catch {
      return null;
    }
    return img;
    // version 变了才重算：source 是 mutable 的画布，只能靠帧号驱动
  }, [source, version]);

  useEffect(() => {
    const cv = wrapRef.current;
    if (!cv || !data) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 220;
    const cssH = cv.clientHeight || 150;
    cv.width = Math.max(1, Math.round(cssW * dpr));
    cv.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const cs = getComputedStyle(cv);
    const ink = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
    const grid = ink("--border", "#2b2b2f");
    const surface = ink("--surface", "#1a1a1f");

    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, cssW, cssH);

    /* 背景网格：波形横三格说明暗到亮，矢量画同心圆与十字 */
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    if (mode === "vector") {
      const cx = cssW / 2;
      const cy = cssH / 2;
      const r = Math.min(cx, cy) - 4;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.moveTo(cx - r, cy);
      ctx.lineTo(cx + r, cy);
    } else {
      for (let i = 1; i < 4; i += 1) {
        const y = (i / 4) * cssH;
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (mode === "vector") {
      const vs = computeVectorscope(data, 256);
      paintBins(ctx, vs, cssW, cssH, [255, 255, 255], true);
      // 目标框：100% 与 75% 彩条的标准落点，中心到边缘的比例位置
      paintTargets(ctx, cssW, cssH, grid);
      return;
    }

    if (mode === "waveform") {
      const wf = computeWaveform(data, "luma", Math.max(64, Math.round(cssW)));
      paintBins(ctx, wf, cssW, cssH, [232, 236, 244], false);
      // 0 / 100 IRE 参考线
      paintIre(ctx, cssW, cssH, grid);
      return;
    }

    // parade：三等分并排，各用通道本色
    const { r, g, b, slotWidth } = computeParade(data, Math.max(96, Math.round(cssW)));
    const each = cssW / 3;
    paintBins(ctx, r, each, cssH, [255, 92, 92], false, 0);
    paintBins(ctx, g, each, cssH, [92, 220, 120], false, each);
    paintBins(ctx, b, each, cssH, [110, 170, 255], false, each * 2);
    paintIre(ctx, cssW, cssH, grid);
    void slotWidth;
  }, [data, mode]);

  return (
    <section className="panel scope" aria-label={zh.panel.scopes}>
      <div className="scope-tabs" role="tablist">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            className={mode === m.id ? "scope-tab is-on" : "scope-tab"}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <canvas ref={wrapRef} className="scope-canvas" />
      <p className="scope-hint">
        {mode === "vector" ? zh.panel.scopeVectorHint : zh.panel.scopeWaveHint}
      </p>
    </section>
  );
}

/** 把密度图画成发光点；vector 模式下点更亮（否则稀疏边缘看不见）。 */
function paintBins(
  ctx: CanvasRenderingContext2D,
  b: ScopeBins,
  cssW: number,
  cssH: number,
  rgb: [number, number, number],
  radialOverlay: boolean,
  offsetX = 0,
): void {
  if (b.max <= 0) return;
  const sx = cssW / b.width;
  const sy = cssH / b.height;
  for (let y = 0; y < b.height; y += 1) {
    for (let x = 0; x < b.width; x += 1) {
      const v = b.bins[y * b.width + x];
      if (v === 0) continue;
      const a = binIntensity(v, b.max);
      if (a < 0.04) continue;
      const [cr, cg, cb] = rgb;
      if (radialOverlay) {
        // 矢量图：把该点的实际色相还原出来，看色相分布更直观
        const dx = (x + 0.5) / b.width - 0.5;
        const dy = 0.5 - (y + 0.5) / b.height;
        const hue = Math.atan2(dy, dx);
        const rr = Math.round(cr * (0.75 + 0.25 * Math.cos(hue)));
        const gg = Math.round(cg * (0.75 + 0.25 * Math.cos(hue - 2.09)));
        const bb = Math.round(cb * (0.75 + 0.25 * Math.cos(hue + 2.09)));
        ctx.fillStyle = `rgba(${rr}, ${gg}, ${bb}, ${a.toFixed(3)})`;
      } else {
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${a.toFixed(3)})`;
      }
      ctx.fillRect(offsetX + x * sx, y * sy, Math.max(1, sx), Math.max(1, sy));
    }
  }
}

/** 0 / 100 IRE 虚线（波形图上沿与下沿）。 */
function paintIre(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(0, 1);
  ctx.lineTo(cssW, 1);
  ctx.moveTo(0, cssH - 1);
  ctx.lineTo(cssW, cssH - 1);
  ctx.stroke();
  ctx.restore();
}

/** 矢量图的目标框：各彩条标准应在的半径圈。 */
function paintTargets(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  color: string,
): void {
  const cx = cssW / 2;
  const cy = cssH / 2;
  const rBase = Math.min(cx, cy) - 4;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  [0.75, 1].forEach((k) => {
    ctx.beginPath();
    ctx.arc(cx, cy, rBase * k, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();
}
