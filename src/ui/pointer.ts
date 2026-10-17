/**
 * 指针捕获的小工具。
 *
 * `setPointerCapture` 在「该指针已经不是活动指针」时会抛 `NotFoundError`：
 * 极快的点按、指针在事件派发途中被系统回收、触控板轻点、或者同一帧里被
 * 别处释放，都可能命中。异常会从事件处理器里冒出来，把后面的落笔 / 建选区
 * / 取色 / 拖动整段吃掉，用户看到的就是「点了没反应」。
 *
 * 捕获本身只是优化 —— 它让指针移出元素后还能继续收到事件。失败不该影响
 * 这一笔，所以这里统一吞掉异常。全项目只此一处实现，避免各处各写一份。
 */
export function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* 指针已失效：放弃捕获，操作照常进行 */
  }
}
