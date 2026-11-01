import { useEffect, type ReactNode } from "react";
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

/**
 * 通用浮层。Esc 关闭，点遮罩关闭。
 *
 * 渲染到 document.body（portal）：弹窗不管写在哪一层 JSX 里，
 * 都不受祖先的 overflow / transform / 层叠上下文影响 ——
 * 之前菜单被滚动容器裁掉、滚轮被视口监听吃掉，根子都在「弹窗长在了别人家里」。
 */
export default function Modal({
  title,
  onClose,
  children,
  footer,
  width = 460,
  height,
}: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-mask" onMouseDown={onClose}>
      <div
        className={height ? "modal is-fixed" : "modal"}
        style={{ width, height: height ? `${height}px` : undefined }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-x" onClick={onClose} aria-label="关闭">
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
