/**
 * 浮动文档窗口（窗口 > 排列 > 浮动在窗口中）。
 *
 * 为什么自己画、不开系统窗口：Strata 的编辑管线绑在一份文档 + 一个画布上，
 * 开第二个系统窗口就得把整条管线（历史、工具、选区、面板）再实例化一遍。
 * 而「浮动」的真实用途是**一边编辑一边并排看另一份文档**，所以这里做成
 * 应用内的浮动窗口：可拖动、可缩放、可切缩放比，内容是那份文档的实时合成快照。
 *
 * 拖动用 pointer 事件 + transform，跟系统窗口的手感一致；改完位置记在会话里。
 */
import { useEffect, useRef, useState } from "react";
import { composeDoc } from "../../engine/compositor";
import { createSurface } from "../../engine/surface";
import type { StrataDoc } from "../../core/document";
import "./FloatingDoc.css";

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

interface Props {
  doc: StrataDoc;
  rect: FloatRect;
  active: boolean;
  /** 合成前进一次 +1 */
  version: number;
  onMove: (rect: FloatRect) => void;
  onActivate: () => void;
  onClose: () => void;
}

const MIN_W = 220;
const MIN_H = 160;

export default function FloatingDoc({
  doc,
  rect,
  active,
  version,
  onMove,
  onActivate,
  onClose,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ mode: "move" | "resize"; sx: number; sy: number; rect: FloatRect } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);

  // 合成：文档或版本变化时重画
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const surface = createSurface(doc.width, doc.height);
    composeDoc(doc, surface);
    c.width = doc.width;
    c.height = doc.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, doc.width, doc.height);
    ctx.drawImage(surface, 0, 0);
  }, [doc, version]);

  const startDrag = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, rect: { ...rect } };
    setDragging(true);
    onActivate();
  };

  const onMovePtr = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") {
      onMove({
        ...d.rect,
        x: Math.max(-200, d.rect.x + dx),
        y: Math.max(0, d.rect.y + dy),
      });
    } else {
      onMove({
        ...d.rect,
        w: Math.max(MIN_W, d.rect.w + dx),
        h: Math.max(MIN_H, d.rect.h + dy),
      });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放 */
      }
    }
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <section
      className={`floatdoc${active ? " is-active" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDown={onActivate}
      aria-label={`浮动窗口：${doc.name}`}
    >
      <header className="floatdoc-bar" onPointerDown={startDrag("move")} onPointerMove={onMovePtr} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <span className="floatdoc-name" title={doc.name}>
          {doc.name}
        </span>
        <span className="floatdoc-meta">
          {doc.width}×{doc.height}
        </span>
        <div className="floatdoc-zoom" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="floatdoc-btn"
            title="缩小"
            onClick={() => onMove({ ...rect, zoom: Math.max(0.05, rect.zoom / 1.25) })}
          >
            −
          </button>
          <span className="floatdoc-pct">{Math.round(rect.zoom * 100)}%</span>
          <button
            type="button"
            className="floatdoc-btn"
            title="放大"
            onClick={() => onMove({ ...rect, zoom: Math.min(8, rect.zoom * 1.25) })}
          >
            +
          </button>
          <button
            type="button"
            className="floatdoc-btn"
            title="适应窗口"
            onClick={() => {
              const k = Math.min(
                (rect.w - 16) / doc.width,
                (rect.h - 56) / doc.height,
              );
              onMove({ ...rect, zoom: Math.max(0.05, k) });
            }}
          >
            ⤢
          </button>
        </div>
        <button
          type="button"
          className="floatdoc-btn floatdoc-close"
          title="收回到标签页"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="floatdoc-body">
        <canvas
          ref={canvasRef}
          className="floatdoc-canvas"
          style={{
            width: doc.width * rect.zoom,
            height: doc.height * rect.zoom,
          }}
        />
      </div>
      <div
        className="floatdoc-resize"
        title="拖动调整窗口大小"
        onPointerDown={startDrag("resize")}
        onPointerMove={onMovePtr}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </section>
  );
}
