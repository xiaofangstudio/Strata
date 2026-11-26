/**
 * 文件 > 新建…（PhotoCraft `new_doc_ui` 的对应物，#14038/#14043）。
 *
 * 以前编辑器里 Ctrl+N 直接按首档预设开一张空白档：没有尺寸确认、没有
 * 最近使用、没有保存预设，与开始页的专业程度完全脱节。这里补齐：
 *  · 预设网格（core/presets 同源）+ 自定义宽高 / DPI / 背景；
 *  · 最近使用：每次成功新建把设置推入 localStorage，跨会话保留，一键回填；
 *  · 保存预设：当前设置命名存档，同名覆盖。
 * 纯数据变换在 core/newDocSettings.ts（有单测），这里只管 UI 与存储。
 */
import { useMemo, useState } from "react";
import {
  parseList,
  pickPreset,
  pickRecent,
  pushRecent,
  upsertPreset,
  type NamedDocPreset,
  type NewDocSettings,
  type RecentDocEntry,
} from "../../core/newDocSettings";
import { DEFAULT_DPI, MAX_DPI, MAX_SIDE, MIN_DPI, MIN_SIDE, PRESETS } from "../../core/presets";
import { zh } from "../../i18n";
import DraggableModal from "./DraggableModal";
import NumericField from "./NumericField";
import "./NewDocumentDialog.css";

const RECENT_KEY = "strata.newdoc.recent";
const PRESET_KEY = "strata.newdoc.presets";

interface Props {
  /** 确认创建：设置已通过校验；label 用于历史记录。 */
  onCreate: (settings: NewDocSettings, label: string) => void;
  onClose: () => void;
}

const BG_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "white", label: "白色" },
  { id: "transparent", label: "透明" },
  { id: "black", label: "黑色" },
];

