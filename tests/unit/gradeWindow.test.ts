/**
 * 调色范围几何（core/gradeWindow.ts）的纯逻辑测试。
 *
 * 这块是"拖手柄"的手感来源：命中测试错一个像素，用户就抓不住角点；
 * 拖动公式错一个符号，矩形就会反向翻转。全是无 DOM 的纯函数，正好逐条锁死。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATHER,
  defaultEllipse,
  defaultRect,
  dragWindow,
  hitHandle,
  rectFromBox,
  windowBounds,
  windowHandles,
  windowHit,
  type GradeWindow,
} from "../../src/core/gradeWindow";

const ellipse: GradeWindow = { kind: "ellipse", cx: 100, cy: 100, rx: 40, ry: 20, feather: 10 };
const rect: GradeWindow = { kind: "rect", x: 50, y: 60, w: 100, h: 40, feather: 10 };
const tri: GradeWindow = {
  kind: "poly",
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 100 },
  ],
  feather: 0,
};

describe("默认范围", () => {
  it("椭圆居中、占画面 60%", () => {
    const w = defaultEllipse(1000, 500);
    expect(w).toMatchObject({ kind: "ellipse", cx: 500, cy: 250, rx: 300, ry: 150 });
    expect(w.feather).toBe(DEFAULT_FEATHER);
  });

  it("矩形居中、占画面 60%", () => {
    const w = defaultRect(1000, 500);
    expect(w).toMatchObject({ kind: "rect", x: 200, y: 100, w: 600, h: 300 });
  });

  it("由选区包围盒转矩形范围", () => {
    expect(rectFromBox({ x: 10, y: 20, w: 30, h: 40 })).toMatchObject({
      kind: "rect",
      x: 10,
      y: 20,
      w: 30,
      h: 40,
    });
  });
});

describe("命中形状", () => {
  it("椭圆：中心在里、正外缘内侧在里、角落在外", () => {
    expect(windowHit(ellipse, 100, 100)).toBe(true);
    expect(windowHit(ellipse, 139, 100)).toBe(true);
    expect(windowHit(ellipse, 100, 119)).toBe(true);
    expect(windowHit(ellipse, 140, 120)).toBe(false);
  });

  it("矩形：边界算里，外面不算", () => {
    expect(windowHit(rect, 50, 60)).toBe(true);
    expect(windowHit(rect, 150, 100)).toBe(true);
    expect(windowHit(rect, 151, 100)).toBe(false);
    expect(windowHit(rect, 40, 100)).toBe(false);
  });

  it("多边形：内部算里、外部不算（射线法）", () => {
    expect(windowHit(tri, 50, 40)).toBe(true);
    expect(windowHit(tri, 10, 90)).toBe(false);
    expect(windowHit(tri, 120, 10)).toBe(false);
  });
});

describe("包围盒", () => {
  it("椭圆含羽化向外扩散", () => {
    expect(windowBounds(ellipse)).toEqual({ x: 50, y: 70, w: 100, h: 60 });
  });

  it("矩形含羽化", () => {
    expect(windowBounds(rect)).toEqual({ x: 40, y: 50, w: 120, h: 60 });
  });

  it("多边形取顶点极值再外扩", () => {
    expect(windowBounds(tri)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

describe("手柄与命中", () => {
  it("椭圆有中心 + 四向 + 羽化共 6 个手柄", () => {
    expect(windowHandles(ellipse, 1)).toHaveLength(6);
  });

  it("矩形有中心 + 四角 + 羽化共 6 个手柄", () => {
    const hs = windowHandles(rect, 1);
    expect(hs.map((h) => h.id)).toEqual(["move", "nw", "ne", "sw", "se", "feather"]);
  });

  it("多边形每个顶点一个手柄 + 羽化", () => {
    const hs = windowHandles(tri, 1);
    expect(hs.map((h) => h.id)).toEqual(["v0", "v1", "v2", "feather"]);
  });

  it("缩放越小手柄越大（屏幕上恒定大小）", () => {
    const a = windowHandles(ellipse, 1)[0].r;
    const b = windowHandles(ellipse, 0.25)[0].r;
    expect(b).toBeGreaterThan(a);
  });

  it("点在手柄上返回手柄，点在形状里返回 move，在外面返回 null", () => {
    expect(hitHandle(ellipse, 140, 100, 1)).toBe("e");
    expect(hitHandle(ellipse, 100, 100, 1)).toBe("move");
    expect(hitHandle(ellipse, 300, 300, 1)).toBeNull();
  });

  it("羽化手柄在角点之外也能抓到（不会被角点抢）", () => {
    // 椭圆羽化手柄在 (100+50, 100-30)
    expect(hitHandle(ellipse, 150, 70, 1)).toBe("feather");
  });
});

describe("拖动", () => {
  it("整体移动不改尺寸", () => {
    const w = dragWindow("move", ellipse, 15, -5) as typeof ellipse;
    expect(w).toMatchObject({ cx: 115, cy: 95, rx: 40, ry: 20 });
  });

  it("椭圆右把手只改 rx，且不会缩成负数", () => {
    expect(dragWindow("e", ellipse, 10, 0)).toMatchObject({ rx: 50 });
    expect(dragWindow("e", ellipse, -100, 0)).toMatchObject({ rx: 2 });
  });

  it("矩形左上角：位置与尺寸一起变", () => {
    const w = dragWindow("nw", rect, 10, 5) as typeof rect;
    expect(w.x).toBe(60);
    expect(w.y).toBe(65);
    expect(w.w).toBe(90);
    expect(w.h).toBe(35);
  });

  it("矩形右下角只改尺寸", () => {
    const w = dragWindow("se", rect, 10, 5) as typeof rect;
    expect(w.x).toBe(50);
    expect(w.w).toBe(110);
    expect(w.h).toBe(45);
  });

  it("多边形拖单个顶点，其他点不动", () => {
    const w = dragWindow("v1", tri, -10, 10) as typeof tri;
    expect(w.points[0]).toEqual({ x: 0, y: 0 });
    expect(w.points[1]).toEqual({ x: 90, y: 10 });
    expect(w.points[2]).toEqual({ x: 50, y: 100 });
  });

  it("羽化被夹在 0–400，且不会被拖成负数", () => {
    expect((dragWindow("feather", ellipse, -100, -100) as typeof ellipse).feather).toBe(0);
    expect((dragWindow("feather", ellipse, 500, 500) as typeof ellipse).feather).toBe(400);
  });

  it("拖动不会抹掉反转标记", () => {
    const inverted: GradeWindow = { ...ellipse, invert: true };
    expect(dragWindow("move", inverted, 5, 5)).toMatchObject({ invert: true });
  });
});
