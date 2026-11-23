/**
 * 对话框内的参数撤销栈（移植自 PhotoCraft `edit_history.rs` 的语义）。
 *
 * 与文档级历史的区别：
 *   · 只记录**这个对话框自己的参数快照**，Ctrl+Z 不会把用户的文档改动一起撤掉；
 *   · 拖动滑杆时连续来的中间值不进历史，松手（`settle(..., false)`）才合成一步；
 *   · 上限 100 步，超出丢最旧的一步，避免参数窗长时间开着把内存吃满。
 *
 * 纯函数式容器：不碰 DOM、不碰 React，方便单测。React 侧接线见
 * `ui/hooks/useDialogUndo.ts`。
 */

export type EditStep = "undo" | "redo";

export interface EditStepResult<T> {
  /** 步进后的参数快照；无法步进时原样返回传入的 now。 */
  value: T;
  /** 是否真的走了一步（false 表示栈到头了）。 */
  changed: boolean;
}

const DEFAULT_LIMIT = 100;

export class EditHistory<T> {
  private readonly undo: T[] = [];
  private readonly redo: T[] = [];
  private settled: T;

  constructor(initial: T, private readonly limit: number = DEFAULT_LIMIT) {
    this.settled = initial;
  }

  get canUndo(): boolean {
    return this.undo.length > 0;
  }

  get canRedo(): boolean {
    return this.redo.length > 0;
  }

  get depth(): number {
    return this.undo.length;
  }

  /**
   * 把当前参数收进历史。
   *
   * `busy = true` 表示手势还在进行中：只更新「当前值」，不新增历史条目。
   * 松手时再次以最终值调用（busy = false），才会把**手势开始前**的快照压栈。
   */
  settle(now: T, busy = false): boolean {
    if (busy || Object.is(now, this.settled)) return false;
    if (this.undo.length >= this.limit) this.undo.shift();
    this.undo.push(this.settled);
    this.settled = now;
    // 新操作一进来，之前被撤销的分支就作废（与文档历史一致）
    this.redo.length = 0;
    return true;
  }

  /** 撤销 / 重做一步。调用方负责把返回的 value 同步回 UI。 */
  step(now: T, direction: EditStep): EditStepResult<T> {
    if (direction === "undo") {
      if (this.undo.length === 0) return { value: now, changed: false };
      if (this.redo.length >= this.limit) this.redo.shift();
      this.redo.push(now);
      const prev = this.undo.pop() as T;
      this.settled = prev;
      return { value: prev, changed: true };
    }
    if (this.redo.length === 0) return { value: now, changed: false };
    if (this.undo.length >= this.limit) this.undo.shift();
    this.undo.push(now);
    const next = this.redo.pop() as T;
    this.settled = next;
    return { value: next, changed: true };
  }

  /** 丢弃整条历史（对话框切换调整类型 / 滤镜时可用）。 */
  reset(initial: T): void {
    this.undo.length = 0;
    this.redo.length = 0;
    this.settled = initial;
  }
}
