/**
 * Blend If 双半三角滑块。
 *
 * 不是两根普通滑杆：黑三角只吃左半边、白三角只吃右半边，中间显示 0–255
 * 的灰阶带。拖动整段手势只在松手时提交一次历史，拖动中走实时预览。
 */
import { useRef, type PointerEvent as RPointerEvent } from "react";
import "./BlendIfBar.css";

interface Props {
  label: string;
  black: number;
  white: number;
  onChange: (black: number, white: number, phase: "live" | "commit") => void;
}

export default function BlendIfBar({ label, black, white, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<"black" | "white" | null>(null);

  const at = (e: { clientX: number }) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.min(255, Math.round(((e.clientX - r.left) / (r.width || 1)) * 255)));
  };

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    const v = at(e);
    // 谁近拖谁；正好在中间时按左右半边分，三角互不越过
    const key = Math.abs(v - black) <= Math.abs(v - white) ? "black" : "white";
    drag.current = key;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    update(e, key, "live");
  };

  const update = (e: { clientX: number }, key: "black" | "white", phase: "live" | "commit") => {
    const v = at(e);
    if (key === "black") onChange(Math.min(v, white - 1), white, phase);
    else onChange(black, Math.max(v, black + 1), phase);
  };

  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (drag.current) update(e, drag.current, "live");
  };

  const up = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    update(e, drag.current, "commit");
    drag.current = null;
  };

  return (
    <div className="blendif-row">
      <span className="blendif-label">{label}</span>
      <div
        ref={ref}
        className="blendif-bar"
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={255}
        aria-valuenow={black}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <span className="blendif-ramp" />
        <span
          className="blendif-handle blendif-handle-black"
          style={{ left: `${(black / 255) * 100}%` }}
        />
        <span
          className="blendif-handle blendif-handle-white"
          style={{ left: `${(white / 255) * 100}%` }}
        />
      </div>
      <span className="blendif-num">
        {black}–{white}
      </span>
    </div>
  );
}
