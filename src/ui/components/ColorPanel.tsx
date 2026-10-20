/**
 * 常驻调色面板（右侧 Docker 的第一组）。
 *
 * 对齐 PhotoCraft / PS 的「颜色」面板：前景 / 背景色就在画布旁边，随时改、
 * 随时看得见，不用再去工具轨点小色块开浮层。页签分两页：
 *
 *   · 颜色 —— 前景/背景叠块 + 横排 SV 方块与竖色相条 + 十六进制/RGB 数值；
 *   · 色板 —— 标准色板、我的色板、最近使用。
 *
 * 面板里每个控件都直接落到 `fg` / `bg`，也就是画笔、油漆桶、渐变、形状、
 * 文字真正使用的颜色 —— 没有只显示不生效的假控件。
 */
import { useEffect, useState } from "react";
import { zh } from "../../i18n/zh-CN";
import type { ToolId } from "../../tools/catalog";
import {
  hexToRgb,
  normalizeHex,
  rgbToHex,
  STANDARD_SWATCHES,
} from "../color-utils";
import {
  addSavedColor,
  removeSavedColor,
  touchRecentColor,
  useColorSwatches,
} from "../color-swatches";
import ColorPicker, { HexBox, NumBox } from "./ColorPicker";
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
type Tab = "color" | "swatches";

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
  const [tab, setTab] = useState<Tab>("color");
  const swatches = useColorSwatches();

  const active = normalizeHex(target === "fg" ? fg : bg) ?? "#000000";
  const apply = (hex: string) => {
    const ok = normalizeHex(hex);
    if (!ok) return;
    if (target === "fg") onFg(ok);
    else onBg(ok);
  };

  const { r, g, b } = hexToRgb(active);
  const setChannel = (channel: "r" | "g" | "b", value: number) => {
    const next = { r, g, b, [channel]: value };
    apply(rgbToHex(next.r, next.g, next.b));
  };

  // 拖滑杆时会连发很多中间色，停手 0.6 秒才记一条「最近使用」。
  useEffect(() => {
    const t = window.setTimeout(() => touchRecentColor(active), 600);
    return () => window.clearTimeout(t);
  }, [active]);

  return (
    <div className="dock-panel cp-panel" aria-label={zh.colorPanel.title}>
      <div className="panel-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "color"}
          className={tab === "color" ? "panel-tab is-on" : "panel-tab"}
          onClick={() => setTab("color")}
        >
          {zh.panel.tabColor}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "swatches"}
          className={tab === "swatches" ? "panel-tab is-on" : "panel-tab"}
          onClick={() => setTab("swatches")}
        >
          {zh.panel.tabSwatches}
        </button>
      </div>

      {tab === "color" ? (
        <div className="dock-scroll cp-body">
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

          <ColorPicker variant="sv" hex={active} onChange={apply} />

          <div className="cp-values">
            <span className="cp-preview" style={{ background: active }} />
            <span className="cp-hash">#</span>
            <HexBox hex={active} onHex={apply} />
          </div>

          <div className="cp-channels">
            <div className="cp-channel">
              <span className="cp-channel-label">R</span>
              <NumBox value={r} max={255} aria={zh.colorPanel.red} onChange={(v) => setChannel("r", v)} />
            </div>
            <div className="cp-channel">
              <span className="cp-channel-label">G</span>
              <NumBox value={g} max={255} aria={zh.colorPanel.green} onChange={(v) => setChannel("g", v)} />
            </div>
            <div className="cp-channel">
              <span className="cp-channel-label">B</span>
              <NumBox value={b} max={255} aria={zh.colorPanel.blue} onChange={(v) => setChannel("b", v)} />
            </div>
          </div>
        </div>
      ) : (
        <div className="dock-scroll cp-body">
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
    </div>
  );
}
