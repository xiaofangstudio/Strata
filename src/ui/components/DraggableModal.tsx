/**
 * 参数工作窗口 —— Modal 的 opt-in 兄弟组件。
 *
 * 与通用 Modal 的区别（对齐 PhotoCraft 的 dialogs.rs）：
 *  · 标题栏可拖、右下角可缩，位置/尺寸按 id 记在会话里；
 *  · 遮罩透明且不吃指针 —— 窗口开着时画布照样能平移/缩放/取样；
 *  · 不压暗、不虚化画面：调参数本质是「看着画面调」，真实对比度不能被破坏；
 *  · 依旧 Esc 关闭、关闭播退场动画。
 *
 * 刻意不动原 Modal（导出/首选项/关于等表单仍用固定居中模态更顺手）。
 * 只有「要盯着画面调」的参数窗才 opt-in 用这个。
 *
 * CSS 类名一律 `.pw-` 独占前缀 —— 裸 `.modal` / `.cp` 撞车过的坑不再踩。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloatRect } from "../hooks/useFloatRect";
import "./DraggableModal.css";

interface DraggableModalProps {
  /** 位置记忆键；同一个窗口传稳定 id */
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  /** 打开时聚焦哪个区域（默认窗口本体），给按钮让位可选 */
  badge?: string;
}

function exitDuration(): number {
  const m = document.documentElement.dataset.motion;
  if (m === "off") return 0;
  if (m === "reduced") return 100;
  return 150;
}

export default function DraggableModal({
  id,
  title,
  onClose,
  children,
  footer,
  width = 520,
  height,
  minWidth,
  minHeight,
  badge,
}: DraggableModalProps) {
  const { rect, dragging, dragProps, resizeProps } = useFloatRect({
    id,
    width,
    height,
    minWidth,
    minHeight,
  });
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(true);
  const timerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    if (closing) return;
    const dur = exitDuration();
    if (dur <= 0) {
      onClose();
      return;
    }
    setClosing(true);
    timerRef.current = window.setTimeout(onClose, dur);
  }, [closing, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // 多窗口叠放：点谁谁置顶（用局部 active 态配合 CSS z-index 即可，
  // 真实堆叠顺序由 DOM 顺序决定，这里只强调当前窗口的边框）。
  const onPointerDown = useCallback(() => setActive(true), []);

  return createPortal(
    <div className={`pw-layer${closing ? " is-closing" : ""}`}>
      <div
        ref={rootRef}
        className={`pw-window${dragging ? " is-dragging" : ""}${active ? " is-active" : ""}${closing ? " is-closing" : ""}`}
        style={{ left: rect.x, top: rect.y, width: rect.w, height: height ? rect.h : undefined, maxHeight: height ? undefined : rect.h }}
        role="dialog"
        aria-modal="false"
        aria-label={title}
        onPointerDown={onPointerDown}
      >
        <header className="pw-bar" {...dragProps}>
          <span className="pw-grip" aria-hidden="true">
            ⠿
          </span>
          <h2 className="pw-title">{title}</h2>
          {badge && <span className="pw-badge">{badge}</span>}
          <button className="pw-x" onClick={close} aria-label="关闭" onPointerDown={(e) => e.stopPropagation()}>
            ×
          </button>
        </header>
        <div className="pw-body">{children}</div>
        {footer && <footer className="pw-foot">{footer}</footer>}
        <div className="pw-resize" {...resizeProps} title="拖动调整窗口大小" aria-hidden="true" />
      </div>
    </div>,
    document.body,
  );
}
