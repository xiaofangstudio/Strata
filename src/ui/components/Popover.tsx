/**
 * 浮层菜单（脱离滚动容器渲染）。
 *
 * 为什么需要它：右侧面板列现在可以滚动（`overflow-y: auto`），绝对定位的
 * 弹出菜单会被这个滚动容器裁掉下沿 —— 用户看到的「投影」只露一半就是这么来的。
 *
 * 做法是 portal 到 body + fixed 定位：菜单不再受祖先 overflow 影响，永远在上层。
 * 位置按触发按钮的矩形算；空间不够时自动翻到上方。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** 触发按钮（用它算位置，也用来判断「点外面」） */
  anchor: HTMLElement | null;
  onClose: () => void;
  /** 优先向上弹（面板底部的按钮用它） */
  preferUp?: boolean;
  width?: number;
  children: ReactNode;
}

const GAP = 6;

export default function Popover({ anchor, onClose, preferUp = false, width = 168, children }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = (): void => {
      const r = anchor.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const wantUp = preferUp || r.bottom + 240 > vh;
      const spaceDown = vh - r.bottom - GAP - 8;
      const spaceUp = r.top - GAP - 8;
      const maxHeight = Math.max(120, Math.min(340, wantUp ? spaceUp : spaceDown));
      const left = Math.min(Math.max(8, r.left), Math.max(8, vw - width - 8));
      const top = wantUp ? r.top - GAP - Math.min(maxHeight, 340) : r.bottom + GAP;
      setPos({ left, top: Math.max(8, top), maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, preferUp, width]);

  // 点外面 / Esc 关闭
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;

  return createPortal(
    <div
      ref={ref}
      className="popover"
      role="menu"
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width,
        maxHeight: pos?.maxHeight ?? 320,
        zIndex: 4000,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
