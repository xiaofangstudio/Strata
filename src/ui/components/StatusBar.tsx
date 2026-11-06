/**
 * 状态栏（立项规划书 §7.2 的保留项）。
 *
 * 底边一条：当前工具、缩放比例、文档尺寸、色彩空间、图层数、内存占用。
 * 数值一律用等宽数字，滚动画布时不会左右抖动。
 */
import { zh } from "../../i18n";
import type { StrataDoc } from "../../core/document";
import type { ToolId } from "../../tools/catalog";
import "./StatusBar.css";

interface Props {
  doc: StrataDoc;
  /** 当前缩放比例，1 表示 100% */
  scale: number;
  tool: ToolId;
  /** 点击尺寸 → 改图像大小（打印店那种改像素直接开打） */
  onSizeClick?: () => void;
  /** 右键尺寸 → 改画布大小（不改内容、只扩/裁画布） */
  onCanvasClick?: () => void;
}

export default function StatusBar({ doc, scale, tool, onSizeClick, onCanvasClick }: Props) {
  return (
    <footer className="statusbar">
      <span className="st-item">
        <span className="st-key">{zh.status.tool}</span>
        <span className="st-val">{zh.tools[tool]}</span>
      </span>

      <span className="st-item">
        <span className="st-key">{zh.status.zoom}</span>
        <span className="st-val">{formatZoom(scale)}</span>
      </span>

      <span className="st-item">
        <span className="st-key">{zh.status.size}</span>
        <button
          type="button"
          className="st-size-edit"
          onClick={onSizeClick}
          onContextMenu={(e) => {
            e.preventDefault();
            onCanvasClick?.();
          }}
          title={`${zh.dialog.imageSizeTitle} / ${zh.dialog.canvasSizeTitle}`}
        >
          {doc.width} × {doc.height}
        </button>
      </span>

      <span className="st-item">
        <span className="st-val">{zh.editor.colorMode}</span>
      </span>

      <span className="st-item">
        <span className="st-key">{zh.status.layers}</span>
        <span className="st-val">{doc.layers.length}</span>
      </span>

      {/*
        慢帧读数：只在单帧超过 30ms 时由渲染循环直接写进来。
        走 DOM 而不走 props —— 否则"显示卡不卡"这件事本身就会触发重渲染。
      */}
      <span className="st-perf" id="st-perf" hidden />

      <span className="st-gap" />

      <span className="st-item">
        <span className="st-key">{zh.status.memory}</span>
        <span className="st-val">{formatMemory(doc)}</span>
      </span>
    </footer>
  );
}

/** 0.02 → 2%，1 → 100%。小于 10% 时给一位小数，否则取整。 */
function formatZoom(scale: number): string {
  const pct = scale * 100;
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/**
 * 内存占用估算。
 *
 * 每一层是一张 4 字节 / 像素的画布，再加一张合成结果，量级与真实驻留量
 * 一致（canvas 的实际分配还有少量对齐开销，这里按像素算已经是保守值）。
 */
function formatMemory(doc: StrataDoc): string {
  const px = doc.width * doc.height * 4;
  const bytes = px * (doc.layers.length + 1);
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}