function loadRecent(): RecentDocEntry[] {
  try {
    return parseList(localStorage.getItem(RECENT_KEY), pickRecent).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

function loadPresets(): NamedDocPreset[] {
  try {
    return parseList(localStorage.getItem(PRESET_KEY), pickPreset);
  } catch {
    return [];
  }
}

export default function NewDocumentDialog({ onCreate, onClose }: Props) {
  const first = PRESETS[0];
  const [w, setW] = useState(first.w);
  const [h, setH] = useState(first.h);
  const [dpi, setDpi] = useState(Number(DEFAULT_DPI));
  const [bg, setBg] = useState("white");
  const [presetName, setPresetName] = useState("");
  const [recent] = useState<RecentDocEntry[]>(loadRecent);
  const [presets, setPresets] = useState<NamedDocPreset[]>(loadPresets);

  const current: NewDocSettings = useMemo(() => ({ w, h, dpi, bg }), [w, h, dpi, bg]);
  const valid = w >= MIN_SIDE && w <= MAX_SIDE && h >= MIN_SIDE && h <= MAX_SIDE && dpi >= MIN_DPI && dpi <= MAX_DPI;

  const bgLabel = (id: string) =>
    BG_OPTIONS.find((b) => b.id === id)?.label ?? (/^#[0-9a-fA-F]{6}$/.test(id) ? id : id);

  const confirm = () => {
    if (!valid) return;
    try {
      const next = pushRecent(loadRecent(), current, Date.now());
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* 存不了就不记 recent，创建照常 */
    }
    onCreate(current, `${zh.dialog.newDocTitle} ${w}×${h}`);
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name || !valid) return;
    const next = upsertPreset(presets, { ...current, name });
    setPresets(next);
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    } catch {
      /* 同上：存不了不影响本次创建 */
    }
    setPresetName("");
  };

  return (
    <DraggableModal
      id="new-document"
      title={zh.dialog.newDocTitle}
      badge={zh.menu.file}
      onClose={onClose}
      width={620}
      height={520}
      minWidth={520}
      minHeight={420}
      footer={
        <>
          <span className="ndd-spacer" />
          <button className="btn-ghost" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button className="btn-primary" disabled={!valid} onClick={confirm}>
            {zh.dialog.newDocCreate}
          </button>
        </>
      }
    >
      <div className="ndd-body">
        {recent.length > 0 && (
          <section className="ndd-section">
            <div className="ndd-section-title">{zh.dialog.newDocRecent}</div>
            <div className="ndd-chipgrid">
              {recent.map((r) => (
                <button
                  key={`${r.w}x${r.h}x${r.dpi}x${r.bg}`}
                  type="button"
                  className={`ndd-chip${r.w === w && r.h === h && r.dpi === dpi && r.bg === bg ? " is-active" : ""}`}
                  onClick={() => {
                    setW(r.w);
                    setH(r.h);
                    setDpi(r.dpi);
                    setBg(r.bg);
                  }}
                >
                  <span className="ndd-chip-size">
                    {r.w} × {r.h}
                  </span>
                  <span className="ndd-chip-sub">
                    {r.dpi} DPI · {bgLabel(r.bg)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="ndd-section">
          <div className="ndd-section-title">{zh.start.presets}</div>
          <div className="ndd-chipgrid">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`ndd-chip${p.w === w && p.h === h && p.dpi === dpi ? " is-active" : ""}`}
                onClick={() => {
                  setW(p.w);
                  setH(p.h);
                  if (p.dpi) setDpi(p.dpi);
                }}
              >
                <span className="ndd-chip-size">{p.label}</span>
                <span className="ndd-chip-sub">
                  {p.w} × {p.h}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="ndd-section">
          <div className="ndd-section-title">{zh.dialog.newDocCustom}</div>
          <div className="ndd-fields">
            <NumericField
              label={zh.dialog.newDocWidth}
              value={w}
              min={MIN_SIDE}
              max={MAX_SIDE}
              onChange={(v) => setW(Math.round(v))}
            />
            <NumericField
              label={zh.dialog.newDocHeight}
              value={h}
              min={MIN_SIDE}
              max={MAX_SIDE}
              onChange={(v) => setH(Math.round(v))}
            />
            <NumericField
              label="DPI"
              value={dpi}
              min={MIN_DPI}
              max={MAX_DPI}
              onChange={(v) => setDpi(Math.round(v))}
            />
            <label className="ndd-field">
              <span>{zh.dialog.newDocBackground}</span>
              <div className="ndd-bgrow">
                {BG_OPTIONS.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={`ndd-bgchip${bg === b.id ? " is-active" : ""}`}
                    onClick={() => setBg(b.id)}
                  >
                    {b.label}
                  </button>
                ))}
                <input
                  type="color"
                  className="ndd-bgcolor"
                  value={/^#[0-9a-fA-F]{6}$/.test(bg) ? bg : "#ffffff"}
                  title={zh.dialog.newDocCustomColor}
                  onChange={(e) => setBg(e.target.value.toLowerCase())}
                />
              </div>
            </label>
          </div>
        </section>

        {presets.length > 0 && (
          <section className="ndd-section">
            <div className="ndd-section-title">{zh.dialog.newDocPresets}</div>
            <div className="ndd-chipgrid">
              {presets.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className={`ndd-chip${p.w === w && p.h === h && p.dpi === dpi && p.bg === bg ? " is-active" : ""}`}
                  title={`${p.w} × ${p.h} · ${p.dpi} DPI · ${bgLabel(p.bg)}`}
                  onClick={() => {
                    setW(p.w);
                    setH(p.h);
                    setDpi(p.dpi);
                    setBg(p.bg);
                  }}
                >
                  <span className="ndd-chip-size">{p.name}</span>
                  <span className="ndd-chip-sub">
                    {p.w} × {p.h}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="ndd-section ndd-save">
          <input
            type="text"
            className="ndd-name"
            placeholder={zh.dialog.newDocPresetName}
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") savePreset();
            }}
          />
          <button type="button" className="btn-ghost btn-sm" disabled={!valid || !presetName.trim()} onClick={savePreset}>
            {zh.dialog.newDocSavePreset}
          </button>
        </section>
      </div>
    </DraggableModal>
  );
}
