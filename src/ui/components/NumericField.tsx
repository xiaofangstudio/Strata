/**
 * 专业数值控件：标签可擦洗（scrub）+ 数值框可输表达式。
 *
 * PhotoCraft 的 `scrub_label` / `value_field` / `numeric_expression` 是「专业工具」
 * 与「网页表单」最直观的分水岭：在 PS 里横向拖标签就能改数值，数值框里能直接敲
 * `120+10`、`50%`、`2in`；而不是被迫拖一根滑杆。
 *
 * 这里做成可复用件，滤镜 / 调整 / 画廊的参数行都能接。表达式解析见
 * `numericExpression.ts`（纯函数、九项单测、无 eval）。
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { zh } from "../../i18n";
import { parseNumericExpression } from "../numericExpression";
import "./NumericField.css";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  dec?: number;
  unit?: string;
  onChange: (v: number) => void;
  /** 擦洗灵敏度：拖 1px 改多少 step，默认 1 */
  sensitivity?: number;
  /** 擦洗 / 输入开始（参数窗把整段手势合成一步撤销） */
  onGestureStart?: () => void;
  /** 擦洗 / 输入结束 */
  onGestureEnd?: () => void;
}

export default function NumericField({
  label,
  value,
  min,
  max,
  step = 1,
  dec = 0,
  unit,
  onChange,
  sensitivity = 1,
  onGestureStart,
  onGestureEnd,
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const scrub = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = draft !== null ? draft : value.toFixed(dec);

  // 外部值变了（撤销 / 切预设 / 拖动滑杆）就丢掉草稿，别让旧草稿盖住新值
  useEffect(() => {
    setDraft(null);
    setInvalid(false);
  }, [value]);

  const commit = (raw: string) => {
    const r = parseNumericExpression(raw, { min, max, current: value });
    setInvalid(!r.ok);
    setDraft(null);
    if (r.ok && r.value !== value) onChangeRef.current(r.value);
  };

  const onLabelDown = (e: RPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    scrub.current = { x: e.clientX, start: value, moved: false };
    onGestureStart?.();
  };
  const onLabelMove = (e: RPointerEvent<HTMLSpanElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) < 2) return;
    s.moved = true;
    // 按住 Shift 精调（十分之一），Alt 粗调（十倍）——与 PS 的擦洗手势一致
    const gain = e.shiftKey ? 0.1 : e.altKey ? 10 : sensitivity;
    const next = clamp(s.start + dx * step * gain);
    if (next !== value) onChangeRef.current(next);
  };
  const onLabelUp = () => {
    if (!scrub.current) return;
    scrub.current = null;
    onGestureEnd?.();
  };

  return (
    <span className="nf">
      <span
        className="nf-label"
        title={zh.dialog.nfScrubTip}
        onPointerDown={onLabelDown}
        onPointerMove={onLabelMove}
        onPointerUp={onLabelUp}
        onPointerCancel={onLabelUp}
      >
        {label}
      </span>
      <input
        type="text"
        className={invalid ? "nf-num is-invalid" : "nf-num"}
        value={shown}
        spellCheck={false}
        title={invalid ? zh.dialog.nfInvalid : zh.dialog.nfExprTip}
        aria-label={label}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          setDraft(raw);
          // 边打边算：合法就即时推给画布，非法只标红不打断
          const r = parseNumericExpression(raw, { min, max, current: value });
          setInvalid(!r.ok);
          if (r.ok && r.value !== value) onChangeRef.current(r.value);
        }}
        onFocus={onGestureStart}
        onBlur={(e) => {
          if (draft !== null) commit(e.currentTarget.value);
          else setInvalid(false);
          onGestureEnd?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            setInvalid(false);
            e.currentTarget.blur();
          }
        }}
      />
      {unit && <span className="nf-unit">{unit}</span>}
    </span>
  );
}
