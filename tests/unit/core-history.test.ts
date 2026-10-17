/**
 * 历史栈的行为测试。
 *
 * 只测栈本身的推进逻辑（压栈 / 撤销 / 重做 / 跳步 / 分支丢弃 / 上限），
 * 不碰 captureDoc / applyEntry —— 那两个要真画布，跑在 node 环境下不了台。
 * 这里用一个假 entry 顶上，正好把「下标与分支」的边界都覆盖到。
 */
import { History, type HistoryEntry } from "../../src/core/history";

/** 只带 label 的假快照：栈逻辑只认 label 与位置，不认像素。 */
function entry(label: string): HistoryEntry {
  return {
    label,
    layers: [],
    activeLayerId: "",
    width: 1,
    height: 1,
    selection: null,
  };
}

describe("History", () => {
  it("开栈之后只有一步，下标停在 0", () => {
    const h = new History();
    h.reset(entry("打开"));
    expect(h.size).toBe(1);
    expect(h.index).toBe(0);
    expect(h.labels()).toEqual(["打开"]);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it("压栈之后下标跟到最新，currentLabel 同步", () => {
    const h = new History();
    h.reset(entry("打开"));
    h.commit(entry("画笔"));
    h.commit(entry("填充"));
    expect(h.size).toBe(3);
    expect(h.index).toBe(2);
    expect(h.labels()).toEqual(["打开", "画笔", "填充"]);
    expect(h.currentLabel).toBe("填充");
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
  });

  it("撤销 / 重做只挪下标，不增删步骤", () => {
    const h = new History();
    h.reset(entry("打开"));
    h.commit(entry("画笔"));

    expect(h.undo()?.label).toBe("打开");
    expect(h.index).toBe(0);
    expect(h.size).toBe(2);
    expect(h.canRedo).toBe(true);

    expect(h.redo()?.label).toBe("画笔");
    expect(h.index).toBe(1);
    expect(h.canRedo).toBe(false);

    // 到顶之后继续撤销 / 重做都返回 null，调用方据此跳过重绘
    expect(h.undo()?.label).toBe("打开");
    expect(h.undo()).toBeNull();
    expect(h.redo()?.label).toBe("画笔");
    expect(h.redo()).toBeNull();
  });

  it("jumpTo 直接落到某一步，落在原地或越界都返回 null", () => {
    const h = new History();
    h.reset(entry("打开"));
    h.commit(entry("画笔"));
    h.commit(entry("填充"));

    expect(h.jumpTo(0)?.label).toBe("打开");
    expect(h.index).toBe(0);
    expect(h.canRedo).toBe(true);

    expect(h.jumpTo(2)?.label).toBe("填充");
    expect(h.index).toBe(2);

    // 原地不动不该被当成一次跳转
    expect(h.jumpTo(2)).toBeNull();
    // 越界同理
    expect(h.jumpTo(-1)).toBeNull();
    expect(h.jumpTo(3)).toBeNull();
    expect(h.index).toBe(2);
  });

  it("撤销之后又压新步，会丢掉原来的重做分支", () => {
    const h = new History();
    h.reset(entry("打开"));
    h.commit(entry("画笔"));
    h.commit(entry("填充"));

    h.undo();
    h.undo();
    expect(h.canRedo).toBe(true);

    h.commit(entry("文字"));
    expect(h.labels()).toEqual(["打开", "文字"]);
    expect(h.index).toBe(1);
    expect(h.canRedo).toBe(false);
  });

  it("超过上限时丢掉最早的那一步", () => {
    const h = new History(3);
    h.reset(entry("打开"));
    h.commit(entry("一"));
    h.commit(entry("二"));
    h.commit(entry("三"));
    expect(h.size).toBe(3);
    // 「打开」被挤掉，最新一步仍在最后
    expect(h.labels()).toEqual(["一", "二", "三"]);
    expect(h.index).toBe(2);
    expect(h.canUndo).toBe(true);
  });

  it("clear 之后回到空栈", () => {
    const h = new History();
    h.reset(entry("打开"));
    h.commit(entry("画笔"));
    h.clear();
    expect(h.size).toBe(0);
    expect(h.index).toBe(-1);
    expect(h.labels()).toEqual([]);
    expect(h.currentLabel).toBe("");
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});
