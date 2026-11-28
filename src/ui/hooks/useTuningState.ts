/**
 * 高频参数 state：滑杆拖动期间不提交 React 状态。
 *
 * 选项栏里的每个滑杆都直接改 EditorShell 的 state，而 EditorShell 是一棵近万行的
 * 组件树 —— 每帧 setState 就会重渲染菜单 / 图层面板 / 直方图 / 画布，手感就是
 * 「拖一下卡一下」。这里把实时值放 ref，松手（App 发出 strata:tuning-commit）
 * 时才提交；离散操作（按钮、键盘、预设）仍然立即提交。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type TuningSetter<T> = (next: T | ((prev: T) => T)) => void;

export function useTuningState<T>(initial: T | (() => T)): [T, TuningSetter<T>] {
  const [state, setState] = useState<T>(initial);
  const liveRef = useRef(state);
  useEffect(() => {
    liveRef.current = state;
  }, [state]);

  const set = useCallback<TuningSetter<T>>((next) => {
    const value =
      typeof next === "function"
        ? (next as (prev: T) => T)(liveRef.current)
        : next;
    liveRef.current = value;
    // 选项栏回调大多是函数式更新（setX((p) => ({ ...p, ...patch }))），
    // 函数式也必须走延迟，否则刚才这层优化等于没做。
    if (document.body.classList.contains("is-tuning")) return;
    setState(value);
  }, []);

  useEffect(() => {
    const commit = () => setState(liveRef.current);
    window.addEventListener("strata:tuning-commit", commit);
    return () => window.removeEventListener("strata:tuning-commit", commit);
  }, []);

  return [state, set];
}
