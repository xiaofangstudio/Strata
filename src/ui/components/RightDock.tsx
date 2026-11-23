/**
 * 右侧面板坞（对齐 PhotoCraft / PS 的真实 docker）。
 *
 * 一条 36px 的竖排开关轨 + 一列面板：点轨道上的图标开 / 关对应面板组，
 * 打开的面板自上而下堆叠。每个面板头部可以拖着改顺序、拆成独立浮窗；
 * 浮窗能拖、能缩、能一键归位。顺序 / 拆离 / 浮窗位置都持久化。
 * 颜色、属性、图层、历史、导航器、直方图都是真实面板，
 * 没做的（路径、通道独立页）就不放入口 —— 不做假控件。
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { reorderDockPanel } from "../../core/dockLayout";
import { zh } from "../../i18n";
import "./RightDock.css";

type GroupId =
  | "grade"
  | "props"
  | "color"
  | "layers"
  | "history"
  | "navigator"
  | "histogram"
  | "scopes";

export type { GroupId };
export interface DockFloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  /** 调色台（一级 / 色轮 / 切片器 / 曲线） */
  grade: ReactNode;
  /** 颜色 | 色板 */
  color: ReactNode;
  /** 属性 | 调整 */
  properties: ReactNode;
  /** 图层 | 通道 | 路径 */
  layers: ReactNode;
  /** 历史记录 */
  history: ReactNode;
  /** 导航器（整档缩略图 + 视口定位） */
  navigator: ReactNode;
  /** 直方图 */
  histogram: ReactNode;
  /** 色彩示波器（波形 / Parade / 矢量） */
  scopes: ReactNode;
  /** 钉死在坞底的固定条（图层操作那排）——不参与任何面板的伸缩 */
  footer?: ReactNode;
  /** 受控开关（「窗口 > 面板」菜单直接控制）；不传则坞内自持。 */
  open?: Record<GroupId, boolean>;
  onToggle?: (id: GroupId) => void;
  /** 受控面板顺序 / 拆离状态（工作区保存恢复用）；不传则坞内自持。 */
  order?: GroupId[];
  onOrderChange?: (order: GroupId[]) => void;
  detached?: Partial<Record<GroupId, DockFloatRect>>;
  onDetachedChange?: (next: Partial<Record<GroupId, DockFloatRect>>) => void;
  /** 工作区锁定时禁止重排 / 拆离。 */
  locked?: boolean;
}

/* -------------------------------------------------- 面板高度常量与持久化 */

const HEIGHT_KEY = "strata.dock.heights";

/** 坞宽（整列）持久化键与取值范围。 */
const W_KEY = "strata.dock.width";
const DEFAULT_W = 326;
const MIN_W = 264;
const MAX_W = 720;

/** 各面板默认高度（px）。 */
const DEFAULT_HEIGHTS: Record<GroupId, number> = {
  grade: 470,
  navigator: 152,
  scopes: 214,
  histogram: 150,
  color: 196,
  props: 168,
  layers: 300,
  history: 190,
};

/** 各面板允许的最小高度。 */
const MIN_H: Record<GroupId, number> = {
  grade: 200,
  navigator: 90,
  scopes: 120,
  histogram: 90,
  color: 110,
  props: 80,
  layers: 120,
  history: 90,
};

