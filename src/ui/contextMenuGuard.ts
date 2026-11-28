/**
 * 全局右键守卫。
 *
 * 这是 Tauri WebView / 网页壳的硬规则：**任何位置都不弹系统原生右键菜单**。
 * 需要右键的地方一律走 React 自己的 `ContextMenu`（画布、图层、蒙版、参考线…），
 * 不需要右键的地方就什么都不弹。
 *
 * 挂在 window 捕获阶段而不是 React 根上，是为了盖住启动页 / 欢迎页 / 弹窗 /
 * 面板缝 / 输入框等所有 EditorShell 管辖不到的区域。
 * 只 `preventDefault()`，**不 stopPropagation()**：React 的 onContextMenu
 * 仍会正常收到事件，我们自己的菜单照样能弹。
 */
interface EventTargetLike {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean,
  ): void;
}

export function installContextMenuGuard(
  win: EventTargetLike,
  doc: EventTargetLike,
): () => void {
  const block = (e: Event) => e.preventDefault();
  win.addEventListener("contextmenu", block, true);
  doc.addEventListener("contextmenu", block, true);
  return () => {
    win.removeEventListener("contextmenu", block, true);
    doc.removeEventListener("contextmenu", block, true);
  };
}
