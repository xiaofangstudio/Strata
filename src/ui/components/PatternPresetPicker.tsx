/**
 * 图层样式 > 图案叠加 的真预设选择器。
 *
 * 分组 + swatch：内置预设走确定性绘制，用户图案直接借用 core/patterns 的
 * canvas。选中的 id 写进 LayerStyle.patternId，渲染层用同一份 tile 平铺，
 * 所以缩略图和大图不会「看起来不一样」。
 */
import { useEffect, useRef, useState } from "react";
import {
  PATTERN_GROUP_ORDER,
  findPatternPreset,
  patternPresetsByGroup,
  type PatternPreset,
} from "../../core/patternPresets";
import { patternList, type PatternEntry } from "../../core/patterns";
import { patternThumbFor } from "../../engine/patternTiles";
import { zh } from "../../i18n";
import Popover from "./Popover";
import "./PatternPresetPicker.css";

interface Props {
  value?: string;
  onChange: (id: string) => void;
}

interface SwatchProps {
  id: string;
  label: string;
  active: boolean;
  onPick: (id: string) => void;
}

const SWATCH = 30;

function PatternSwatch({ id, label, active, onPick }: SwatchProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = SWATCH;
    canvas.height = SWATCH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const thumb = patternThumbFor(id, SWATCH);
    ctx.clearRect(0, 0, SWATCH, SWATCH);
    ctx.drawImage(thumb, 0, 0, SWATCH, SWATCH);
  }, [id]);
  return (
    <button
      type="button"
      className={active ? "pp-swatch is-on" : "pp-swatch"}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={() => onPick(id)}
    >
      <canvas ref={ref} width={SWATCH} height={SWATCH} />
      <span className="pp-swatch-label">{label}</span>
    </button>
  );
}

function PresetRow({ preset, active, onPick }: { preset: PatternPreset; active: boolean; onPick: (id: string) => void }) {
  return (
    <PatternSwatch
      id={`builtin:${preset.id}`}
      label={zh.panel.patternNames[preset.id]}
      active={active}
      onPick={onPick}
    />
  );
}

export default function PatternPresetPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [userPatterns, setUserPatterns] = useState<PatternEntry[]>([]);

  useEffect(() => {
    if (open) setUserPatterns(patternList().slice());
  }, [open]);

  const preset = findPatternPreset(value);
  const user = !preset && value ? userPatterns.find((p) => p.id === value) : null;
  const current = preset ? zh.panel.patternNames[preset.id] : user?.name ?? zh.panel.patternSelect;
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="pp-root">
      <button
        ref={buttonRef}
        type="button"
        className="pp-trigger"
        title={zh.panel.patternSelect}
        onClick={() => setOpen((v) => !v)}
      >
        <canvas
          className="pp-trigger-thumb"
          width={20}
          height={20}
          ref={(node) => {
            if (!node) return;
            const ctx = node.getContext("2d");
            if (!ctx) return;
            const thumb = patternThumbFor(value ?? "builtin:checker", 20);
            ctx.clearRect(0, 0, 20, 20);
            ctx.drawImage(thumb, 0, 0, 20, 20);
          }}
        />
        <span className="pp-trigger-label">{current}</span>
        <span className="pp-caret">▾</span>
      </button>
      {open && buttonRef.current && (
        <Popover anchor={buttonRef.current} onClose={() => setOpen(false)} preferUp width={276}>
          <div className="pp-menu">
            <div className="pp-menu-head">{zh.panel.patternOverlayPattern}</div>
            <div className="pp-scroll">
              {PATTERN_GROUP_ORDER.map((group) => (
                <div className="pp-group" key={group}>
                  <div className="pp-group-title">{zh.panel.patternPresetGroup[group]}</div>
                  <div className="pp-grid">
                    {patternPresetsByGroup(group).map((p) => (
                      <PresetRow key={p.id} preset={p} active={value === `builtin:${p.id}`} onPick={pick} />
                    ))}
                  </div>
                </div>
              ))}
              <div className="pp-group">
                <div className="pp-group-title">{zh.panel.patternUserGroup}</div>
                {userPatterns.length === 0 ? (
                  <div className="pp-empty">{zh.panel.patternEmpty}</div>
                ) : (
                  <div className="pp-grid">
                    {userPatterns.map((p) => (
                      <PatternSwatch
                        key={p.id}
                        id={p.id}
                        label={p.name}
                        active={value === p.id}
                        onPick={pick}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}