function readHeights(): Record<string, number> {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/* -------------------------------------------------- 顺序 / 拆离状态持久化 */

const ORDER_KEY = "strata.dock.order";
const DETACHED_KEY = "strata.dock.detached";
const ALL_GROUPS: GroupId[] = [
  "grade", "navigator", "scopes", "histogram", "color", "props", "layers", "history",
];

function isGroupId(v: unknown): v is GroupId {
  return typeof v === "string" && (ALL_GROUPS as string[]).includes(v);
}

/** 读顺序：老数据缺项补在末尾，脏数据直接丢 —— 绝不让未知 id 把面板列搞空。 */
function readOrder(): GroupId[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [...ALL_GROUPS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...ALL_GROUPS];
    const seen = new Set<GroupId>();
    const out: GroupId[] = [];
    for (const v of parsed) {
      if (isGroupId(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    for (const id of ALL_GROUPS) if (!seen.has(id)) out.push(id);
    return out;
  } catch {
    return [...ALL_GROUPS];
  }
}

function isFloatRect(v: unknown): v is DockFloatRect {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return [r.x, r.y, r.w, r.h].every(
    (n) => typeof n === "number" && Number.isFinite(n),
  );
}

function readDetached(): Partial<Record<GroupId, DockFloatRect>> {
  try {
    const raw = localStorage.getItem(DETACHED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<GroupId, DockFloatRect>> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isGroupId(k) && isFloatRect(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 工作区恢复时校验顺序里的 id，防止脏数据把面板列清空。 */
export function isDockGroupId(v: unknown): v is GroupId {
  return isGroupId(v);
}

/** 受控调用方（EditorShell / 工作区恢复）用它取已持久化的布局作初值。 */
export function loadDockLayout(): {
  order: GroupId[];
  detached: Partial<Record<GroupId, DockFloatRect>>;
} {
  return { order: readOrder(), detached: readDetached() };
}

/** 轨道上的按钮：顺序与 PhotoCraft 一致（导航器 → 直方图 → 属性 → 颜色 → 图层 → 历史）。 */
const RAIL: { id: GroupId; label: string; icon: ReactNode }[] = [
  {
    id: "navigator",
    label: zh.panel.navigator,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <rect x="6" y="6" width="5" height="4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
  {
    id: "histogram",
    label: zh.panel.histogram,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 13h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M3 13V9M6 13V5M9 13V7M12 13V3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "grade",
    label: zh.panel.grade,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6H8Z" fill="currentColor" opacity="0.55" />
        <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "scopes",
    label: zh.panel.scopes,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="10.6" cy="5.6" r="1.1" fill="currentColor" />
        <path d="M8 8 12 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "props",
    label: zh.panel.properties,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 4h8M12 4h2M2 8h3M7 8h7M2 12h10M14 12h0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="11" cy="4" r="1.6" fill="currentColor" />
        <circle cx="6" cy="8" r="1.6" fill="currentColor" />
        <circle cx="13" cy="12" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "color",
    label: zh.panel.colorSwatches,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 2.6a5.4 5.4 0 0 0 0 10.8Z" fill="currentColor" opacity="0.55" />
      </svg>
    ),
  },
  {
    id: "layers",
    label: zh.panel.layers,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m8 2.4 5.4 3L8 8.4 2.6 5.4 8 2.4Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="m2.6 8.4 5.4 3 5.4-3M2.6 11.2l5.4 3 5.4-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.7" />
      </svg>
    ),
  },
  {
    id: "history",
    label: zh.panel.history,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 8a5 5 0 1 1 1.6 3.7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M2.4 4.6v3.2h3.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 5.4V8l1.9 1.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
];

/** 拆离出来的面板浮窗：标题栏拖动、右下角缩放、归位与关闭都是真操作。 */
function FloatPanel({
  label,
  rect,
  onRect,
  onDock,
  onClose,
  locked,
  children,
}: {
  label: string;
  rect: DockFloatRect;
  onRect: (r: DockFloatRect) => void;
  onDock: () => void;
  onClose: () => void;
  locked: boolean;
  children: ReactNode;
}) {
  const drag = useRef<{
    mode: "move" | "resize";
    sx: number;
    sy: number;
    start: DockFloatRect;
  } | null>(null);

  const down = (mode: "move" | "resize") => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 不支持捕获时退化成普通 pointermove */
    }
    drag.current = { mode, sx: e.clientX, sy: e.clientY, start: { ...rect } };
  };

  const move = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (d.mode === "move") {
      onRect({
        ...d.start,
        // 标题栏至少留 120px 在视口内，窗口不会被拖丢
        x: Math.min(vw - 120, Math.max(-d.start.w + 120, d.start.x + dx)),
        y: Math.min(vh - 40, Math.max(0, d.start.y + dy)),
      });
    } else {
      onRect({
        ...d.start,
        w: Math.min(vw - d.start.x, Math.max(260, d.start.w + dx)),
        h: Math.min(vh - d.start.y, Math.max(140, d.start.h + dy)),
      });
    }
  };

  const up = (e: React.PointerEvent<HTMLElement>) => {
    if (drag.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放 */
      }
    }
    drag.current = null;
  };

  return createPortal(
    <div
      className="dock-float"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <div
        className="dock-float-head"
        style={locked ? { cursor: "default" } : undefined}
        onPointerDown={locked ? undefined : down("move")}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <span className="dock-float-grip" aria-hidden="true">⠿</span>
        <span className="dock-float-title">{label}</span>
        {!locked && (
          <>
            <button
              type="button"
              className="dock-float-btn"
              title={zh.panel.dockDock}
              aria-label={zh.panel.dockDock}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onDock}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="2" y="2.5" width="12" height="11" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <path d="M10.5 2.5v11" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              type="button"
              className="dock-float-btn"
              title={zh.dialog.close}
              aria-label={zh.dialog.close}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClose}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}
      </div>
      <div className="dock-float-body">{children}</div>
      <div
        className="dock-float-resize"
        role="separator"
        aria-label={zh.panel.dockResize}
        style={locked ? { display: "none" } : undefined}
        onPointerDown={locked ? undefined : down("resize")}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
    </div>,
    document.body,
  );
}

export default function RightDock({
  grade,
  color,
  properties,
  layers,
  history,
  navigator,
  histogram,
  scopes,
  footer,
  open: outer,
  onToggle,
  order: outerOrder,
  onOrderChange,
  detached: outerDetached,
  onDetachedChange,
  locked = false,
}: Props) {
  // 默认开颜色 / 属性 / 图层，历史 / 导航器 / 直方图按需拉出 —— 与 PhotoCraft 的初始状态一致。
  const [inner, setInner] = useState<Record<GroupId, boolean>>({
    grade: false,
    props: true,
    color: true,
    layers: true,
    history: false,
    navigator: false,
    histogram: false,
    scopes: false,
  });
  const open = outer ?? inner;

  const toggle = (id: GroupId) => {
    if (onToggle) onToggle(id);
    else setInner((v) => ({ ...v, [id]: !v[id] }));
  };

  /* ---------------------------------------------- 顺序 / 拆离（受控或自持） */

  const [innerOrder, setInnerOrder] = useState<GroupId[]>(readOrder);
  const order = outerOrder ?? innerOrder;
  const [innerDetached, setInnerDetached] =
    useState<Partial<Record<GroupId, DockFloatRect>>>(readDetached);
  const detached = outerDetached ?? innerDetached;

  const setOrder = useCallback(
    (next: GroupId[]) => {
      if (onOrderChange) onOrderChange(next);
      else setInnerOrder(next);
    },
    [onOrderChange],
  );

  const setDetached = useCallback(
    (next: Partial<Record<GroupId, DockFloatRect>>) => {
      if (onDetachedChange) onDetachedChange(next);
      else setInnerDetached(next);
    },
    [onDetachedChange],
  );

  const groupRefs = useRef(new Map<GroupId, HTMLDivElement>());
  const visibleOrderRef = useRef<GroupId[]>([]);

  // 无论如何都写一份本地：命名工作区恢复的顺序同样成为下次启动的默认布局。
  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order));
      localStorage.setItem(DETACHED_KEY, JSON.stringify(detached));
    } catch {
      /* 存储不可用时只在本次会话生效 */
    }
  }, [order, detached]);

  const detach = useCallback(
    (id: GroupId) => {
      if (locked) return;
      const r = groupRefs.current.get(id)?.getBoundingClientRect();
      const w = Math.round(Math.max(260, Math.min(600, r?.width ?? 300)));
      const h = Math.round(
        Math.max(140, Math.min(window.innerHeight - 70, r?.height ?? 260)),
      );
      const x = Math.round(
        Math.max(8, Math.min(window.innerWidth - w - 8, r?.left ?? window.innerWidth - w - 30)),
      );
      const y = Math.round(
        Math.max(8, Math.min(window.innerHeight - h - 8, r?.top ?? 60)),
      );
      setDetached({ ...detached, [id]: { x, y, w, h } });
    },
    [detached, locked, setDetached],
  );

  const dockBack = useCallback(
    (id: GroupId) => {
      const next = { ...detached };
      delete next[id];
      setDetached(next);
    },
    [detached, setDetached],
  );

  /* ------------------------------------------ 拖拽重排（只出指示线，松手才换 DOM） */

  const reorderRef = useRef<{ id: GroupId } | null>(null);
  const dropRef = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const onReorderDown = useCallback(
    (id: GroupId) => (e: React.PointerEvent<HTMLElement>) => {
      if (locked || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 退化成普通 pointermove */
      }
      reorderRef.current = { id };
    },
    [locked],
  );

  const onReorderMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!reorderRef.current) return;
    const y = e.clientY;
    let idx = 0;
    groupRefs.current.forEach((el, id) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (y > r.top + r.height / 2) {
        // visibleOrder 的下标，稍后映射回全局 order
        idx = Math.max(idx, (visibleOrderRef.current.indexOf(id) + 1) || 0);
      }
    });
    dropRef.current = idx;
    setDropIndex(idx);
  }, []);

  const onReorderUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = reorderRef.current;
      if (!d) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放 */
      }
      reorderRef.current = null;
      const at = dropRef.current;
      dropRef.current = null;
      setDropIndex(null);
      if (at == null || locked) return;

      setOrder(reorderDockPanel(order, visibleOrderRef.current, d.id, at));
    },
    [locked, order, setOrder],
  );

  /* ---------------------------------------------------- 面板高度（可拖） */

  /**
   * 每个面板组的高度。用户拖着分隔条改，改完记在本地。
   *
   * 之前所有高度都是 CSS 写死的（is-layers 吃剩余空间、其它 flex:0 0 auto），
   * 所以「属性」这种想要高一点的面板永远只有固定高度 —— 现在每块都能自己拉。
   */
  const [heights, setHeights] = useState<Record<string, number>>(() => readHeights());
  const dragRef = useRef<{ id: GroupId; startY: number; startH: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_KEY, JSON.stringify(heights));
    } catch {
      /* 存储不可用时只在本次会话生效 */
    }
  }, [heights]);

  const onSplitDown = useCallback(
    (id: GroupId) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { id, startY: e.clientY, startH: heights[id] ?? DEFAULT_HEIGHTS[id] ?? 200 };
    },
    [heights],
  );

  const onSplitMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = Math.max(MIN_H[d.id] ?? 80, Math.min(900, d.startH + (e.clientY - d.startY)));
    setHeights((h) => ({ ...h, [d.id]: next }));
  }, []);

  const onSplitUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放 */
      }
    }
    dragRef.current = null;
  }, []);

  /* ------------------------------------------------- 坞宽（整列横向拖拽） */

  /**
   * 右侧这一列的宽度。
   *
   * 之前写死 326px：调色台那种要横着摆滑杆的面板塞进去就挤成一团，
   * 用户只能对着几十像素的滑杆调色。现在左边缘可以拖（还没拖过就用默认值），
   * 拖完记住，双击把手的回默认。
   */
  const [dockW, setDockW] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(W_KEY));
      return Number.isFinite(v) && v >= MIN_W && v <= MAX_W ? v : DEFAULT_W;
    } catch {
      return DEFAULT_W;
    }
  });
  const wDrag = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(W_KEY, String(dockW));
    } catch {
      /* 存不了就只管本次会话 */
    }
  }, [dockW]);

  const onGripDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      wDrag.current = { x: e.clientX, w: dockW };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [dockW],
  );
  const onGripMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = wDrag.current;
    if (!d) return;
    // 往左拖变宽（坞贴在右边）
    const next = Math.round(d.w - (e.clientX - d.x));
    const cap = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth * 0.62));
    setDockW(Math.max(MIN_W, Math.min(cap, next)));
  }, []);
  const onGripUp = useCallback(() => {
    wDrag.current = null;
  }, []);

  /** 双击分隔条：恢复该面板默认高度。 */
  const onSplitReset = useCallback(
    (id: GroupId) => () => {
      setHeights((h) => ({ ...h, [id]: DEFAULT_HEIGHTS[id] ?? 200 }));
    },
    [],
  );

  const PANELS: Record<GroupId, { node: ReactNode; cls: string }> = {
    grade: { node: grade, cls: "is-grade" },
    navigator: { node: navigator, cls: "is-navigator" },
    scopes: { node: scopes, cls: "is-scopes" },
    histogram: { node: histogram, cls: "is-histogram" },
    color: { node: color, cls: "is-color" },
    props: { node: properties, cls: "is-props" },
    layers: { node: layers, cls: "is-layers" },
    history: { node: history, cls: "is-history" },
  };
  // 顺序由 order 决定；拆出去的面板在坞里消失，但开关仍为 true，归位后原地回来。
  const groups = order
    .filter((id) => open[id] && !detached[id])
    .map((id) => ({ id, ...PANELS[id] }));
  visibleOrderRef.current = groups.map((g) => g.id);

  const floats = ALL_GROUPS.filter((id) => open[id] && detached[id]);

  return (
    <>
    <aside className="dock" aria-label={zh.panel.dock} style={{ width: dockW }}>
      {/* 上半部分：把手 + 开关轨 + 面板列（这部分才跟着窗口伸缩） */}
      <div className="dock-row">
      <div
        className="dock-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整面板列宽度"
        title="拖动调整宽度 · 双击恢复默认"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onDoubleClick={() => setDockW(DEFAULT_W)}
      />
      <div className="dock-rail" role="toolbar" aria-label={zh.panel.dockRail}>
        {RAIL.map((g) => (
          <button
            key={g.id}
            type="button"
            className={open[g.id] ? "dock-rail-btn is-on" : "dock-rail-btn"}
            aria-pressed={open[g.id]}
            title={g.label}
            aria-label={g.label}
            onClick={() => toggle(g.id)}
          >
            {g.icon}
          </button>
        ))}
      </div>

      <div className="dock-body">
        {groups.map((g, i) => (
          <Fragment key={g.id}>
            <div
              ref={(el) => {
                if (el) groupRefs.current.set(g.id, el);
                else groupRefs.current.delete(g.id);
              }}
              className={
                `dock-group ${g.cls}` +
                (dropIndex === i ? " is-drop-before" : "") +
                (dropIndex === groups.length && i === groups.length - 1 ? " is-drop-after" : "")
              }
              style={{
                height: heights[g.id] ?? DEFAULT_HEIGHTS[g.id],
                /**
                 * 最后一块负责吃掉剩余高度 —— 否则所有面板都拖到最短时，
                 * 底下会空出一大片（看起来像凭空多了一块深色方块）。
                 * 它仍然按自己拖出来的高度为基准，只是多出来的部分归它。
                 */
                flex: i === groups.length - 1 ? "1 1 auto" : "0 0 auto",
                minHeight: MIN_H[g.id] ?? 80,
              }}
            >
              {g.node}
              {/* 悬浮操作条：不占布局、不顶掉面板原有页签；只有 hover 才显形 */}
              {!locked && (
                <div className="dock-group-tools">
                  <span
                    className="dock-group-drag"
                    title={zh.panel.dockReorder}
                    aria-label={zh.panel.dockReorder}
                    onPointerDown={onReorderDown(g.id)}
                    onPointerMove={onReorderMove}
                    onPointerUp={onReorderUp}
                    onPointerCancel={onReorderUp}
                  >
                    ⠿
                  </span>
                  <button
                    type="button"
                    className="dock-group-tool"
                    title={zh.panel.dockDetach}
                    aria-label={zh.panel.dockDetach}
                    onClick={() => detach(g.id)}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M9 2.5h4.5V7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M13.5 2.5 8 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      <path d="M12.5 10v3.5H3V3h3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
            {i < groups.length - 1 && (
              <div
                className="dock-split"
                role="separator"
                aria-orientation="horizontal"
                aria-label="拖动调整面板高度"
                title="拖动调整高度 · 双击恢复默认"
                onPointerDown={onSplitDown(g.id)}
                onPointerMove={onSplitMove}
                onPointerUp={onSplitUp}
                onPointerCancel={onSplitUp}
                onDoubleClick={onSplitReset(g.id)}
              />
            )}
          </Fragment>
        ))}
        {/* 最后一块之下给一点空白，避免贴底太紧 */}
        <div className="dock-tail" aria-hidden="true" />
      </div>
      </div>

      {/**
       * 坞底固定条：不属于任何面板，所以面板怎么拖高拖矮、折叠展开，
       * 它都钉在同一个位置（用户要的「永永远远在那儿」）。
       */}
      {footer && <div className="dock-footer">{footer}</div>}
    </aside>

    {floats.map((id) => (
      <FloatPanel
        key={id}
        label={RAIL.find((g) => g.id === id)?.label ?? id}
        rect={detached[id]!}
        onRect={(r) => setDetached({ ...detached, [id]: r })}
        onDock={() => dockBack(id)}
        onClose={() => toggle(id)}
        locked={locked}
      >
        <div className={`dock-group ${PANELS[id].cls} is-floating`}>
          {PANELS[id].node}
        </div>
      </FloatPanel>
    ))}
    </>
  );
}
