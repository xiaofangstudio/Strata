/**
 * 浮动矩形 hook —— 从 FloatingDoc 的 pointer 拖动/缩放逻辑抽出的通用版。
 *
 * 只管几何与手势：位置、尺寸、拖动中状态，以及标题栏/右下角的事件绑定。
 * 不碰渲染、不碰业务，给 DraggableModal 这类「窗口式 UI」复用。
 *
 * 位置/尺寸按 id 记忆到 sessionStorage（跟 FloatingDoc 的「会话内记忆」口径一致）：
 * 同一个参数窗关掉再开，还停在用户上次摆的地方。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Options {
  /** 记忆键；相同 id 的窗口共用位置。传空串则不记忆。 */
  id: string;
  /** 初始尺寸（宽度用 width  prop，高度给 undefined 时按内容自适应，这里先给个兜底高度）。 */
  width: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

interface DragState {
  mode: "move" | "resize";
  sx: number;
  sy: number;
  rect: FloatRect;
}

const MIN_W = 300;
const MIN_H = 220;
const KEY_PREFIX = "strata.pw.rect.";

/** 初始位置：水平居中、垂直略靠上，多个窗口按 id 散列错开一点，避免完全重叠。 */
function initialRect(width: number, height: number, id: string): FloatRect {
  const hash = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const jitter = id ? (hash % 5) * 24 : 0;
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  return {
    x: Math.max(16, Math.round((vw - width) / 2) + jitter),
    y: Math.max(24, Math.round((vh - height) / 3) + jitter / 2),
    w: width,
    h: height,
  };
}

function loadRect(id: string, fallback: FloatRect): FloatRect {
  if (!id || typeof sessionStorage === "undefined") return fallback;
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + id);
    if (!raw) return fallback;
    const r = JSON.parse(raw) as Partial<FloatRect>;
    if ([r.x, r.y, r.w, r.h].every((v) => typeof v === "number" && Number.isFinite(v))) {
      return r as FloatRect;
    }
  } catch {
    /* 存储被禁用或数据坏了，用默认位置 */
  }
  return fallback;
}

export function useFloatRect({ id, width, height, minWidth = MIN_W, minHeight = MIN_H }: Options) {
  const fallback = initialRect(width, height ?? 460, id);
  const [rect, setRect] = useState<FloatRect>(() => loadRect(id, fallback));
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  // 记住用户摆的位置；id 切换时重新载入（同一个 hook 实例用于不同窗口的情况）
  useEffect(() => {
    setRect(loadRect(id, initialRect(width, height ?? 460, id)));
  }, [id, width, height]);

  useEffect(() => {
    if (!id || typeof sessionStorage === "undefined" || dragging) return;
    try {
      sessionStorage.setItem(KEY_PREFIX + id, JSON.stringify(rect));
    } catch {
      /* 存储被禁用，忽略 */
    }
  }, [id, rect, dragging]);

  const start = useCallback(
    (mode: "move" | "resize") => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 某些环境不支持捕获，退化为普通 pointermove */
      }
      dragRef.current = { mode, sx: e.clientX, sy: e.clientY, rect: { ...rect } };
      setDragging(true);
    },
    [rect],
  );

  const move = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (d.mode === "move") {
      setRect({
        ...d.rect,
        // 至少留 120px 在视口内（标题栏不会被拖丢），下边也不越过视口底
        x: Math.min(vw - 120, Math.max(-d.rect.w + 120, d.rect.x + dx)),
        y: Math.min(vh - 48, Math.max(0, d.rect.y + dy)),
      });
    } else {
      setRect({
        ...d.rect,
        w: Math.min(vw - d.rect.x, Math.max(minWidth, d.rect.w + dx)),
        h: Math.min(vh - d.rect.y, Math.max(minHeight, d.rect.h + dy)),
      });
    }
  }, [minWidth, minHeight]);

  const end = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放 */
      }
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  return {
    rect,
    dragging,
    /** 铺在标题栏上：按住拖动窗口 */
    dragProps: {
      onPointerDown: start("move"),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
    },
    /** 铺在右下角手柄上：拖动缩放窗口 */
    resizeProps: {
      onPointerDown: start("resize"),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
    },
    /** 手动改尺寸（外部 width 变化时同步） */
    setRect,
  };
}
