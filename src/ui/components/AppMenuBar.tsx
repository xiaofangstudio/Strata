import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./AppMenuBar.css";

/** 菜单里的一个可点条目。 */
export interface MenuAction {
  kind?: "item";
  /** 稳定的命令 id，便于命令面板与菜单共用同一份定义 */
  id?: string;
  label: string;
  /** 右侧的快捷键或说明文字 */
  hint?: string;
  /** 右上角小标记，例如未实现功能挂的「M1」 */
  badge?: string;
  disabled?: boolean;
  /** 勾选态（面板开关、显示项等） */
  checked?: boolean;
  /** 二级 / 三级菜单 */
  children?: MenuEntry[];
  onSelect?: () => void;
}

/** 菜单里的分隔线。 */
export interface MenuSep {
  kind: "sep";
}

export type MenuEntry = MenuAction | MenuSep;

/** 一个顶层菜单（文件 / 编辑 / 帮助）。 */
export interface MenuGroup {
  key: string;
  label: string;
  items: MenuEntry[];
}

interface Props {
  groups: MenuGroup[];
  /** 收起菜单时是否把焦点还给触发按钮 */
  className?: string;
}

function isSep(entry: MenuEntry): entry is MenuSep {
  return entry.kind === "sep";
}

/** 同级移动：跳过分隔线与禁用项，首尾循环。 */
function step(items: MenuEntry[], index: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = index;
  for (let k = 0; k < n; k += 1) {
    i = (i + dir + n) % n;
    const entry = items[i];
    if (!isSep(entry) && !entry.disabled) return i;
  }
  return index;
}

/**
 * 展开子菜单时默认高亮哪一项。
 *
 * 优先第一个可用项；整栏都未实现时退回第一个条目 —— 子菜单照样能展开，
 * 让用户看得见「有这些功能，只是还没做」，而不是整个菜单打不开。
 */
function firstEnabled(items: MenuEntry[]): number {
  let fallback = -1;
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i];
    if (isSep(entry)) continue;
    if (!entry.disabled) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

function itemsAt(items: MenuEntry[], path: number[]): MenuEntry[] {
  let list = items;
  for (const index of path) {
    const entry = list[index];
    if (!entry || isSep(entry) || !entry.children) return [];
    list = entry.children;
  }
  return list;
}

function actionAt(items: MenuEntry[], path: number[]): MenuAction | undefined {
  if (path.length === 0) return undefined;
  const parent = itemsAt(items, path.slice(0, -1));
  const entry = parent[path[path.length - 1]];
  return entry && !isSep(entry) ? entry : undefined;
}

function samePath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface ListProps {
  items: MenuEntry[];
  path: number[];
  active: number[];
  depth: number;
  onHover: (path: number[]) => void;
  onEnter: (path: number[]) => void;
  onRun: (item: MenuAction) => void;
}

function MenuList({ items, path, active, depth, onHover, onEnter, onRun }: ListProps) {
  return (
    <>
      {items.map((entry, index) => {
        if (isSep(entry)) {
          return <div className="menu-sep" role="separator" key={`sep-${index}`} />;
        }
        return (
          <MenuRow
            key={index}
            item={entry}
            path={[...path, index]}
            active={active}
            depth={depth}
            onHover={onHover}
            onEnter={onEnter}
            onRun={onRun}
          />
        );
      })}
    </>
  );
}

interface RowProps {
  item: MenuAction;
  path: number[];
  active: number[];
  depth: number;
  onHover: (path: number[]) => void;
  onEnter: (path: number[]) => void;
  onRun: (item: MenuAction) => void;
}

