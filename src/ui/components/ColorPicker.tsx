/**
 * 自绘拾色器。
 *
 * 不依赖原生 `<input type="color">` —— 在 WebView2 里它有时根本弹不出来，
 * 点上去像没反应，于是「所有换颜色的地方全不起作用」。这里自己画一套：
 *
 *   · 饱和度-明度方块（拖动手感与 PS 一致）
 *   · 色相条
 *   · 十六进制输入
 *   · 一排常用色
 *
 * 拖动过程中即时回调 `onChange`，松手也不用确认 —— 全平台行为一致。
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as RPointerEvent,
} from "react";
import { zh } from "../../i18n/zh-CN";
import {
  COLOR_PRESETS,
  hexToHsv,
  hexToRgb,
  hsvToHex,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
} from "../color-utils";
import "./picker.css";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface ColorPickerProps {
  hex: string;
  onChange: (hex: string) => void;
  /**
   * 详细模式：在 SV 方块 / 色相条之外再给一套 RGB、HSB 数值滑杆。
   * 常驻调色面板用它；工具轨、色块浮层仍用紧凑形态。
   */
  detailed?: boolean;
}

type ChannelMode = "rgb" | "hsb";

export default function ColorPicker({ hex, onChange, detailed = false }: ColorPickerProps) {
  const safe = normalizeHex(hex) ?? "#000000";
  const [hsv, setHsv] = useState(() => hexToHsv(safe));
  /** 上一次由本组件发出去的颜色，用来区分「外部改的」与「自己改的」，避免回灌。 */
  const emitted = useRef(safe);

  useEffect(() => {
    if (safe.toLowerCase() === emitted.current.toLowerCase()) return;
    emitted.current = safe;
    setHsv(hexToHsv(safe));
  }, [safe]);

  const commit = (next: { h: number; s: number; v: number }) => {
    setHsv(next);
    const out = hsvToHex(next.h, next.s, next.v);
    emitted.current = out;
    onChange(out);
  };

  /**
   * RGB 滑杆：灰阶（饱和度归零）时 HSV 会丢掉色相，
   * 这里沿用当前色相，避免在灰阶附近来回拖时色相条突然跳回红色。
   */
  const commitRgb = (r: number, g: number, b: number) => {
    const next = rgbToHsv(r, g, b);
    if (next.s === 0 || next.v === 0) next.h = hsv.h;
    if (next.v === 0) next.s = hsv.s;
    commit(next);
  };

  const [mode, setMode] = useState<ChannelMode>("rgb");

  const drag = useRef<"sv" | "hue" | null>(null);

  const pickSv = (el: HTMLElement, cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    commit({
      h: hsv.h,
      s: clamp01((cx - r.left) / r.width),
      v: 1 - clamp01((cy - r.top) / r.height),
    });
  };

  const pickHue = (el: HTMLElement, cx: number) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    commit({ h: clamp01((cx - r.left) / r.width) * 360, s: hsv.s, v: hsv.v });
  };

  const down = (kind: "sv" | "hue") => (e: RPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = kind;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已失效时忽略，拖动仍可继续 */
    }
    if (kind === "sv") pickSv(e.currentTarget, e.clientX, e.clientY);
    else pickHue(e.currentTarget, e.clientX);
  };

  const move = (kind: "sv" | "hue") => (e: RPointerEvent<HTMLDivElement>) => {
    if (drag.current !== kind) return;
    if (kind === "sv") pickSv(e.currentTarget, e.clientX, e.clientY);
    else pickHue(e.currentTarget, e.clientX);
  };

  const up = (e: RPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放 */
    }
  };

  const cur = hsvToHex(hsv.h, hsv.s, hsv.v);
  const hueHex = hsvToHex(hsv.h, 1, 1);
  const { r, g, b } = hexToRgb(cur);

  return (
    <div className="cp">
      <div
        className="cp-sv"
        style={{
          background:
            `linear-gradient(to top, #000, rgba(0,0,0,0)),` +
            `linear-gradient(to right, #fff, ${hueHex})`,
        }}
        role="slider"
        aria-label={zh.options.colorSv}
        aria-valuetext={cur}
        onPointerDown={down("sv")}
        onPointerMove={move("sv")}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <span
          className="cp-knob"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: cur }}
        />
      </div>

      <div
        className="cp-hue"
        role="slider"
        aria-label={zh.options.colorHue}
        aria-valuetext={String(Math.round(hsv.h))}
        onPointerDown={down("hue")}
        onPointerMove={move("hue")}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <span className="cp-knob cp-knob-hue" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueHex }} />
      </div>

      <div className="cp-foot">
        <span className="cp-preview" style={{ background: cur }} />
        <span className="cp-hash">#</span>
        <HexBox hex={cur} onHex={(v) => commit(hexToHsv(v))} />
      </div>

      {detailed && (
        <div className="cp-detail">
          <div className="cp-tabs" role="tablist" aria-label={zh.colorPanel.numeric}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "rgb"}
              className={mode === "rgb" ? "cp-tab is-on" : "cp-tab"}
              onClick={() => setMode("rgb")}
            >
              RGB
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "hsb"}
              className={mode === "hsb" ? "cp-tab is-on" : "cp-tab"}
              onClick={() => setMode("hsb")}
            >
              HSB
            </button>
          </div>

          {mode === "rgb" ? (
            <>
              <RangeRow
                label="R"
                aria={zh.colorPanel.red}
                value={r}
                max={255}
                track={`linear-gradient(to right, ${rgbToHex(0, g, b)}, ${rgbToHex(255, g, b)})`}
                onChange={(v) => commitRgb(v, g, b)}
              />
              <RangeRow
                label="G"
                aria={zh.colorPanel.green}
                value={g}
                max={255}
                track={`linear-gradient(to right, ${rgbToHex(r, 0, b)}, ${rgbToHex(r, 255, b)})`}
                onChange={(v) => commitRgb(r, v, b)}
              />
              <RangeRow
                label="B"
                aria={zh.colorPanel.blue}
                value={b}
                max={255}
                track={`linear-gradient(to right, ${rgbToHex(r, g, 0)}, ${rgbToHex(r, g, 255)})`}
                onChange={(v) => commitRgb(r, g, v)}
              />
            </>
          ) : (
            <>
              <RangeRow
                label="H"
                aria={zh.options.colorHue}
                value={Math.round(hsv.h)}
                max={360}
                track="linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)"
                onChange={(v) => commit({ h: v, s: hsv.s, v: hsv.v })}
              />
              <RangeRow
                label="S"
                aria={zh.colorPanel.saturation}
                value={Math.round(hsv.s * 100)}
                max={100}
                track={`linear-gradient(to right, ${hsvToHex(hsv.h, 0, hsv.v)}, ${hueHex})`}
                onChange={(v) => commit({ h: hsv.h, s: v / 100, v: hsv.v })}
              />
              <RangeRow
                label="B"
                aria={zh.colorPanel.brightness}
                value={Math.round(hsv.v * 100)}
                max={100}
                track={`linear-gradient(to right, #000000, ${hsvToHex(hsv.h, hsv.s, 1)})`}
                onChange={(v) => commit({ h: hsv.h, s: hsv.s, v: v / 100 })}
              />
            </>
          )}
        </div>
      )}

      {!detailed && (
        <div className="cp-presets" role="group" aria-label={zh.options.colorPresets}>
          {COLOR_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={p === cur ? "cp-preset is-on" : "cp-preset"}
              style={{ background: p }}
              title={p.toUpperCase()}
              aria-label={p.toUpperCase()}
              onClick={() => commit(hexToHsv(p))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 一条通道：滑杆 + 数字框，拖与打都能改。 */
function RangeRow({
  label,
  aria,
  value,
  max,
  track,
  onChange,
}: {
  label: string;
  aria: string;
  value: number;
  max: number;
  track: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="cp-row">
      <span className="cp-row-label">{label}</span>
      <input
        type="range"
        className="cp-range"
        min={0}
        max={max}
        value={value}
        aria-label={aria}
        style={{ "--cp-track": track } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <NumBox value={value} max={max} aria={aria} onChange={onChange} />
    </div>
  );
}

/** 数字框：打字过程中不打断，合法数字即时生效，失焦时回填当前值。 */
function NumBox({
  value,
  max,
  aria,
  onChange,
}: {
  value: number;
  max: number;
  aria: string;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const push = (raw: string) => {
    if (raw.trim() === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onChange(Math.min(max, Math.max(0, Math.round(n))));
  };

  return (
    <input
      type="number"
      className="cp-num"
      min={0}
      max={max}
      value={draft}
      aria-label={aria}
      onChange={(e) => {
        setDraft(e.target.value);
        push(e.target.value);
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

/**
 * 十六进制输入：边打字边校验，完整合法的一串立刻生效；
 * 回车补交当前草稿，失焦时草稿合法就采纳、不合法才回滚 ——
 * 不能让用户打了一半点别处就把颜色弄丢。
 */
function HexBox({ hex, onHex }: { hex: string; onHex: (hex: string) => void }) {
  const short = hex.replace("#", "").toUpperCase();
  const [draft, setDraft] = useState(short);
  useEffect(() => setDraft(short), [short]);

  /** 尝试把当前草稿提交成颜色；合法返回 true，非法返回 false。 */
  const tryCommit = (value: string): boolean => {
    const ok = normalizeHex(value);
    if (!ok) return false;
    onHex(ok);
    return true;
  };

  return (
    <input
      className="cp-hex"
      value={draft}
      spellCheck={false}
      maxLength={7}
      aria-label={zh.options.colorHex}
      onChange={(e) => {
        setDraft(e.target.value);
        tryCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (tryCommit(draft)) setDraft(normalizeHex(draft)!.replace("#", "").toUpperCase());
        }
      }}
      onBlur={() => {
        if (!tryCommit(draft)) setDraft(short);
      }}
    />
  );
}
