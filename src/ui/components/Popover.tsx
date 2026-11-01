/**
 * 浮层菜单（脱离滚动容器渲染）。
 *
 * 两件事都必须做对，否则用户看到的就是「菜单只露一角」或「菜单飘在别处」：
 *
 * 1. **不留在家里的滚动容器里**：右侧面板列是 `overflow-y: auto`，
 *    绝对定位的菜单会被裁掉下沿 —— 所以 portal 到 body + fixed 定位。
 * 2. **位置要按菜单自己的真实高度算**：早先的实现用 maxHeight（上限）当高度去
 *    推 top，`preferUp` 时菜单会被顶到离按钮很远的上方，看着像"弹到别的面板里去了"。
 *    现在先挂到看不见的位置量一次 offsetHeight，再定最终坐标：
 *    向上弹时底边贴住按钮，并把整体夹进视口。
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
const EDGE = 8;
/** 不知道内容多高时先按这个上限排版，量到真实高度后再收。 */
const MAX_H = 360;

export default function Popover({ anchor, onClose, preferUp = false, width = 168, children }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = (): void => {
      const r = anchor.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const h = ref.current?.offsetHeight ?? 0;

      // 上下各有空间时，谁宽裕往哪边弹；preferUp 只是加权，不是硬性
      const spaceDown = vh - r.bottom - GAP - EDGE;
      const spaceUp = r.top - GAP - EDGE;
      const up = preferUp ? spaceUp >= Math.min(h, MAX_H) || spaceUp >= spaceDown : spaceDown < Math.min(h, MAX_H);

      const maxHeight = Math.max(120, Math.min(MAX_H, up ? spaceUp : spaceDown));
      const drawH = Math.min(h || maxHeight, maxHeight);
      const left = Math.min(Math.max(EDGE, r.left), Math.max(EDGE, vw - width - EDGE));
      const rawTop = up ? r.top - GAP - drawH : r.bottom + GAP;
      const top = Math.min(Math.max(EDGE, rawTop), Math.max(EDGE, vh - drawH - EDGE));
      setPos({ left, top, maxHeight });
    };
    place();
    // 内容高度确定后（字体、图片加载完）再量一次
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
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
        maxHeight: pos?.maxHeight ?? MAX_H,
        // 高于工具二级面板(80) / 浮窗(320) / 模态(100)，低于启动屏(9999)
        zIndex: 6000,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
