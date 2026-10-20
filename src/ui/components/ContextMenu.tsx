/**
 * 通用右键菜单浮层。
 *
 * 与顶部菜单共用同一套 `MenuEntry` 类型与 `.menu-pop` 样式：条目、分隔线、
 * 勾选、快捷键提示、置灰、二级子菜单全部支持。挂 body 上定位，视口内自动
 * 收边；Escape / 点击外部 / 滚动视口即关闭。
 *
 * 复用方：画布右键（EditorShell）、图层面板行右键 / 蒙版缩略图右键（LayersPanel）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MenuAction, MenuEntry } from "./AppMenuBar";

export interface ContextMenuState {
  /** 视口坐标（e.clientX / clientY） */
  x: number;
  y: number;
  entries: MenuEntry[];
}

function isSep(entry: MenuEntry): entry is { kind: "sep" } {
  return (entry as { kind?: string }).kind === "sep";
}

/** 子菜单挂在 body 上，贴着宿主行展开，视口内收边。 */
function SubMenu({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = rect.right + 4;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, rect.left - width - 4);
    }
    let top = rect.top - 5;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - height - 8);
    }
    setPos({ left, top });
  }, [anchor]);

  return createPortal(
    <div
      className="menu-pop is-sub"
      role="menu"
      ref={ref}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}

function Row({ item, onRun }: { item: MenuAction; onRun: (item: MenuAction) => void }) {
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);
  const [subOpen, setSubOpen] = useState(false);
  const hasChildren = item.children?.some((c) => !isSep(c)) ?? false;

  return (
    <div
      className="menu-item"
      ref={setRowEl}
      onMouseEnter={() => setSubOpen(hasChildren)}
      onMouseLeave={() => setSubOpen(false)}
    >
      <button
        type="button"
        role="menuitem"
        className={["menu-row", hasChildren ? "is-sub" : ""].filter(Boolean).join(" ")}
        disabled={item.disabled}
        onClick={() => {
          if (item.disabled) return;
          if (hasChildren) {
            setSubOpen(true);
            return;
          }
          onRun(item);
        }}
      >
        <span className="menu-check" aria-hidden="true">
          {item.checked ? "✓" : ""}
        </span>
        <span className="menu-row-label">{item.label}</span>
        {item.badge && <span className="menu-badge">{item.badge}</span>}
        {hasChildren ? (
          <span className="menu-arrow" aria-hidden="true">
            ›
          </span>
        ) : (
          item.hint && !item.badge && <span className="menu-hint">{item.hint}</span>
        )}
      </button>

      {subOpen && item.children && rowEl && (
        <SubMenu anchor={rowEl}>
          <MenuRows items={item.children} onRun={onRun} />
        </SubMenu>
      )}
    </div>
  );
}

function MenuRows({
  items,
  onRun,
}: {
  items: MenuEntry[];
  onRun: (item: MenuAction) => void;
}) {
  return (
    <>
      {items.map((entry, i) =>
        isSep(entry) ? (
          <div className="menu-sep" role="separator" key={`sep-${i}`} />
        ) : (
          <Row key={`${entry.label}-${i}`} item={entry} onRun={onRun} />
        ),
      )}
    </>
  );
}

/**
 * 右键菜单本体。`menu` 为 null 时不渲染；打开时全局接 Escape / 外点 / 滚轮关闭。
 */
export default function ContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = menu.x;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    let top = menu.y;
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
    setPos({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (ref.current?.contains(target as Node)) return;
      if (target?.closest?.(".menu-pop")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = (e: Event) => {
      // 自己内部滚动不关（长菜单要滚）
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onScroll, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onScroll);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <div
      className="menu-pop is-context"
      role="menu"
      ref={ref}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuRows
        items={menu.entries}
        onRun={(item) => {
          item.onSelect?.();
          onClose();
        }}
      />
    </div>,
    document.body,
  );
}
