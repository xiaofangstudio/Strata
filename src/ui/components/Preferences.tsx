/**
 * 偏好设置（快捷键 P）。
 *
 * 分「外观 / 工具栏 / 画笔」三栏，左侧竖排标签、右侧内容，样式与 PS 的
 * 首选项一致。所有开关都真实生效并写入本地存储，不做假的装饰性设置。
 */
import { useState } from "react";
import { zh } from "../../i18n/zh-CN";
import { resetPrefs, setPrefs, usePrefs } from "../../stores/prefs";
import type { ThemeMode } from "../../stores/theme";
import { TOOLS, TOOL_GROUPS, type ToolId } from "../../tools/catalog";
import type { BrushSettings } from "../../engine/paint";
import Modal from "./Modal";
import ToolIcon from "./ToolIcon";
import "./Preferences.css";
import RangeInput from "./RangeInput";

interface Props {
  onClose: () => void;
  themeMode: ThemeMode;
  onSetTheme: (m: ThemeMode) => void;
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
}

type TabId = "appearance" | "toolbar" | "brush";

export default function Preferences({ onClose, themeMode, onSetTheme, brush, onBrush }: Props) {
  const prefs = usePrefs();
  const [tab, setTab] = useState<TabId>("appearance");

  const tabs: { id: TabId; label: string }[] = [
    { id: "appearance", label: zh.preferences.appearance },
    { id: "toolbar", label: zh.preferences.toolbar },
    { id: "brush", label: zh.preferences.brush },
  ];

  const toggleTool = (id: ToolId) => {
    const hidden = prefs.hiddenTools.includes(id);
    if (!hidden && prefs.hiddenTools.length >= TOOLS.length - 1) return;
    setPrefs({
      hiddenTools: hidden
        ? prefs.hiddenTools.filter((t) => t !== id)
        : [...prefs.hiddenTools, id],
    });
  };

  return (
    <Modal
      title={zh.preferences.title}
      onClose={onClose}
      width={660}
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={resetPrefs}>
            {zh.preferences.resetAll}
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={onClose}>
            {zh.preferences.done}
          </button>
        </>
      }
    >
      <div className="pref">
        <nav className="pref-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`pref-tab${tab === t.id ? " is-on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="pref-pane">
          {tab === "appearance" && (
            <section className="pref-sec">
              <h3 className="pref-h">{zh.preferences.theme}</h3>
              <div className="pref-choice">
                {(["light", "dark"] as ThemeMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`pref-card${themeMode === m ? " is-on" : ""}`}
                    onClick={() => onSetTheme(m)}
                  >
                    <span className={`pref-swatch is-${m}`} />
                    <span className="pref-card-name">
                      {m === "light" ? zh.theme.light : zh.theme.dark}
                    </span>
                  </button>
                ))}
              </div>
              <p className="pref-note">{zh.preferences.themeHint}</p>
            </section>
          )}

          {tab === "toolbar" && (
            <>
              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.columns}</h3>
                <div className="pref-seg">
                  {([1, 2, 3] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`pref-seg-btn${prefs.columns === n ? " is-on" : ""}`}
                      onClick={() => setPrefs({ columns: n })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <p className="pref-note">{zh.preferences.columnsHint}</p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.tools}</h3>
                <div className="pref-tools">
                  {TOOL_GROUPS.map((g) => (
                    <div key={g} className="pref-tool-group">
                      {TOOLS.filter((t) => t.group === g).map((t) => (
                        <label key={t.id} className="pref-tool">
                          <input
                            type="checkbox"
                            checked={!prefs.hiddenTools.includes(t.id)}
                            onChange={() => toggleTool(t.id)}
                          />
                          <ToolIcon id={t.id} size={15} />
                          <span>{zh.tools[t.id]}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
                <p className="pref-note">{zh.preferences.toolsHint}</p>
              </section>
            </>
          )}

          {tab === "brush" && (
            <section className="pref-sec">
              <h3 className="pref-h">{zh.preferences.spacing}</h3>
              <div className="pref-row">
                <RangeInput
                  min={1}
                  max={50}
                  value={brush.spacing}
                  aria-label={zh.preferences.spacing}
                  onChange={(v) => onBrush({ spacing: v })}
                />
                <span className="pref-val">{brush.spacing}%</span>
              </div>
              <p className="pref-note">{zh.preferences.spacingHint}</p>
              <p className="pref-note">{zh.preferences.brushHint}</p>
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}
