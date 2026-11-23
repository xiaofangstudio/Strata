/**
 * 参数对话框自己的撤销栈接线。
 *
 * 为什么需要它：以前在滤镜 / 调整窗口里按 Ctrl+Z，撤掉的是**文档历史**，
 * 窗口里的参数纹丝不动 —— 用户以为键盘坏了。PhotoCraft 的做法是每个对话框
 * 自带一份 EditHistory：拖滑杆的整段手势只算一步，Ctrl+Z 只回退这个窗口的参数。
 *
 * 两个必须遵守的边界：
 *   ① **打字时让位**：焦点在文本输入框 / textarea / contentEditable 时完全不接管，
 *      让浏览器原生文本撤销正常工作；
 *   ② **抢在文档快捷键之前**：EditorShell 的全局 Ctrl+Z 是 window 冒泡监听，
 *      这里用 window 捕获监听并对已处理的事件 stopPropagation，保证不会把
 *      文档历史一起撤掉。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { EditHistory } from "../../core/editHistory";

export interface DialogUndoOptions {
  /** 临时关闭键盘接管（例如对话框正在关闭）。 */
  enabled?: boolean;
  /** 历史步数上限，默认 100（与 PhotoCraft 一致）。 */
  limit?: number;
}

/** 纯判定：只有「真能原生撤销文字」的控件才让位。 */
export function isTextEditingTarget(
  tagName: string,
  inputType: string,
  contentEditable: boolean,
): boolean {
  if (tagName === "TEXTAREA" || contentEditable) return true;
  return ["text", "search", "url", "email", "password", "tel", "number"].includes(
    inputType.toLowerCase(),
  );
}

export interface DialogUndoApi<T> {
  state: T;
  setState: Dispatch<SetStateAction<T>>;
  /** 手势开始：之后的状态更新先攒着，不当成独立历史步。 */
  beginGesture: () => void;
  /** 手势结束：把整段手势合成一步提交。 */
  endGesture: () => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** 切换调整类型 / 滤镜时丢弃旧分支。 */
  reset: (initial: T) => void;
}

export function useDialogUndo<T>(initial: T, options: DialogUndoOptions = {}): DialogUndoApi<T> {
  const { enabled = true, limit = 100 } = options;
  const [state, rawSet] = useState<T>(initial);
  /** 永远指向「最新一次设置的值」，不等 React 提交 —— 松手结算要用。 */
  const latest = useRef<T>(initial);
  const historyRef = useRef<EditHistory<T> | null>(null);
  if (!historyRef.current) historyRef.current = new EditHistory<T>(initial, limit);
  /**
   * 手势标记是幂等的：滑杆每帧都会调 beginGesture，若用计数器会被加得很深，
   * 松手只 end 一次就永远归不了零。
   */
  const gesturing = useRef(false);
  const [caps, setCaps] = useState({ undo: false, redo: false });

  const syncCaps = useCallback(() => {
    const h = historyRef.current!;
    const next = { undo: h.canUndo, redo: h.canRedo };
    setCaps((prev) => (prev.undo === next.undo && prev.redo === next.redo ? prev : next));
  }, []);

  /** 所有参数更新都必须走这里，历史才会记录。 */
  const setState = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const next =
        typeof action === "function" ? (action as (prev: T) => T)(latest.current) : action;
      if (Object.is(next, latest.current)) return;
      latest.current = next;
      historyRef.current!.settle(next, gesturing.current);
      rawSet(next);
      syncCaps();
    },
    [syncCaps],
  );

  const beginGesture = useCallback(() => {
    gesturing.current = true;
  }, []);

  const endGesture = useCallback(() => {
    if (!gesturing.current) return;
    gesturing.current = false;
    historyRef.current!.settle(latest.current, false);
    syncCaps();
  }, [syncCaps]);

  const undo = useCallback(() => {
    const h = historyRef.current!;
    // 手势中直接按撤销：先把这段改动结算掉，再撤，才能回到手势开始前。
    gesturing.current = false;
    h.settle(latest.current, false);
    const r = h.step(latest.current, "undo");
    if (!r.changed) {
      syncCaps();
      return false;
    }
    latest.current = r.value;
    rawSet(r.value);
    syncCaps();
    return true;
  }, [syncCaps]);

  const redo = useCallback(() => {
    const h = historyRef.current!;
    gesturing.current = false;
    h.settle(latest.current, false);
    const r = h.step(latest.current, "redo");
    if (!r.changed) {
      syncCaps();
      return false;
    }
    latest.current = r.value;
    rawSet(r.value);
    syncCaps();
    return true;
  }, [syncCaps]);

  const reset = useCallback(
    (initialValue: T) => {
      gesturing.current = false;
      historyRef.current!.reset(initialValue);
      latest.current = initialValue;
      rawSet(initialValue);
      syncCaps();
    },
    [syncCaps],
  );

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;

      const el = e.target as HTMLElement | null;
      if (
        el &&
        isTextEditingTarget(
          el.tagName,
          el instanceof HTMLInputElement ? el.type : "",
          Boolean(el.isContentEditable),
        )
      ) {
        return;
      }

      // 只要焦点不在文本框里，这个键就归本对话框所有 —— 即使历史已经空了也不
      // 能漏给 EditorShell，否则「在窗口里按 Ctrl+Z 结果撤掉了文档」的老毛病又回来。
      if (key === "y" || e.shiftKey) redo();
      else undo();
      e.preventDefault();
      // 捕获阶段拦住，EditorShell 的全局撤销（window 冒泡）就不会跟着走。
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, redo, undo]);

  return {
    state,
    setState,
    beginGesture,
    endGesture,
    undo,
    redo,
    canUndo: caps.undo,
    canRedo: caps.redo,
    reset,
  };
}
