/**
 * 常驻调色面板（右侧 Docker）。
 *
 * 与 PS 的「颜色」面板同义：前景 / 背景色就在画布旁边，随时改、随时看得见，
 * 不用再去工具轨点小色块开浮层。面板里每个控件都直接落到 `fg` / `bg`，
 * 也就是画笔、油漆桶、渐变、形状、文字真正使用的颜色。
 */
import { useEffect, useState } from "react";
import { zh } from "../../i18n/zh-CN";
import type { ToolId } from "../../tools/catalog";
import { normalizeHex, STANDARD_SWATCHES } from "../color-utils";
import {
  addSavedColor,
  removeSavedColor,
  touchRecentColor,
  useColorSwatches,
} from "../color-swatches";
import ColorPicker from "./ColorPicker";
import ToolIcon from "./ToolIcon";
import "./ColorPanel.css";

export interface ColorPanelProps {
  fg: string;
  bg: string;
  onFg: (hex: string) => void;
  onBg: (hex: string) => void;
  onSwap: () => void;
  onReset: () => void;
  onPickTool: (id: ToolId) => void;
}

type Target = "fg" | "bg";

export default function ColorPanel({
  fg,
  bg,
  onFg,
  onBg,
  onSwap,
  onReset,
  onPickTool,
}: ColorPanelProps) {
  const [target, setTarget] = useState<Target>("fg");
  const [open, setOpen] = useState(true);
  const swatches = useColorSwatches();

  const active = normalizeHex(target === "fg" ? fg : bg) ?? "#000000";
  const apply = (hex: string) => {
    const ok = normalizeHex(hex);
    if (!ok) return;
    if (target === "fg") onFg(ok);
    else onBg(ok);
  };

  // 拖滑杆时会连发很多中间色，停手 0.6 秒才记一条「最近使用」。
  useEffect(() => {
    const t = window.setTimeout(() => touchRecentColor(active), 600);
    return () => window.clearTimeout(t);
  }, [active]);

  return (
    <section className="cp-panel" aria-label={zh.colorPanel.title}>
      <button
        type="button"
        className="cp-panel-head"
        aria-expanded={open}
        title={zh.colorPanel.expand}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cp-panel-title">{zh.colorPanel.title}</span>
        <span className={open ? "cp-chev is-on" : "cp-chev"} aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="cp-panel-body">
          <div className="cp-fgbg">
            <div className="cp-fgbg-stack">
              <button
                type="button"
                className={target === "fg" ? "cp-chip cp-chip-fg is-on" : "cp-chip cp-chip-fg"}
                style={{ background: fg }}
                title={`${zh.tools.fg} ${fg.toUpperCase()}`}
                aria-label={zh.tools.fg}
                aria-pressed={target === "fg"}
                onClick={() => setTarget("fg")}
              />
              <button
                type="button"
                className={target === "bg" ? "cp-chip cp-chip-bg is-on" : "cp-chip cp-chip-bg"}
                style={{ background: bg }}
                title={`${zh.tools.bgColor} ${bg.toUpperCase()}`}
                aria-label={zh.tools.bgColor}
                aria-pressed={target === "bg"}
                onClick={() => setTarget("bg")}
              />
            </div>
            <div className="cp-fgbg-tools">
              <button type="button" className="cp-mini" title={zh.options.swap} onClick={onSwap}>
                ⇄
              </button>
              <button
                type="button"
                className="cp-mini cp-mini-reset"
                title={zh.options.colorsDefault}
                aria-label={zh.options.colorsDefault}
                onClick={onReset}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect x="1" y="1" width="7" height="7" fill="#111" stroke="currentColor" />
                  <rect x="4" y="4" width="7" height="7" fill="#fff" stroke="currentColor" />
                </svg>
              </button>
            </div>
            <span className="cp-fgbg-gap" />
            <button
              type="button"
              className="cp-eyedrop"
              title={zh.colorPanel.eyedropper}
              aria-label={zh.colorPanel.eyedropper}
              onClick={() => onPickTool("eyedropper")}
            >
              <ToolIcon id="eyedropper" size={16} />
            </button>
          </div>

          <ColorPicker hex={active} onChange={apply} detailed />

          <div className="cp-sw-section">
            <div className="cp-sw-head">
              <span>{zh.colorPanel.standard}</span>
            </div>
            <div className="cp-sw-grid">
              {STANDARD_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c === active ? "cp-sw is-on" : "cp-sw"}
                  style={{ background: c }}
                  title={c.toUpperCase()}
                  aria-label={c.toUpperCase()}
                  onClick={() => apply(c)}
                />
              ))}
            </div>
          </div>

          <div className="cp-sw-section">
            <div className="cp-sw-head">
              <span>{zh.colorPanel.saved}</span>
              <button
                type="button"
                className="cp-sw-save"
                title={zh.colorPanel.save}
                aria-label={zh.colorPanel.save}
                onClick={() => addSavedColor(active)}
              >
                +
              </button>
            </div>
            {swatches.saved.length === 0 ? (
              <p className="cp-sw-empty">{zh.colorPanel.savedEmpty}</p>
            ) : (
              <div className="cp-sw-grid">
                {swatches.saved.map((c) => (
                  <span key={c} className="cp-sw-cell">
                    <button
                      type="button"
                      className={c === active ? "cp-sw is-on" : "cp-sw"}
                      style={{ background: c }}
                      title={`${c.toUpperCase()} · ${zh.colorPanel.removeHint}`}
                      aria-label={c.toUpperCase()}
                      onClick={() => apply(c)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        removeSavedColor(c);
                      }}
                    />
                    <button
                      type="button"
                      className="cp-sw-del"
                      title={zh.colorPanel.remove}
                      aria-label={zh.colorPanel.remove}
                      onClick={() => removeSavedColor(c)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="cp-sw-section">
            <div className="cp-sw-head">
              <span>{zh.colorPanel.recent}</span>
            </div>
            {swatches.recent.length === 0 ? (
              <p className="cp-sw-empty">{zh.colorPanel.recentEmpty}</p>
            ) : (
              <div className="cp-sw-grid">
                {swatches.recent.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={c === active ? "cp-sw is-on" : "cp-sw"}
                    style={{ background: c }}
                    title={c.toUpperCase()}
                    aria-label={c.toUpperCase()}
                    onClick={() => apply(c)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
