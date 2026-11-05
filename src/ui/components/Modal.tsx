import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Modal.css";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区 */
  footer?: ReactNode;
  width?: number;
  /** 固定高度（px）。给了就不再按内容撑高 —— 偏好设置这类多页弹窗用它，切页时窗口纹丝不动。 */
  height?: number;
}

/** 退场时长与 motion.css 的三档保持一致；off 档立即卸载，不留空窗。 */
function exitDuration(): number {
  const m = document.documentElement.dataset.motion;
  if (m === "off") return 0;
  if (m === "reduced") return 100;
  return 150;
}

/**
 * 通用浮层。Esc 关闭，点遮罩关闭，关闭时播退场动画再卸载。
 *
 * 渲染到 document.body（portal）：弹窗不管写在哪一层 JSX 里，
 * 都不受祖先的 overflow / transform / 层叠上下文影响 ——
 * 之前菜单被滚动容器裁掉、滚轮被视口监听吃掉，根子都在「弹窗长在了别人家里」。
 *
 * 早期版本是直接 createPortal → 条件卸载，只有 keyframes 入场、关闭瞬间消失；
 * 现在用 closing 状态挂 .is-closing，等 motion.css 的 out 动画走完再真正 onClose。
 */
export default function Modal({
  title,
  onClose,
  children,
  footer,
  width = 460,
  height,
}: ModalProps) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);

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

  return createPortal(
    <div className={`modal-mask${closing ? " is-closing" : ""}`} onMouseDown={close}>
      <div
        className={`${height ? "modal is-fixed" : "modal"}${closing ? " is-closing" : ""}`}
        style={{ width, height: height ? `${height}px` : undefined }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-x" onClick={close} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
