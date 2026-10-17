import { useEffect, useRef, useState } from "react";
import "./AppMenuBar.css";

/** 菜单里的一个可点条目。 */
export interface MenuAction {
  kind?: "item";
  label: string;
  /** 右侧的快捷键或说明文字 */
  hint?: string;
  /** 右上角小标记，例如未实现功能挂的「M1」 */
  badge?: string;
  disabled?: boolean;
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

/**
 * 顶部主菜单条。
 *
 * 立项规划书 §7.5：开始页面顶部要保留应用标识与主菜单入口（文件 / 编辑 / 帮助）。
 * 规划书 §7.1：菜单入口保留，另配命令面板（Ctrl + K，随 M1 提供）。
 * 这里只做「真能用」的菜单 —— 未实现的能力挂 M1 标记并禁用，不做假可用。
 */
export default function AppMenuBar({ groups, className }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
              onClick={() => setOpen(isOpen ? null : g.key)}
              onMouseEnter={() => {
                if (open) setOpen(g.key);
              }}
            >
              {g.label}
            </button>

            {isOpen && (
              <div className="menu-pop" role="menu" aria-label={g.label}>
                {g.items.map((it, i) =>
                  it.kind === "sep" ? (
                    <div className="menu-sep" role="separator" key={`s${i}`} />
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      key={it.label}
                      className="menu-row"
                      disabled={it.disabled}
                      title={it.disabled ? it.hint : undefined}
                      onClick={() => {
                        if (it.disabled) return;
                        setOpen(null);
                        it.onSelect?.();
                      }}
                    >
                      <span className="menu-row-label">{it.label}</span>
                      {it.badge && <span className="menu-badge">{it.badge}</span>}
                      {it.hint && !it.badge && (
                        <span className="menu-hint">{it.hint}</span>
                      )}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
