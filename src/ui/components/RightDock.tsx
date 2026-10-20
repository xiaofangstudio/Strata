/**
 * 右侧面板坞（对齐 PhotoCraft 的右侧 docker）。
 *
 * 一条 36px 的竖排开关轨 + 一列面板：点轨道上的图标开 / 关对应面板组，
 * 打开的面板自上而下堆叠。颜色、属性、图层、历史、导航器、直方图都是
 * 真实面板，没做的（路径、通道独立页）就不放入口 —— 不做假控件。
 */
import { useState, type ReactNode } from "react";
import { zh } from "../../i18n/zh-CN";
import "./RightDock.css";

type GroupId = "props" | "color" | "layers" | "history" | "navigator" | "histogram";

export type { GroupId };

interface Props {
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
  /** 受控开关（「窗口 > 面板」菜单直接控制）；不传则坞内自持。 */
  open?: Record<GroupId, boolean>;
  onToggle?: (id: GroupId) => void;
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

export default function RightDock({
  color,
  properties,
  layers,
  history,
  navigator,
  histogram,
  open: outer,
  onToggle,
}: Props) {
  // 默认开颜色 / 属性 / 图层，历史 / 导航器 / 直方图按需拉出 —— 与 PhotoCraft 的初始状态一致。
  const [inner, setInner] = useState<Record<GroupId, boolean>>({
    props: true,
    color: true,
    layers: true,
    history: false,
    navigator: false,
    histogram: false,
  });
  const open = outer ?? inner;

  const toggle = (id: GroupId) => {
    if (onToggle) onToggle(id);
    else setInner((v) => ({ ...v, [id]: !v[id] }));
  };

  return (
    <aside className="dock" aria-label={zh.panel.dock}>
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
        {open.navigator && <div className="dock-group is-navigator">{navigator}</div>}
        {open.histogram && <div className="dock-group is-histogram">{histogram}</div>}
        {open.color && <div className="dock-group is-color">{color}</div>}
        {open.props && <div className="dock-group is-props">{properties}</div>}
        {open.layers && <div className="dock-group is-layers">{layers}</div>}
        {open.history && <div className="dock-group is-history">{history}</div>}
      </div>
    </aside>
  );
}
