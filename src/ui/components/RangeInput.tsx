/**
 * 即时跟手滑块（所有滑动条的统一底座）。
 *
 * 为什么要单独抽一层：之前每个滑块都是受控于父层 state 的 `<input type="range">`，
 * 而父层一收到值就触发整档重算（合成 + 调整图层逐像素），大图下一次要好几百毫秒。
 * 结果是「拇指卡着不动、松手才跳过去、之后还要追好几秒」——
 * 因为每次 pointermove 都会排一次重活，队越排越长。
 *
 * 这里用两条原则解决：
 *  1. **拇指 100% 跟手**：拖动中的位置存在组件自己的 state 里，`input` 事件里
 *     立刻 setState，不等父层任何回话。哪怕画面还没算完，滑块也压在指尖下。
 *  2. **对外每帧最多推一次、且只推最新值**：中间帧直接丢掉并用新值覆盖待发值，
 *     所以拖动过程中永不积压——松手时画面追赶的只是「最后一帧」，不会拖几秒。
 *
 * 拖动结束后（pointerup / blur）补一次最终值，保证父层拿到的一定是终点，
 * 而撤销的历史入口由父层自己决定（这里只负责「什么时候推」）。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export interface RangeInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  className?: string;
  disabled?: boolean;
  title?: string;
  /** 行内样式：颜色滑条的渐变轨道靠它（CSS 自定义属性传下去） */
  style?: CSSProperties;
  "aria-label"?: string;
  /** 值变化（每帧最多一次，拖动结束必定补一次最终值） */
  onChange: (v: number) => void;
  /** 拖动开始 / 结束（父层可据此暂停重活或标记「正在交互」） */
  onDragStart?: () => void;
  onDragEnd?: (v: number) => void;
}

export default function RangeInput({
  value,
  min,
  max,
  step = 1,
  className,
  disabled,
  title,
  style,
  onChange,
  onDragStart,
  onDragEnd,
  "aria-label": ariaLabel,
}: RangeInputProps) {
  /** 拇指位置：拖动期间只认这里，保证跟手。 */
  const [local, setLocal] = useState(value);
  const draggingRef = useRef(false);
  const frameRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  // 没在拖的时候，外部值就是唯一事实来源（撤销回退、切图层、切预设都得跟上）
  useEffect(() => {
    if (!draggingRef.current) setLocal(value);
  }, [value]);

  // 卸载时清掉没来得及发的帧，免得对着已卸载的组件回调
  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  /** 发掉待发值（每帧一次）。 */
  const flush = useCallback(() => {
    frameRef.current = 0;
    const v = pendingRef.current;
    if (v === null) return;
    pendingRef.current = null;
    onChangeRef.current(v);
  }, []);

  const handle = useCallback(
    (v: number) => {
      setLocal(v);
      pendingRef.current = v;
      // 已经有帧在等就直接用新值覆盖，绝不让旧值插队形成积压
      if (!frameRef.current) frameRef.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  const begin = () => {
    draggingRef.current = true;
    onDragStartRef.current?.();
  };

  const end = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    // 松手必须立刻结清：把最终值直接推出去，不等下一帧
    const v = pendingRef.current;
    if (v !== null) {
      pendingRef.current = null;
      onChangeRef.current(v);
    }
    onDragEndRef.current?.(local);
  };

  return (
    <input
      type="range"
      className={className}
      min={min}
      max={max}
      step={step}
      value={local}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      style={style}
      onChange={(e) => handle(Number(e.target.value))}
      onPointerDown={begin}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        // 键盘调完立刻结算：方向键是离散步进，不需要按帧合并
        const v = Number((e.target as HTMLInputElement).value);
        pendingRef.current = null;
        onChangeRef.current(v);
      }}
      onKeyUp={end}
      onBlur={end}
    />
  );
}
