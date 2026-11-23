/**
 * 面板坞布局的纯函数。
 *
 * 拖着面板排序时，用户看到的是「可见面板」这一列，但真正要持久化的是
 * 包含隐藏 / 拆离面板在内的完整顺序。这里把两个坐标系的映射单独抽出来，
 * 不碰 DOM、不碰 localStorage，便于单测钉死边界行为。
 */

/**
 * 把 id 拖到可见列的第 at 个位置之前。
 *
 * @param order 完整顺序（含隐藏 / 拆离的面板）
 * @param visible 当前可见顺序（order 的子序列）
 * @param id 被拖动的面板
 * @param at 落点下标，**按拖动前的可见列**计算；等于 visible.length 表示拖到末尾。
 * 落点若在被拖面板原位置之后，要先减一（移除自己后后面的位置整体左移），
 * 否则「原地放下」会被误判成移到下一个面板之后。
 */
export function reorderDockPanel<T extends string>(
  order: readonly T[],
  visible: readonly T[],
  id: T,
  at: number,
): T[] {
  const rest = order.filter((x) => x !== id);
  const list = visible.filter((x) => x !== id);
  const from = visible.indexOf(id);
  const adjusted = from >= 0 && at > from ? at - 1 : at;
  const clamped = Math.max(0, Math.min(list.length, adjusted));
  const next = [...rest];
  const before = list[clamped];
  if (before !== undefined) {
    const pos = next.indexOf(before);
    next.splice(pos < 0 ? next.length : pos, 0, id);
    return next;
  }
  // 落在末尾：紧跟当前可见的最后一项，后面若还有隐藏面板也保持原有相对位置
  const last = list[list.length - 1];
  const pos = last === undefined ? next.length : next.indexOf(last) + 1;
  next.splice(pos < 0 ? next.length : pos, 0, id);
  return next;
}

/** 校验工作区恢复的顺序：只留合法 id、去重、缺项补在末尾。 */
export function sanitizeDockOrder<T extends string>(
  raw: readonly unknown[],
  all: readonly T[],
  valid: (v: unknown) => v is T,
): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of raw) {
    if (valid(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (const id of all) if (!seen.has(id)) out.push(id);
  return out;
}
