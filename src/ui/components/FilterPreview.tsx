/**
 * 参数窗口内独立预览（PhotoCraft `filter_preview_ui` 的对应实现，清单 G5）。
 *
 * 为什么要有：以前用户只能盯着主画布看效果，参数窗里全是滑块 —— 一眼看过去
 * 像网页表单，不像能替代 PS 的专业工具。这里在窗口内嵌一块真正的图像预览：
 * 棋盘格透明底、缩放档位（12.5%–800%，与 PhotoCraft 的 ZOOM_STEPS 一致）、
 * 拖动平移、滚轮缩放、底部尺寸状态条。
 *
 * 预览源由调用方给一个「工作文档合成画布」—— 即已经应用了当前参数的完整结果，
 * 不是缩略图近似，也不是读主画布。窗口开着时主画布仍可交互，两者独立。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { zh } from "../../i18n";
import "./FilterPreview.css";

/** 与 PhotoCraft filter_preview_ui::ZOOM_STEPS 一致的档位。 */
const ZOOM_STEPS = [0.125, 0.25, 0.5, 1, 2, 4, 8] as const;

interface Props {
  source: HTMLCanvasElement | null;
  /** 未应用参数的原图合成画布；按住预览（或工具条按钮）时临时显示它 */
  compareSource?: HTMLCanvasElement | null;
  /** 源文档尺寸（状态条显示） */
  docW: number;
  docH: number;
  /** 源画布版本号，驱动重画 */
  version?: number;
  /** 预览区总高度：数字 = px，字符串 = CSS 尺寸（如 "100%" 填满父容器） */
  height?: number | string;
}

export default function FilterPreview({
  source,
  compareSource,
  docW,
  docH,
  version = 0,
  height = 200,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomIdx, setZoomIdx] = useState(3); // 默认 100%
  const [fit, setFit] = useState(true);
  const [holding, setHolding] = useState(false); // 按住对比原图
  const [center, setCenter] = useState({ x: 0.5, y: 0.5 }); // 归一化 0..1 的源中心
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  /** 当前档位下，源图在显示区的实际绘制比例。 */
  const scaleOf = useCallback((boxW: number, boxH: number) => {
    if (fit) return Math.min(boxW / Math.max(1, docW), boxH / Math.max(1, docH)) * 0.92;
    return ZOOM_STEPS[zoomIdx];
  }, [fit, zoomIdx, docW, docH]);

  const repaint = useCallback(() => {
    const host = hostRef.current;
    const el = canvasRef.current;
    // 按住时优先显示原图（Photoshop 的招牌交互：按一下就看到改之前什么样）
    const img = holding && compareSource ? compareSource : source;
    if (!host || !el || !img) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const boxW = Math.max(1, host.clientWidth);
    const boxH = Math.max(1, Math.round(host.clientHeight));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(boxW * dpr);
    const ph = Math.round(boxH * dpr);
    if (el.width !== pw) el.width = pw;
    if (el.height !== ph) el.height = ph;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);

    const k = scaleOf(boxW, boxH);
    const sw = docW * k;
    const sh = docH * k;
    // 图像中心：适应档固定在正中；放大档按 center 平移
    const cx = fit ? boxW / 2 : center.x * boxW;
    const cy = fit ? boxH / 2 : center.y * boxH;
    const left = cx * dpr - (sw * dpr) / 2;
    const top = cy * dpr - (sh * dpr) / 2;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, left, top, sw * dpr, sh * dpr);
  }, [source, compareSource, holding, docW, docH, fit, center, scaleOf]);

  useEffect(() => { repaint(); }, [repaint, version]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(repaint) : null;
    ro?.observe(host);
    return () => ro?.disconnect();
  }, [repaint]);

  const stepZoom = useCallback((dir: -1 | 1) => {
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, zoomIdx + dir));
    if (next === zoomIdx) return;
    setZoomIdx(next);
    setFit(false);
  }, [zoomIdx]);
  const pctLabel = fit ? zh.dialog.fpFit : `${Math.round(ZOOM_STEPS[zoomIdx] * 100)}%`;

  /** 滚轮缩放走原生非被动监听（React 合成 onWheel 的 preventDefault 会被忽略）。 */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [stepZoom]);
  const onDown = (e: React.PointerEvent) => {
    if (compareSource) setHolding(true); // 按住即看原图，与 PhotoCraft / PS 一致
    if (fit || !source) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: center.x, cy: center.y, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const host = hostRef.current;
    if (!d || !host) return;
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    // 手型工具语义：图像跟着指针走 —— 往右拖，图像中心就往右移。
    setCenter({
      x: Math.max(0, Math.min(1, d.cx + dx / w)),
      y: Math.max(0, Math.min(1, d.cy + dy / h)),
    });
  };
  const onUp = (e: React.PointerEvent) => {
    setHolding(false);
    const d = drag.current;
    drag.current = null;
    // 纯点击（没拖动）：把点中的位置变成新的预览中心（清单 G5：点击定位预览中心）
    if (d && !d.moved && !fit && source) {
      const host = hostRef.current;
      if (!host) return;
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      const k = scaleOf(w, h);
      const px = e.clientX - host.getBoundingClientRect().left;
      const py = e.clientY - host.getBoundingClientRect().top;
      // repaint 的逆变换：画面左边缘 = center.x*w - docW*k/2
      const nx = (px - (d.cx * w - (docW * k) / 2)) / (docW * k);
      const ny = (py - (d.cy * h - (docH * k) / 2)) / (docH * k);
      setCenter({
        x: Math.max(0, Math.min(1, nx)),
        y: Math.max(0, Math.min(1, ny)),
      });
    }
  };

  return (
    <div className="fpv" style={{ height }}>
      <div
        className="fpv-stage"
        ref={hostRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <canvas ref={canvasRef} className="fpv-canvas" />
        {!source && <span className="fpv-empty">{zh.dialog.fpEmpty}</span>}
        {holding && compareSource && <span className="fpv-original">{zh.dialog.fpOriginal}</span>}
      </div>
      <div className="fpv-bar">
        {compareSource && (
          <button
            type="button"
            className={holding ? "fpv-cmp is-on" : "fpv-cmp"}
            title={zh.dialog.fpCompareTip}
            onPointerDown={() => setHolding(true)}
            onPointerUp={() => setHolding(false)}
            onPointerLeave={() => setHolding(false)}
            onPointerCancel={() => setHolding(false)}
          >
            {zh.dialog.fpOriginal}
          </button>
        )}
        <button type="button" className="fpv-btn" title={zh.dialog.fpZoomOut} onClick={() => stepZoom(-1)}>−</button>
        <button
          type="button"
          className={`fpv-pct${fit ? " is-fit" : ""}`}
          title={zh.dialog.fpFitTip}
          onClick={() => { setFit(true); }}
        >
          {pctLabel}
        </button>
        <button type="button" className="fpv-btn" title={zh.dialog.fpZoomIn} onClick={() => stepZoom(1)}>+</button>
        <span className="fpv-spacer" />
        <span className="fpv-size">{docW} × {docH}</span>
      </div>
    </div>
  );
}
