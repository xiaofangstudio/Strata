/**
 * 左侧工具轨。
 *
 * 立项规划书 §7.1：工具不做折叠菜单，直接铺开、随手可点；靠形状与快捷键
 * 相互区分。默认按「双列密集网格 + 分组细线」排布，列数与工具的显隐都可
 * 在偏好设置（P）里调整，工具多起来也不用滚动找。
 *
 * 点击是两态：
 *  · 单击 —— 选中这个工具；
 *  · 双击 —— 在按钮右侧叫出它的二级面板（颜色 / 笔刷 / 该工具自己的一套参数）。
 *    再点别处、按 Esc 都收起；单击已经打开面板的那个工具也会收起。
 *
 * `ready: false` 的工具按禁用态渲染并给出说明，点了不会没反应。
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { zh } from "../../i18n/zh-CN";
import { usePrefs } from "../../stores/prefs";
import { TOOL_GROUPS, toolsInGroup, type ToolGroupId, type ToolId } from "../../tools/catalog";
import ToolIcon from "./ToolIcon";
import ColorPicker from "./ColorPicker";
import "./picker.css";
import "./ToolRail.css";

interface Props {
  tool: ToolId;
  onSelect: (id: ToolId) => void;
  /** 前景 / 背景色，放在工具轨底部，与 PS 的习惯一致 */
  fg: string;
  bg: string;
  onFg: (hex: string) => void;
  onBg: (hex: string) => void;
  onSwap: () => void;
  /** 打开偏好设置（工具轨右下角的齿形按钮） */
  onOpenPrefs: () => void;
  /** 二级面板的内容：由编辑壳按工具现做，工具轨只负责摆放与开关 */
  flyout?: (id: ToolId) => ReactNode;
}

/** 分组 id → 中文名所在的字典键。 */
const GROUP_LABEL: Record<ToolGroupId, string> = {
  transform: zh.tools.groupTransform,
  select: zh.tools.groupSelect,
  shape: zh.tools.groupShape,
  text: zh.tools.groupText,
  paint: zh.tools.groupPaint,
  retouch: zh.tools.groupRetouch,
  sample: zh.tools.groupSample,
  crop: zh.tools.groupCrop,
  nav: zh.tools.groupNav,
};

/** 二级面板在屏幕上的落点。 */
interface FlyPos {
  id: ToolId;
  left: number;
  top: number;
}

/** 面板高度估个上界，用来把落点夹在视口内，不让它顶出屏幕。 */
const FLY_MAX_H = 420;

export default function ToolRail({
  tool,
  onSelect,
  fg,
  bg,
  onFg,
  onBg,
  onSwap,
  onOpenPrefs,
  flyout,
}: Props) {
  const prefs = usePrefs();
  const visible = (id: ToolId) => !prefs.hiddenTools.includes(id);

  const [fly, setFly] = useState<FlyPos | null>(null);

  const closeFly = useCallback(() => setFly(null), []);

  // 换了工具（快捷键、工作区切换、菜单）就把面板收掉，免得挂在旧工具上
  useEffect(() => {
    setFly(null);
  }, [tool]);

  useEffect(() => {
    if (!fly) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 点面板内部、点工具按钮都交给各自的点击逻辑处理；
      // 颜色浮层被 portal 到 body 上，也在面板的语义范围内，不能当成「点了外面」。
      if (
        t?.closest(".tool-flyout") ||
        t?.closest(".tool-btn") ||
        t?.closest(".color-pop") ||
        t?.closest(".swatch-pop2") ||
        t?.closest(".swatch")
      )
        return;
      setFly(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 颜色浮层开着时，Esc 先收浮层（它自己也会收），别顺手把整个面板也关了
      if (document.querySelector(".color-pop") || document.querySelector(".swatch-pop2")) return;
      setFly(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    // 滚动 / 改窗口大小之后按钮已经不在原处，锚点失效就直接收起
    window.addEventListener("scroll", closeFly, true);
    window.addEventListener("resize", closeFly);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", closeFly, true);
      window.removeEventListener("resize", closeFly);
    };
  }, [fly, closeFly]);

  /** 单击：选中这个工具；若它已选中且面板正开着，则收起面板。 */
  const clickTool = (id: ToolId) => {
    if (id !== tool) {
      setFly(null);
      onSelect(id);
      return;
    }
    if (fly?.id === id) setFly(null);
  };

  /** 双击：选中并在按钮右侧叫出二级面板。 */
  const dblTool = (id: ToolId, el: HTMLButtonElement) => {
    if (id !== tool) onSelect(id);
    const r = el.getBoundingClientRect();
    const top = Math.min(Math.max(8, r.top - 4), Math.max(8, window.innerHeight - FLY_MAX_H));
    setFly({ id, left: r.right + 10, top });
  };

  return (
    <aside
      className="toolrail"
      aria-label={zh.tools.rail}
      style={{ ["--tool-cols" as string]: prefs.columns }}
    >
      {TOOL_GROUPS.map((group, gi) => {
        const list = toolsInGroup(group).filter((t) => visible(t.id));
        if (list.length === 0) return null;
        return (
          <Fragment key={group}>
            {gi > 0 && <span className="toolrail-sep" role="separator" />}
            <div className="toolrail-group" role="group" aria-label={GROUP_LABEL[group]}>
              {list.map((t) => {
                const label = zh.tools[t.id];
                const active = t.id === tool;
                const open = fly?.id === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={active ? "tool-btn is-on" : "tool-btn"}
                    aria-pressed={active}
                    aria-expanded={active ? open : undefined}
                    disabled={!t.ready}
                    title={
                      t.ready
                        ? `${label}（${t.shortcut}）· ${zh.tools.dblHint}`
                        : `${label}（${t.shortcut}）· ${zh.tools.notReady}`
                    }
                    onClick={() => clickTool(t.id)}
                    onDoubleClick={(e) => dblTool(t.id, e.currentTarget)}
                  >
                    <ToolIcon id={t.id} />
                  </button>
                );
              })}
            </div>
          </Fragment>
        );
      })}

      <span className="toolrail-spacer" />
      <ColorSwatch fg={fg} bg={bg} onFg={onFg} onBg={onBg} onSwap={onSwap} />
      <button
        type="button"
        className="toolrail-gear"
        title={`${zh.preferences.title}（P）`}
        onClick={onOpenPrefs}
      >
        <ToolIcon id="gear" size={16} />
      </button>

      {fly &&
        flyout &&
        createPortal(
          <div
            className="tool-flyout"
            role="dialog"
            aria-label={`${zh.tools[fly.id]} · ${zh.tools.flyout}`}
            style={{ left: fly.left, top: fly.top }}
          >
            {flyout(fly.id)}
          </div>,
          document.body,
        )}
    </aside>
  );
}

