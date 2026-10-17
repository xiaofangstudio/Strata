/**
 * 通用色块按钮：点开一个挂到 body 上的自绘拾色器浮层。
 *
 * 为什么要自绘而不是 `<input type="color">`：在 Tauri 的 WebView2 里点它根本不弹
 * 系统取色器，用户看到的就是「所有换颜色的地方全不起作用」。这里统一走 ColorPicker，
 * 浮层 portal + `position:fixed`，也不会被父级的 overflow 裁掉。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { zh } from "../../i18n/zh-CN";
import ColorPicker from "./ColorPicker";
import "./picker.css";

export interface ColorChipProps {
  hex: string;
  onChange: (hex: string) => void;
  /** 松手 / 关闭浮层时的收尾（写进撤销栈） */
  onCommit?: () => void;
  label?: string;
  className?: string;
}

export default function ColorChip({
  hex,
  onChange,
  onCommit,
  label,
  className,
}: ColorChipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** 收尾回调每次渲染都会换新引用（闭包里带着最新的颜色），用 ref 接住，避免反复重订阅。 */
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const W = 236;
      const H = 322;
      let left = Math.round(r.left);
      if (left + W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - W - 8);
      let top = Math.round(r.bottom + 6);
      if (top + H > window.innerHeight - 8) top = Math.max(8, Math.round(r.top - 6 - H));
      setPos({ left, top });
    };
    place();

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
      commitRef.current?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        commitRef.current?.();
      }
    };
    const close = () => {
      setOpen(false);
      commitRef.current?.();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <span className="cchip" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={className ? `cchip-btn ${className}` : "cchip-btn"}
        style={{ background: hex }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label ? `${label} ${hex.toUpperCase()}` : hex.toUpperCase()}
        title={`${label ? label + " · " : ""}${hex.toUpperCase()} · ${zh.options.colorPickHint}`}
        onClick={() => setOpen((v) => !v)}
      />
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="swatch-pop2"
            role="dialog"
            aria-label={label ?? zh.options.color}
            style={{ position: "fixed", left: pos.left, top: pos.top }}
          >
            <ColorPicker hex={hex} onChange={onChange} />
          </div>,
          document.body,
        )}
    </span>
  );
}
