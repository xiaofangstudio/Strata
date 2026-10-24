/**
 * 导航器面板（对齐 PhotoCraft 的 navigator / PS 的导航器面板）。
 *
 * 整档缩略图 + 当前视口红框；点缩略图 / 拖动红框即把画布视图居中到对应点，
 * 底部还有一条缩放滑杆。缩略图内容来自外壳的最新合成结果（compRef）。
 */
import { useEffect, useRef } from "react";
import { zh } from "../../i18n/zh-CN";
import "./NavigatorPanel.css";
import RangeInput from "./RangeInput";

interface Props {
  /** 文档尺寸 */
  docW: number;
  docH: number;
  /** 最近一次合成的整档画布 */
  source: HTMLCanvasElement | null;
  /** 帧号：合成每前进一次就 +1，驱动重画 */
  version: number;
  /** 当前缩放 */
  scale: number;
  /** 视口（可视区）尺寸，像素 */
  viewportW: number;
  viewportH: number;
  /** 当前平移（stage 的 translate 值） */
  panX: number;
  panY: number;
  /** 把文档坐标 point 居中到视口 */
  onCenter: (x: number, y: number) => void;
  /** 缩放滑杆：对数映射到 [NAV_MIN, NAV_MAX] */
  onZoom: (scale: number) => void;
}

/** 与 EditorShell 的 MIN_SCALE / MAX_SCALE 保持一致 */
const NAV_MIN = 0.02;
const NAV_MAX = 16;
const NAV_SPAN = Math.log(NAV_MAX / NAV_MIN);

/** 缩放值 → 滑杆 0–100（对数：低倍率区间更细腻） */
const toSlider = (s: number) =>
  Math.round(
    (Math.log(Math.min(NAV_MAX, Math.max(NAV_MIN, s)) / NAV_MIN) / NAV_SPAN) * 100,
  );

/** 滑杆 0–100 → 缩放值 */
const fromSlider = (v: number) => NAV_MIN * Math.exp((v / 100) * NAV_SPAN);

export default function NavigatorPanel({
  docW,
  docH,
  source,
  version,
  scale,
  viewportW,
  viewportH,
  panX,
  panY,
  onCenter,
  onZoom,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef(false);

  /* 缩略图绘制：合成结果一变就重画 */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !source || docW === 0 || docH === 0) return;
    const boxW = 216;
    const boxH = 132;
    const fit = Math.min(boxW / docW, boxH / docH);
    const tw = Math.max(1, Math.round(docW * fit));
    const th = Math.max(1, Math.round(docH * fit));
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(boxW * dpr);
    c.height = Math.round(boxH * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);
    const ox = (boxW - tw) / 2;
    const oy = (boxH - th) / 2;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, ox, oy, tw, th);

    // 视口红框：把「屏幕上看得到的区域」折算回缩略图坐标
    const vw = (viewportW / scale) * fit;
    const vh = (viewportH / scale) * fit;
    // stage 原点在文档 (0,0)；视口中心对应文档坐标：
    const cxDoc = (viewportW / 2 - panX) / scale;
    const cyDoc = (viewportH / 2 - panY) / scale;
    const cx = ox + cxDoc * fit;
    const cy = oy + cyDoc * fit;
    ctx.strokeStyle = "#e5484d";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - vw / 2, cy - vh / 2, Math.min(vw, boxW), Math.min(vh, boxH));
  }, [source, version, docW, docH, scale, viewportW, viewportH, panX, panY]);

  /* 点击 / 拖动：把指到的文档点居中 */
  const seek = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current;
    if (!c || docW === 0 || docH === 0) return;
    const boxW = 216;
    const boxH = 132;
    const fit = Math.min(boxW / docW, boxH / docH);
    const rect = c.getBoundingClientRect();
    const ox = (boxW - docW * fit) / 2;
    const oy = (boxH - docH * fit) / 2;
    const dx = (e.clientX - rect.left - ox) / fit;
    const dy = (e.clientY - rect.top - oy) / fit;
    onCenter(dx, dy);
  };

  return (
    <section className="dock-panel" aria-label={zh.panel.navigator}>
      <div className="dock-head">
        <span>{zh.panel.navigator}</span>
        <span className="dock-head-count">{Math.round(scale * 100)}%</span>
      </div>
      <div className="nav-body">
        <canvas
          ref={canvasRef}
          className="nav-thumb"
          onPointerDown={(e) => {
            dragRef.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seek(e);
          }}
          onPointerMove={(e) => {
            if (dragRef.current) seek(e);
          }}
          onPointerUp={() => {
            dragRef.current = false;
          }}
          aria-label={zh.panel.navigator}
        />
      </div>
      <div className="nav-zoom">
        <button
          type="button"
          className="nav-zoom-btn"
          aria-label={zh.menu.zoomOut}
          onClick={() => onZoom(scale / 1.25)}
        >
          −
        </button>
        <RangeInput
          min={0}
          max={100}
          step={1}
          value={toSlider(scale)}
          onChange={(v) => onZoom(fromSlider(v))}
          aria-label={zh.panel.navigator}
        />
        <button
          type="button"
          className="nav-zoom-btn"
          aria-label={zh.menu.zoomIn}
          onClick={() => onZoom(scale * 1.25)}
        >
          +
        </button>
      </div>
    </section>
  );
}
