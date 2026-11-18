/**
 * 滤镜库效果堆栈（PhotoCraft Filter Gallery 的核心形态）。
 *
 * 与「单选一个滤镜」的旧画廊不同：这里把多个效果按用户排序依次叠加，
 * 每项可单独关掉（显隐）、上移下移（重排）、删除；确定时一次落库成一条历史。
 *
 * 纯函数层只管：把 items 依次喂给 applyAdjustToLayer，并守住两条铁律：
 *  · 不改 activeLayerId（调整层面板/调色台不会因为调滤镜而变脸）；
 *  · 空堆栈 / 不可调整的活动层返回原 doc，不产生假操作。
 *
 * 预览从 base 快照每次重算整条堆栈，绝不在上一次预览上叠加 ——
 * 否则来回拖滑块会把效果越叠越重。
 */
import type { StrataDoc } from "./document";
import { applyAdjustToLayer } from "./layerOps";
import type { AdjustId, AdjustState } from "./layer";

export interface FilterStackItem {
  /** UI 稳定键，重排/删除用；与调整种类无关，所以同种类可以叠多次 */
  uid: string;
  id: AdjustId;
  params: Record<string, number>;
  visible: boolean;
}

/** 把某项转成 applyAdjustToLayer 吃的调整状态。 */
export function itemState(item: FilterStackItem): AdjustState {
  return { id: item.id, params: item.params };
}

/**
 * 依次应用可见项到 base，返回合成后的文档与实际生效的项数。
 * 某一项作用到不可调整的活动层时，applyAdjustToLayer 会返回同引用 ——
 * 这里据此停止后续项（避免后面的项作用到错误的新层上）。
 */
export function applyFilterStack(
  base: StrataDoc,
  items: readonly FilterStackItem[],
): { doc: StrataDoc; applied: number } {
  let doc = base;
  let applied = 0;
  for (const item of items) {
    if (!item.visible) continue;
    const next = applyAdjustToLayer(doc, itemState(item));
    if (next === doc) continue;
    doc = next;
    applied += 1;
  }
  return { doc, applied };
}

/** 堆栈重排：把 from 位置的项移到 to 位置，返回新数组（不动原数组）。 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) {
    return items.slice();
  }
  const out = items.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** 切换某项显隐。 */
export function toggleItem<T extends { visible: boolean }>(items: readonly T[], index: number): T[] {
  const out = items.slice();
  if (index < 0 || index >= out.length) return out;
  out[index] = { ...out[index], visible: !out[index].visible };
  return out;
}
