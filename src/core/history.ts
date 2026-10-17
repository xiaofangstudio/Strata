/**
 * 历史栈（撤销 / 重做）。
 *
 * M1 用整体快照：实现直白、绝不会出现「状态漂移」。代价是每步都要拷一份
 * 画布内存，所以步数按文档体量折算上限，并且笔画这类连续操作在抬笔时才
 * 提交一步（拖拽过程中不压栈）。
 *
 * 立项规划书 §6.3 提到的「大操作走引用 + 差异」属于 M2 的分块渲染改造，
 * 届时换成瓦片级差异快照，上层调用方式不变。
 */
import { dupLayer, type StrataLayer } from "./layer";
import type { StrataDoc } from "./document";
import { cloneSelection } from "./selection";

export interface HistoryEntry {
  /** 这一步做了什么，给撤销提示用 */
  label: string;
  layers: StrataLayer[];
  activeLayerId: string;
  width: number;
  height: number;
  /**
   * 当时的选区（无选区为 null）。
   *
   * 选区也进撤销栈：PS 里撤销会连选区一起还原，否则「取消选区」之后
   * 再撤销上一步填充，就会出现「填充回来了但没框」的错位感。
   */
  selection: HTMLCanvasElement | null;
}

/** 快照当前文档状态。会深拷贝全部图层像素，调用点要克制。 */
export function captureDoc(doc: StrataDoc, label: string): HistoryEntry {
  return {
    label,
    layers: doc.layers.map(dupLayer),
    activeLayerId: doc.activeLayerId,
    width: doc.width,
    height: doc.height,
    selection: doc.selection ? cloneSelection(doc.selection) : null,
  };
}

/**
 * 把快照回填成一份新文档。
 *
 * 回填时会再拷一次像素：否则后续编辑会就地改到快照里的画布，
 * 历史步之间互相污染。
 */
export function applyEntry(doc: StrataDoc, entry: HistoryEntry): StrataDoc {
  const layers = entry.layers.map(dupLayer);
  const alive = layers.some((l) => l.id === entry.activeLayerId);
  return {
    ...doc,
    width: entry.width,
    height: entry.height,
    layers,
    activeLayerId: alive ? entry.activeLayerId : (layers[layers.length - 1]?.id ?? ""),
    selection: entry.selection ? cloneSelection(entry.selection) : null,
    dirty: true,
  };
}

export class History {
  private entries: HistoryEntry[] = [];
  private cursor = -1;

  constructor(private readonly limit = 40) {}

  /** 用文档的初始状态开栈。 */
  reset(entry: HistoryEntry): void {
    this.entries = [entry];
    this.cursor = 0;
  }

  /** 提交一步。会丢弃当前位置之后的重做分支。 */
  commit(entry: HistoryEntry): void {
    this.entries.splice(this.cursor + 1);
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    this.cursor = this.entries.length - 1;
  }

  undo(): HistoryEntry | null {
    if (this.cursor <= 0) return null;
    this.cursor -= 1;
    return this.entries[this.cursor];
  }

  redo(): HistoryEntry | null {
    if (this.cursor >= this.entries.length - 1) return null;
    this.cursor += 1;
    return this.entries[this.cursor];
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length - 1;
  }

  /** 当前所处步骤名，用于状态栏与提示。 */
  get currentLabel(): string {
    return this.entries[this.cursor]?.label ?? "";
  }

  /** 一共压了多少步（含最开始那一步「打开」）。 */
  get size(): number {
    return this.entries.length;
  }

  /** 当前停在第几步（下标从 0 起，等于 size - 1 表示在最新一步）。 */
  get index(): number {
    return this.cursor;
  }

  /** 全部步骤名，从最早到最新 —— 历史面板照着它列。 */
  labels(): string[] {
    return this.entries.map((e) => e.label);
  }

  /**
   * 直接跳到某一步（历史面板点击用）。
   *
   * 越界、或者点的就是当前这一步，都返回 null，调用方据此跳过重绘 ——
   * 与 undo/redo 不同，这个方法不认方向，只认落点。
   */
  jumpTo(index: number): HistoryEntry | null {
    if (index < 0 || index >= this.entries.length) return null;
    if (index === this.cursor) return null;
    this.cursor = index;
    return this.entries[index];
  }

  /** 清空（关闭文档时释放画布内存）。 */
  clear(): void {
    this.entries = [];
    this.cursor = -1;
  }
}
