/**
 * `src/core/layerOps.ts` 的纯逻辑契约。
 *
 * layerOps 全部写成「旧文档 → 新文档」的纯函数：不改入参、要么返回新文档、
 * 要么在「什么都没做」时原样返回同一引用。测试正是围绕这条契约 —— 用最小
 * DOM 替身承接内部的 canvas 分配，只断言引用变化、图层顺序与几何偏移。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addAdjustLayer,
  addLayer,
  addMask,
  applyAdjustToLayer,
  canShiftLayer,
  duplicateLayer,
  groupChildren,
  groupLayers,
  mergeDown,
  moveLayer,
  removeLayer,
  reorderLayer,
  resizeCanvas,
  resizeDocument,
  selectLayer,
  setBlend,
  setOpacity,
  toggleClip,
  translateLayer,
  ungroupLayers,
  updateLayer,
  type Anchor,
} from "../../src/core/layerOps";
import { docFromBlank, type StrataDoc } from "../../src/core/document";
import { newAdjustState } from "../../src/core/layer";
import { drawCalls, installDomStub, type DomStub, type StubCanvas } from "../helpers/canvas";

let dom: DomStub;

beforeAll(() => {
  dom = installDomStub();
});
afterAll(() => {
  dom.restore();
});

/** 一张 100×100 的透明背景文档。 */
const blank = (w = 100, h = 100): StrataDoc =>
  docFromBlank(w, h, "t", "transparent");

const names = (doc: StrataDoc): string[] => doc.layers.map((l) => l.name);

const surfaceOf = (doc: StrataDoc, index: number): StubCanvas =>
  doc.layers[index].surface as unknown as StubCanvas;

/** 逐层在 active 之上叠两层，得到 [背景, L2, L3]，active = L3。 */
const threeLayers = (): StrataDoc => addLayer(addLayer(blank(), "L2"), "L3");

describe("图层增删", () => {
  it("addLayer 返回新文档、插在 active 之上并选中新层", () => {
    const doc = blank();
    const next = addLayer(doc, "新层");
    expect(next).not.toBe(doc);
    expect(next.dirty).toBe(true);
    expect(next.layers).toHaveLength(2);
    expect(names(next)).toEqual(["背景", "新层"]);
    expect(next.activeLayerId).toBe(next.layers[1].id);
  });

  it("addLayer 不给名字时按当前层数自动命名", () => {
    expect(addLayer(blank()).layers[1].name).toBe("图层 2");
  });

  it("duplicateLayer 复制并命名为「副本」，选中副本", () => {
    const doc = blank();
    const next = duplicateLayer(doc);
    expect(next).not.toBe(doc);
    expect(next.layers).toHaveLength(2);
    expect(names(next)).toEqual(["背景", "背景 副本"]);
    expect(next.layers[1].id).not.toBe(doc.layers[0].id);
    expect(next.activeLayerId).toBe(next.layers[1].id);
  });

  it("removeLayer 在只剩一层时原样返回同一引用", () => {
    const doc = blank();
    expect(removeLayer(doc)).toBe(doc);
  });

  it("removeLayer 删掉 active 并把选中落到相邻层", () => {
    const doc = threeLayers(); // active = L3 (index 2)
    const next = removeLayer(doc);
    expect(next).not.toBe(doc);
    expect(names(next)).toEqual(["背景", "L2"]);
    expect(next.activeLayerId).toBe(next.layers[1].id);
  });
});

describe("图层重排", () => {
  it("moveLayer 向上 / 向下交换相邻两层", () => {
    const doc = threeLayers();
    const up = moveLayer(doc, -1);
    expect(up).not.toBe(doc);
    expect(names(up)).toEqual(["背景", "L3", "L2"]);

    const down = moveLayer(doc, 1); // active 已在最上层 → 不动
    expect(down).toBe(doc);
  });

  it("moveLayer 越界时原样返回同一引用", () => {
    const doc = threeLayers();
    const bottom = selectLayer(doc, doc.layers[0].id);
    expect(moveLayer(bottom, -1)).toBe(bottom);
  });

  it("reorderLayer from === to 时不动", () => {
    const doc = threeLayers();
    expect(reorderLayer(doc, 1, 1)).toBe(doc);
  });

  it("reorderLayer 越界时不动", () => {
    const doc = threeLayers();
    expect(reorderLayer(doc, -1, 0)).toBe(doc);
    expect(reorderLayer(doc, 0, 5)).toBe(doc);
  });

  it("reorderLayer 把指定层落到目标位置", () => {
    const doc = threeLayers();
    const next = reorderLayer(doc, 0, 2);
    expect(next).not.toBe(doc);
    expect(names(next)).toEqual(["L2", "L3", "背景"]);
  });
});

