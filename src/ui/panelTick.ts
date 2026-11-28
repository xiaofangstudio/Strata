/**
 * 面板帧号广播（性能小基建）。
 *
 * 以前直方图 / 示波器靠 EditorShell 里的 `panelTick` state 驱动：外壳每合成一帧
 * 就 setState 一次，结果是**整棵编辑器组件树**跟着重渲染，只为让两三个面板知道
 * “可以重新统计了”。这里改成模块级版本号 + `useSyncExternalStore`：
 *   · 合成侧只 bump 一个普通变量；
 *   · 真正需要刷新的面板各自订阅，其余几十个面板完全不重渲染；
 *   · 调用方传了显式 version 时退回显式版本（参数窗自己的预览帧号）。
 */
import { useCallback, useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function get(): number {
  return version;
}

/** 合成完成后广播一次；不进 React state，不重渲染 EditorShell。 */
export function bumpPanelTick(): void {
  version += 1;
  for (const listener of listeners) listener();
}

let panelTickScheduled = false;

/**
 * 画布帧后面的下一帧再广播：合成侧先把画面交给浏览器，直方图 / 示波器
 * 统计不跟画布呈递抢同一个 rAF，避免“面板更新把主画面顶掉一帧”。
 */
export function schedulePanelTick(): void {
  if (panelTickScheduled) return;
  panelTickScheduled = true;
  requestAnimationFrame(() => {
    panelTickScheduled = false;
    bumpPanelTick();
  });
}

/** 面板订阅帧号；explicitVersion 存在时完全跟随外部版本，不订阅全局 tick。 */
export function useFrameVersion(explicitVersion?: number): number {
  const live = explicitVersion === undefined;
  const stableSubscribe = useCallback(
    (listener: () => void) => (live ? subscribe(listener) : () => undefined),
    [live],
  );
  const stableGet = useCallback(
    () => (live ? get() : (explicitVersion ?? 0)),
    [live, explicitVersion],
  );
  return useSyncExternalStore(stableSubscribe, stableGet, stableGet);
}