/* ---------------- 前景 / 背景色 ---------------- */

interface SwatchProps {
  fg: string;
  bg: string;
  onFg: (hex: string) => void;
  onBg: (hex: string) => void;
  onSwap: () => void;
}

/** 色块尺寸（对应下面 .swatch-chip 的宽高），用于算浮层位置。 */
const CHIP = 26;

/** 前景 / 背景色块：点开是浮层（portal 到 body，不会被工具轨的 overflow 裁掉）。 */
function ColorSwatch({ fg, bg, onFg, onBg, onSwap }: SwatchProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"fg" | "bg">("fg");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    // 浮层挂 body + position:fixed：工具轨本身是 overflow:auto 的滚动容器，
    // 绝对定位的子元素会被裁掉（点上去像没反应），这样绕开。
    const place = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const W = 236;
      const H = 336;
      let left = Math.round(r.right + 10);
      if (left + W > window.innerWidth - 8) left = Math.max(8, Math.round(r.left - 10 - W));
      let top = Math.round(r.bottom - H);
      top = Math.max(8, Math.min(top, Math.max(8, window.innerHeight - H - 8)));
      setPos({ left, top });
    };
    place();

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
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

  const value = tab === "fg" ? fg : bg;
  const change = tab === "fg" ? onFg : onBg;

  return (
    <div className="swatch" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="swatch-stack"
        onClick={() => setOpen((v) => !v)}
        title={`${zh.options.color} · ${zh.tools.swap}`}
        aria-expanded={open}
      >
        <span
          className="swatch-chip swatch-bg"
          style={{ background: bg, width: CHIP, height: CHIP }}
        />
        <span
          className="swatch-chip swatch-fg"
          style={{ background: fg, width: CHIP, height: CHIP }}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="swatch-pop2"
            role="dialog"
            aria-label={zh.options.color}
            style={{ position: "fixed", left: pos.left, top: pos.top }}
          >
            <div className="swatch-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "fg"}
                className={tab === "fg" ? "swatch-tab is-on" : "swatch-tab"}
                onClick={() => setTab("fg")}
              >
                <i style={{ background: fg }} />
                {zh.tools.fg}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "bg"}
                className={tab === "bg" ? "swatch-tab is-on" : "swatch-tab"}
                onClick={() => setTab("bg")}
              >
                <i style={{ background: bg }} />
                {zh.tools.bgColor}
              </button>
            </div>
            <ColorPicker hex={value} onChange={change} />
            <button type="button" className="btn-ghost btn-xs swatch-swap" onClick={onSwap}>
              X · {zh.tools.swap}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