describe("属性修改的引用语义", () => {
  it("updateLayer 总是返回新文档，未命中的层保持原引用", () => {
    const doc = threeLayers();
    const target = doc.layers[1].id;
    const next = updateLayer(doc, target, { name: "改名" });
    expect(next).not.toBe(doc);
    expect(next.layers[1].name).toBe("改名");
    expect(next.layers[0]).toBe(doc.layers[0]);
    expect(next.layers[2]).toBe(doc.layers[2]);
  });

  it("updateLayer 即使 id 不存在也返回新文档（不改入参）", () => {
    const doc = threeLayers();
    const next = updateLayer(doc, "no-such-id", { opacity: 10 });
    expect(next).not.toBe(doc);
    expect(names(next)).toEqual(names(doc));
  });

  it("selectLayer 命中当前 active 时返回同一引用", () => {
    const doc = threeLayers();
    expect(selectLayer(doc, doc.activeLayerId)).toBe(doc);
  });

  it("selectLayer 切换时返回新文档且不改图层数组", () => {
    const doc = threeLayers();
    const next = selectLayer(doc, doc.layers[0].id);
    expect(next).not.toBe(doc);
    expect(next.activeLayerId).toBe(doc.layers[0].id);
    expect(next.layers).toBe(doc.layers);
  });

  it("setOpacity 夹到 0–100 并四舍五入", () => {
    const doc = threeLayers();
    const id = doc.layers[0].id;
    expect(setOpacity(doc, id, -10).layers[0].opacity).toBe(0);
    expect(setOpacity(doc, id, 150).layers[0].opacity).toBe(100);
    expect(setOpacity(doc, id, 49.6).layers[0].opacity).toBe(50);
    expect(setOpacity(doc, id, 33).layers[0].opacity).toBe(33);
  });

  it("setBlend 写入混合模式", () => {
    const doc = threeLayers();
    const id = doc.layers[0].id;
    expect(setBlend(doc, id, "multiply").layers[0].blend).toBe("multiply");
  });
});

describe("蒙版与剪贴", () => {
  it("addMask(reveal) 建蒙版并启用，重复添加不动", () => {
    const doc = blank();
    const next = addMask(doc, "reveal");
    expect(next).not.toBe(doc);
    expect(next.layers[0].mask).not.toBeNull();
    expect(next.layers[0].maskActive).toBe(true);
    const mask = next.layers[0].mask as unknown as StubCanvas;
    expect(mask.width).toBe(100);
    expect(mask.height).toBe(100);
    // reveal 会刷一层白
    expect(mask.getContext("2d")!.calls).toContain("fillRect");
    // 已有蒙版 → 原样返回
    expect(addMask(next, "reveal")).toBe(next);
  });

  it("toggleClip 在底层（index 0）不允许，返回同一引用", () => {
    const doc = blank();
    expect(toggleClip(doc)).toBe(doc);
  });

  it("toggleClip 在可剪贴的层上开关", () => {
    const doc = addLayer(blank(), "上");
    const on = toggleClip(doc);
    expect(on).not.toBe(doc);
    expect(on.layers[1].clip).toBe(true);
    const off = toggleClip(on);
    expect(off.layers[1].clip).toBe(false);
  });
});