function MenuRow({ item, path, active, depth, onHover, onEnter, onRun }: RowProps) {
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);
  const hasChildren = item.children?.some((child) => !isSep(child)) ?? false;
  const isActive = samePath(active, path);
  const isOpen =
    hasChildren && active.length > path.length && path.every((value, index) => value === active[index]);

  return (
    <div
      className="menu-item"
      ref={setRowEl}
      onMouseEnter={() => {
        if (item.disabled) return;
        if (hasChildren) {
          const first = firstEnabled(item.children ?? []);
          onHover(first >= 0 ? [...path, first] : path);
        } else {
          onHover(path);
        }
      }}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup={hasChildren ? "menu" : undefined}
        aria-expanded={hasChildren ? isOpen : undefined}
        aria-checked={item.checked}
        className={[
          "menu-row",
          isActive ? "is-active" : "",
          hasChildren ? "is-sub" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        disabled={item.disabled}
        title={item.disabled ? item.hint : undefined}
        onClick={() => {
          if (item.disabled) return;
          if (hasChildren) onEnter(path);
          else onRun(item);
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
          item.hint &&
          !item.badge && <span className="menu-hint">{item.hint}</span>
        )}
      </button>

      {isOpen && item.children && rowEl && (
        <SubMenu anchor={rowEl} label={item.label} level={depth + 1}>
          <MenuList
            items={item.children}
            path={path}
            active={active}
            depth={depth + 1}
            onHover={onHover}
            onEnter={onEnter}
            onRun={onRun}
          />
        </SubMenu>
      )}
    </div>
  );
}

interface SubMenuProps {
  anchor: HTMLElement;
  label: string;
  level: number;
  children: ReactNode;
}

/** 子菜单挂到 body 上：长菜单可滚动，浮层也不会被父级滚动容器裁切。 */
function SubMenu({ anchor, label, level, children }: SubMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
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
      setPos((prev) =>
        prev && prev.left === left && prev.top === top ? prev : { left, top },
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  return createPortal(
    <div
      className="menu-pop is-sub"
      role="menu"
      aria-label={label}
      data-level={level}
      ref={ref}
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * 顶部主菜单条。
 *
 * 结构对齐 PhotoCraft：一级 / 二级 / 三级菜单、分隔线、勾选、禁用。
 * 未实现的能力一律禁用置灰，不做假可用。
 */
export default function AppMenuBar({ groups, className }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [active, setActive] = useState<number[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const group = groups.find((item) => item.key === open);
  const items = group?.items ?? [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (rootRef.current?.contains(target as Node)) return;
      // 子菜单挂在 body 上，点击它们不算「点到了外面」
      if (target?.closest?.(".menu-pop")) return;
      setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const show = (key: string) => {
      const target = groups.find((item) => item.key === key);
      if (!target) return;
      setOpen(key);
      const first = firstEnabled(target.items);
      setActive(first >= 0 ? [first] : []);
    };

    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape": {
          e.preventDefault();
          if (active.length > 1) setActive(active.slice(0, -1));
          else setOpen(null);
          break;
        }
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const parentPath = active.slice(0, -1);
          const list = itemsAt(items, parentPath);
          const current = active[active.length - 1] ?? -1;
          const next = step(list, current, e.key === "ArrowDown" ? 1 : -1);
          if (next >= 0) setActive([...parentPath, next]);
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const current = actionAt(items, active);
          if (current?.children && current.children.some((child) => !isSep(child))) {
            const first = firstEnabled(current.children);
            if (first >= 0) setActive([...active, first]);
          } else if (open) {
            const index = groups.findIndex((item) => item.key === open);
            const next = groups[(index + 1) % groups.length];
            if (next) show(next.key);
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (active.length > 1) {
            setActive(active.slice(0, -1));
          } else if (open) {
            const index = groups.findIndex((item) => item.key === open);
            const next = groups[(index - 1 + groups.length) % groups.length];
            if (next) show(next.key);
          }
          break;
        }
        case "Enter":
        case " ": {
          const current = actionAt(items, active);
          if (!current || current.disabled) break;
          e.preventDefault();
          if (current.children && current.children.some((child) => !isSep(child))) {
            const first = firstEnabled(current.children);
            if (first >= 0) setActive([...active, first]);
          } else {
            setOpen(null);
            current.onSelect?.();
          }
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, active, items, groups]);

  return (
    <div
      className={className ? `menubar ${className}` : "menubar"}
      role="menubar"
      ref={rootRef}
    >
      {groups.map((g) => {
        const isOpen = open === g.key;
        return (
          <div className="menubar-slot" key={g.key}>
            <button
              type="button"
              className={isOpen ? "menubar-btn is-open" : "menubar-btn"}
              aria-haspopup="true"
              aria-expanded={isOpen}
              onClick={() => {
                if (isOpen) {
                  setOpen(null);
                  return;
                }
                setOpen(g.key);
                const first = firstEnabled(g.items);
                setActive(first >= 0 ? [first] : []);
              }}
              onMouseEnter={() => {
                if (!open || open === g.key) return;
                setOpen(g.key);
                const first = firstEnabled(g.items);
                setActive(first >= 0 ? [first] : []);
              }}
            >
              {g.label}
            </button>

            {isOpen && (
              <div
                className="menu-pop"
                role="menu"
                aria-label={g.label}
                onScroll={() => {
                  if (active.length > 1) setActive(active.slice(0, 1));
                }}
              >
                <MenuList
                  items={g.items}
                  path={[]}
                  active={active}
                  depth={0}
                  onHover={setActive}
                  onEnter={(path) => {
                    const current = actionAt(g.items, path);
                    if (!current?.children) return;
                    const first = firstEnabled(current.children);
                    setActive(first >= 0 ? [...path, first] : path);
                  }}
                  onRun={(item) => {
                    setOpen(null);
                    item.onSelect?.();
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