describe("resizeDocument（重定像素）", () => {
  it("尺寸未变（含四舍五入后相等）时返回同一引用", () => {
    const doc = blank();
    expect(resizeDocument(doc, 100, 100)).toBe(doc);
    expect(resizeDocument(doc, 100.4, 99.6)).toBe(doc);
  });

  it("尺寸变化时返回新文档并按新尺寸重建所有 surface", () => {
    const doc = blank();
    const next = resizeDocument(doc, 50, 70);
    expect(next).not.toBe(doc);
    expect(next.width).toBe(50);
    expect(next.height).toBe(70);
    expect(next.dirty).toBe(true);
    expect(surfaceOf(next, 0)).not.toBe(surfaceOf(doc, 0));
    expect(surfaceOf(next, 0).width).toBe(50);
    expect(surfaceOf(next, 0).height).toBe(70);
    // 缩放是一次 4 参 drawImage(src, 0, 0, w, h)
    expect(drawCalls(next.layers[0].surface)[0]).toEqual([
      doc.layers[0].surface,
      0,
      0,
      50,
      70,
    ]);
  });

  it("尺寸被夹到至少 1×1", () => {
    const next = resizeDocument(blank(), 0, -8);
    expect(next.width).toBe(1);
    expect(next.height).toBe(1);
  });
});

describe("resizeCanvas 的九宫格锚点映射", () => {
  // 100×100 → 120×140，dw = 20，dh = 40
  const cases: Array<[Anchor, number, number]> = [
    ["nw", 0, 0],
    ["n", 10, 0],
    ["ne", 20, 0],
    ["w", 0, 20],
    ["c", 10, 20],
    ["e", 20, 20],
    ["sw", 0, 40],
    ["s", 10, 40],
    ["se", 20, 40],
  ];

  it.each(cases)("锚点 %s → 偏移 (dx=%i, dy=%i)", (anchor, dx, dy) => {
    const doc = blank();
    const next = resizeCanvas(doc, 120, 140, anchor);
    expect(next).not.toBe(doc);
    expect(next.width).toBe(120);
    expect(next.height).toBe(140);
    expect(next.selection).toBeNull();
    // 只改画布尺寸、不缩放：3 参 drawImage(src, dx, dy)
    expect(drawCalls(next.layers[0].surface)[0]).toEqual([
      doc.layers[0].surface,
      dx,
      dy,
    ]);
  });

  it("默认锚点是居中（c）", () => {
    const doc = blank();
    const next = resizeCanvas(doc, 120, 140);
    expect(drawCalls(next.layers[0].surface)[0]).toEqual([
      doc.layers[0].surface,
      10,
      20,
    ]);
  });

  it("尺寸不变时返回同一引用", () => {
    const doc = blank();
    expect(resizeCanvas(doc, 100, 100)).toBe(doc);
  });

  it("会清空选区（坐标已失效）", () => {
    const doc: StrataDoc = { ...blank(), selection: blank(100, 100).layers[0].surface };
    const next = resizeCanvas(doc, 120, 140, "c");
    expect(next.selection).toBeNull();
  });
});

describe("applyAdjustToLayer（图像 > 调整，破坏性）", () => {
  it("参数中性时不做任何事，返回同一引用", () => {
    const doc = blank();
    expect(applyAdjustToLayer(doc, newAdjustState("bc"))).toBe(doc);
  });

  it("非中性时替换当前像素层的 surface", () => {
    const doc = blank();
    const layerId = doc.layers[0].id;
    const before = doc.layers[0].surface;
    const next = applyAdjustToLayer(doc, {
      id: "bc",
      params: { brightness: 20 },
    });
    expect(next).not.toBe(doc);
    const after = next.layers.find((l) => l.id === layerId)!.surface;
    expect(after).not.toBe(before);
    // 把原图按滤镜画一次进新 surface
    expect(drawCalls(after)).toEqual([[before, 0, 0]]);
    // 画完要把 filter 复位，别把滤镜漏给后续绘制
    expect(after.getContext("2d")!.filter).toBe("none");
  });

  it("锁定层 / 调整层 / 未命中 active 时都不动", () => {
    const lockedDoc = blank();
    lockedDoc.layers[0].locked = true;
    expect(applyAdjustToLayer(lockedDoc, { id: "bc", params: { brightness: 20 } })).toBe(
      lockedDoc,
    );

    const adjustDoc = addAdjustLayer(blank(), newAdjustState("bc"));
    expect(
      applyAdjustToLayer(adjustDoc, { id: "bc", params: { brightness: 20 } }),
    ).toBe(adjustDoc);

    const strayDoc = selectLayer(blank(), "no-such-id");
    expect(
      applyAdjustToLayer(strayDoc, { id: "bc", params: { brightness: 20 } }),
    ).toBe(strayDoc);
  });
});

describe("图层组（M3）", () => {
  it("groupLayers 把活动层收进新组，组落在其正上方", () => {
    const doc = threeLayers(); // [背景, L2, L3]，active = L3
    const next = groupLayers(doc, "组 A");
    expect(next).not.toBe(doc);
    expect(next.dirty).toBe(true);
    expect(names(next)).toEqual(["背景", "L2", "L3", "组 A"]);
    const group = next.layers[3];
    expect(group.kind).toBe("group");
    expect(next.layers[2].parent).toBe(group.id);
    expect(next.activeLayerId).toBe(group.id);
    // 纯函数：原文档一个字都没改
    expect(doc.layers).toHaveLength(3);
    expect(doc.layers[2].parent).toBeNull();
  });

  it("组的 surface 只是 1×1 占位，不占整幅画布", () => {
    const group = groupLayers(threeLayers(), "组 A").layers[3];
    expect(group.surface.width).toBe(1);
    expect(group.surface.height).toBe(1);
  });

  it("groupChildren 只列直属子层，不含隔代", () => {
    const doc = groupLayers(threeLayers(), "组 A");
    const group = doc.layers[3];
    expect(groupChildren(doc, group.id).map((l) => l.name)).toEqual(["L3"]);
  });

  it("ungroupLayers 拆掉壳，子层回到原层级并选中第一个子层", () => {
    const grouped = groupLayers(threeLayers(), "组 A");
    const next = ungroupLayers(grouped);
    expect(next).not.toBe(grouped);
    expect(names(next)).toEqual(["背景", "L2", "L3"]);
    expect(next.layers[2].parent).toBeNull();
    expect(next.activeLayerId).toBe(next.layers[2].id);
    // 拆的是副本，原文档结构不动
    expect(grouped.layers).toHaveLength(4);
  });

  it("选中非组时 ungroupLayers 原样返回同一引用", () => {
    const doc = threeLayers();
    expect(ungroupLayers(doc)).toBe(doc);
  });

  it("canShiftLayer 认的是同层级兄弟，不是数组下标", () => {
    const doc = groupLayers(threeLayers(), "组 A"); // [背景, L2, L3(组 A 内), 组 A]
    const group = doc.layers[3];
    expect(doc.activeLayerId).toBe(group.id);
    // 组已在栈顶 → 上移不可用
    expect(canShiftLayer(doc, 1)).toBe(false);
    // 组是自己那一块的「壳」，正下方接着的是它的子层，整块往下换位才说得通
    expect(canShiftLayer(doc, -1)).toBe(true);

    // 组内最底下那层（下标是 2，看着像个「中间位置」而不是边界）已经
    // 没有组内的兄弟了 —— 按下标判断会错放行，这里必须拦住
    const child = selectLayer(doc, doc.layers[2].id);
    expect(canShiftLayer(child, -1)).toBe(false);
    // 换成组外真正的同级兄弟，又有得换了
    expect(canShiftLayer(selectLayer(doc, doc.layers[1].id), -1)).toBe(true);
  });

  it("组内子层只在组内换位，走不出组的边界", () => {
    // addLayer 落在组内最上层：[背景, L2, L3, X, 组 A]，active = X
    const doc = addLayer(groupLayers(threeLayers(), "组 A"), "X");
    expect(names(doc)).toEqual(["背景", "L2", "L3", "X", "组 A"]);
    expect(doc.layers[3].parent).toBe(doc.layers[4].id);
    // X 是组内最上层，再往上就是组这层壳 → 换不了
    expect(canShiftLayer(doc, 1)).toBe(false);
    // 往下是组内的 L3，是兄弟 → 可以换
    expect(canShiftLayer(doc, -1)).toBe(true);
    expect(names(moveLayer(doc, -1))).toEqual(["背景", "L2", "X", "L3", "组 A"]);
    // L3 是组内最下层，再往下是同级的 L2 —— 但那是组外，不许出去
    const onL3 = selectLayer(doc, doc.layers[2].id);
    expect(canShiftLayer(onL3, -1)).toBe(false);
  });

  it("上下移是整块搬：组带着子层一起走，且仍然紧挨着", () => {
    // 先垫一层再编组，让组头顶有个组外兄弟：[背景, 新层, L2, 组 A(L3)]
    const base = threeLayers();
    const seeded = addLayer(selectLayer(base, base.layers[0].id), "新层");
    const doc = groupLayers(selectLayer(seeded, seeded.layers[3].id), "组 A");
    expect(names(doc)).toEqual(["背景", "新层", "L2", "L3", "组 A"]);
    const group = doc.layers[4];
    // 整块 = [L3, 组 A]，往下一格落到 L2 下面
    const next = moveLayer(doc, -1);
    expect(names(next)).toEqual(["背景", "新层", "L3", "组 A", "L2"]);
    // 子层与组仍然紧挨着，父指针没断
    expect(next.layers[2].parent).toBe(next.layers[3].id);
    expect(next.layers[3].id).toBe(group.id);
  });

  it("mergeDown 不合并组，也不跨组边界", () => {
    const doc = addLayer(groupLayers(threeLayers(), "组 A"), "X"); // [背景, L2, L3, X, 组 A]
    // 选中的是组本身 → 不动
    const onGroup = selectLayer(doc, doc.layers[4].id);
    expect(mergeDown(onGroup)).toBe(onGroup);
    // 组内最底层，往下是组外的 L2（跨了边界）→ 不动
    const insideBottom = selectLayer(doc, doc.layers[2].id);
    expect(insideBottom.layers[1].parent).not.toBe(insideBottom.layers[2].parent);
    expect(mergeDown(insideBottom)).toBe(insideBottom);
  });

  it("translateLayer 拖组 = 整棵子树一起平移", () => {
    const doc = groupLayers(threeLayers(), "组 A");
    const group = doc.layers[3];
    const beforeChild = doc.layers[2].surface;
    const beforeBase = doc.layers[0].surface;
    const next = translateLayer(doc, 5, -3);
    expect(next).not.toBe(doc);
    // 组里的子层被平移
    const afterChild = next.layers[2].surface;
    expect(afterChild).not.toBe(beforeChild);
    expect(drawCalls(afterChild)).toEqual([[beforeChild, 5, -3]]);
    // 组外的层纹丝不动（连引用都没换）
    expect(next.layers[0].surface).toBe(beforeBase);
    // 组这层壳没有像素，不参与平移
    expect(next.layers[3].surface).toBe(group.surface);
  });

  it("translateLayer 拖普通层只动它自己", () => {
    const doc = threeLayers(); // active = L3
    const next = translateLayer(doc, 2, 4);
    expect(next).not.toBe(doc);
    expect(drawCalls(next.layers[2].surface)).toEqual([[doc.layers[2].surface, 2, 4]]);
    expect(next.layers[0].surface).toBe(doc.layers[0].surface);
  });

  it("translateLayer 位移为零 / 选中调整层时原样返回同一引用", () => {
    const doc = threeLayers();
    expect(translateLayer(doc, 0, 0)).toBe(doc);
    const withAdjust = addAdjustLayer(doc, newAdjustState("bc"));
    expect(translateLayer(withAdjust, 3, 3)).toBe(withAdjust);
  });

  it("duplicateLayer 选中组时连整棵子树一起复制", () => {
    // [背景, L2, L3, X, 组 A]：整块 = [L3, X, 组 A]
    const doc = addLayer(groupLayers(threeLayers(), "组 A"), "X");
    const next = duplicateLayer(selectLayer(doc, doc.layers[4].id));
    expect(next).not.toBe(doc);
    expect(names(next)).toEqual([
      "背景",
      "L2",
      "L3",
      "X",
      "组 A",
      "L3",
      "X",
      "组 A 副本",
    ]);
    const copy = next.layers[7];
    expect(next.activeLayerId).toBe(copy.id);
    // 副本里的子层挂在副本组上，不是原组
    expect(next.layers[5].parent).toBe(copy.id);
    expect(next.layers[6].parent).toBe(copy.id);
    // 像素是独立的一份
    expect(next.layers[5].surface).not.toBe(doc.layers[2].surface);
    // 原组还在、父指针没被改写
    expect(next.layers[2].parent).toBe(doc.layers[4].id);
  });

  it("removeLayer 删组时整棵子树一起删", () => {
    const doc = addLayer(groupLayers(threeLayers(), "组 A"), "X"); // [背景, L2, L3, X, 组 A]
    const next = removeLayer(selectLayer(doc, doc.layers[4].id));
    expect(names(next)).toEqual(["背景", "L2"]);
  });
});
