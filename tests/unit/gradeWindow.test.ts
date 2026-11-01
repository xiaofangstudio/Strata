/**
 * 调色范围几何（core/gradeWindow.ts）的纯逻辑测试。
 *
 * 这块是"拖手柄"的手感来源：命中测试错一个像素，用户就抓不住角点；
 * 拖动公式错一个符号，四边形就会自己变形。全是无 DOM 的纯函数，逐条锁死。
 *
 * 特别盯住一条：**四边形拖一个角，另外三个角必须原地不动** ——
 * 这是它和"矩形缩放"的根本区别。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATHER,
  defaultEllipse,
  defaultLine,
  defaultPoly,
  defaultQuad,
  dragWindow,
  hitHandle,
  quadEdgeFeathers,
  quadFromBox,
  windowBounds,
  windowCenter,
  windowHandles,
  windowHit,
  type GradeWindow,
} from "../../src/core/gradeWindow";

const ellipse: GradeWindow = { kind: "ellipse", cx: 100, cy: 100, rx: 40, ry: 20, feather: 10 };

/** 一个 100×40 的矩形四边形（左上 50,60）。 */
const quad: GradeWindow = {
  kind: "quad",
  points: [
    { x: 50, y: 60 },
    { x: 150, y: 60 },
    { x: 150, y: 100 },
    { x: 50, y: 100 },
  ],
  feather: 10,
};

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

  it("四边形默认是一个居中矩形框的四角（但它不是矩形工具）", () => {
    const w = defaultQuad(1000, 500);
    expect(w.kind).toBe("quad");
    const pts = (w as { points: { x: number; y: number }[] }).points;
    expect(pts).toEqual([
      { x: 200, y: 100 },
      { x: 800, y: 100 },
      { x: 800, y: 400 },
      { x: 200, y: 400 },
    ]);
  });

  it("由选区包围盒转四边形", () => {
    const w = quadFromBox({ x: 10, y: 20, w: 30, h: 40 });
    expect((w as { points: unknown[] }).points).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
    ]);
  });
});

describe("命中形状", () => {
  it("椭圆：中心在里、正外缘内侧在里、角落在外", () => {
    expect(windowHit(ellipse, 100, 100)).toBe(true);
    expect(windowHit(ellipse, 139, 100)).toBe(true);
    expect(windowHit(ellipse, 100, 119)).toBe(true);
    expect(windowHit(ellipse, 140, 120)).toBe(false);
  });

  it("四边形：内部算里，外面不算", () => {
    expect(windowHit(quad, 100, 80)).toBe(true);
    expect(windowHit(quad, 50, 60)).toBe(true);
    expect(windowHit(quad, 40, 80)).toBe(false);
    expect(windowHit(quad, 100, 110)).toBe(false);
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

  it("四边形取顶点极值 + 最大羽化", () => {
    expect(windowBounds(quad)).toEqual({ x: 40, y: 50, w: 120, h: 60 });
  });

  it("多边形取顶点极值再外扩", () => {
    expect(windowBounds(tri)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

describe("手柄与命中", () => {
  it("椭圆有中心 + 四向 + 旋转 + 羽化共 7 个手柄", () => {
    expect(windowHandles(ellipse, 1)).toHaveLength(7);
  });

  it("四边形有中心 + 四角 + 四条边羽化共 9 个手柄", () => {
    const ids = windowHandles(quad, 1).map((h) => h.id);
    expect(ids).toEqual(["move", "v0", "v1", "v2", "v3", "fe0", "fe1", "fe2", "fe3"]);
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

  it("四边形的边羽化把手在边外侧，抓得到", () => {
    const hs = windowHandles(quad, 1);
    const fe0 = hs.find((h) => h.id === "fe0");
    expect(fe0).toBeTruthy();
    // 上边（y=60）的把手在更上方
    expect(fe0!.y).toBeLessThan(60);
    expect(hitHandle(quad, fe0!.x, fe0!.y, 1)).toBe("fe0");
  });
});

describe("拖动椭圆", () => {
  it("整体移动不改尺寸", () => {
    const w = dragWindow("move", ellipse, 15, -5) as typeof ellipse;
    expect(w).toMatchObject({ cx: 115, cy: 95, rx: 40, ry: 20 });
  });

  it("右把手只改 rx，且不会缩成负数", () => {
    expect(dragWindow("e", ellipse, 10, 0)).toMatchObject({ rx: 50 });
    expect(dragWindow("e", ellipse, -100, 0)).toMatchObject({ rx: 2 });
  });
});

describe("拖动四边形（关键行为）", () => {
  it("拖左上角：只动这个角，另外三个角一个像素都不动", () => {
    const w = dragWindow("v0", quad, 10, 5) as typeof quad;
    expect(w.points[0]).toEqual({ x: 60, y: 65 });
    expect(w.points[1]).toEqual({ x: 150, y: 60 });
    expect(w.points[2]).toEqual({ x: 150, y: 100 });
    expect(w.points[3]).toEqual({ x: 50, y: 100 });
  });

  it("拖右下角同理（不会像矩形缩放那样带动邻边）", () => {
    const w = dragWindow("v2", quad, -20, 30) as typeof quad;
    expect(w.points[2]).toEqual({ x: 130, y: 130 });
    expect(w.points[0]).toEqual({ x: 50, y: 60 });
    expect(w.points[1]).toEqual({ x: 150, y: 60 });
    expect(w.points[3]).toEqual({ x: 50, y: 100 });
  });

  it("拖中心整体平移四个角", () => {
    const w = dragWindow("move", quad, 5, 5) as typeof quad;
    expect(w.points[0]).toEqual({ x: 55, y: 65 });
    expect(w.points[2]).toEqual({ x: 155, y: 105 });
  });

  it("四条边的羽化可以各不相同", () => {
    let w = quad;
    w = dragWindow("fe0", w, 0, -20) as typeof quad;
    expect(quadEdgeFeathers(w)[0]).toBe(30);
    expect(quadEdgeFeathers(w).slice(1)).toEqual([10, 10, 10]);
    w = dragWindow("fe1", w, 25, 0) as typeof quad;
    expect(quadEdgeFeathers(w)).toEqual([30, 35, 10, 10]);
    // 往内拖 → 减小，且不会小于 0
    w = dragWindow("fe1", w, -500, 0) as typeof quad;
    expect(quadEdgeFeathers(w)[1]).toBe(0);
  });

  it("没设 edges 时四条边都用统一羽化", () => {
    expect(quadEdgeFeathers({ ...quad, feather: 25 })).toEqual([25, 25, 25, 25]);
  });

  it("拖动不会抹掉反转标记", () => {
    const inverted: GradeWindow = { ...quad, invert: true };
    expect(dragWindow("v1", inverted, 5, 5)).toMatchObject({ invert: true });
  });
});

describe("拖动多边形", () => {
  it("只动被拖的顶点", () => {
    const w = dragWindow("v1", tri, -10, 10) as typeof tri;
    expect(w.points[0]).toEqual({ x: 0, y: 0 });
    expect(w.points[1]).toEqual({ x: 90, y: 10 });
    expect(w.points[2]).toEqual({ x: 50, y: 100 });
  });
});

describe("线性范围", () => {
  const line: GradeWindow = { kind: "line", x1: 0, y1: 100, x2: 200, y2: 100, feather: 20 };

  it("命中带子：线上的点算里，离得够远算外", () => {
    expect(windowHit(line, 100, 100)).toBe(true);
    expect(windowHit(line, 100, 110)).toBe(true);
    expect(windowHit(line, 100, 200)).toBe(false);
  });

  it("四个手柄：中点 + 两端 + 羽化", () => {
    const hs = windowHandles(line, 1);
    expect(hs.map((h) => h.id)).toEqual(["move", "a", "b", "feather"]);
    expect(hs[0].x).toBe(100);
  });

  it("拖端点只动那一端（等于拉长/转向）", () => {
    const w = dragWindow("b", line, 30, 0) as typeof line;
    expect(w.x1).toBe(0);
    expect(w.x2).toBe(230);
  });

  it("拖中点整体平移", () => {
    const w = dragWindow("move", line, 10, 5) as typeof line;
    expect(w).toMatchObject({ x1: 10, y1: 105, x2: 210, y2: 105 });
  });

  it("包围盒按线的轴向铺开，并含羽化", () => {
    expect(windowBounds(line)).toEqual({ x: -20, y: 80, w: 240, h: 40 });
  });
});

describe("旋转（椭圆）", () => {
  it("旋转手柄在形状上方", () => {
    const rot = windowHandles({ ...ellipse, rot: 0 }, 1).find((h) => h.id === "rotate");
    expect(rot).toBeTruthy();
    expect(rot!.y).toBeLessThan(ellipse.cy - 20);
  });

  it("拖旋转手柄会改角度，尺寸不变", () => {
    const w = dragWindow("rotate", ellipse, 60, 0) as typeof ellipse;
    expect(w.rx).toBe(40);
    expect(w.ry).toBe(20);
    expect(Math.abs(w.rot ?? 0)).toBeGreaterThan(0.1);
  });

  it("旋转 90° 后命中测试跟着转", () => {
    const rotated: GradeWindow = { ...ellipse, rot: Math.PI / 2 };
    expect(windowHit(ellipse, 100, 135)).toBe(false);
    expect(windowHit(rotated, 100, 135)).toBe(true);
    expect(windowHit(ellipse, 135, 100)).toBe(true);
    expect(windowHit(rotated, 135, 100)).toBe(false);
  });

  it("旋转后包围盒按投影扩大", () => {
    const b = windowBounds({ ...ellipse, rot: Math.PI / 2 });
    expect(Math.round(b.w)).toBe(60);
    expect(Math.round(b.h)).toBe(100);
  });
});

describe("四种形状都能建", () => {
  it("默认形状各自成形", () => {
    expect(defaultLine(800, 600).kind).toBe("line");
    expect(defaultEllipse(800, 600).kind).toBe("ellipse");
    expect(defaultQuad(800, 600).kind).toBe("quad");
    // 钢笔不再给预置五边形：从空点集开始，等用户自己点
    const poly = defaultPoly(800, 600);
    expect(poly.kind).toBe("poly");
    expect((poly as { points: unknown[] }).points).toHaveLength(0);
    // 空点集没有任何手柄（否则会算出 Infinity 坐标）
    expect(windowHandles(poly, 1)).toHaveLength(0);
  });

  it("除钢笔外每种形状都至少 4 个可拖手柄", () => {
    for (const w of [defaultLine(800, 600), defaultEllipse(800, 600), defaultQuad(800, 600)]) {
      expect(windowHandles(w, 1).length).toBeGreaterThanOrEqual(4);
    }
  });

  it("钢笔点了 3 个点后：3 个顶点 + 1 个羽化把手", () => {
    const poly: GradeWindow = {
      kind: "poly",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 80 },
      ],
      feather: 20,
    };
    expect(windowHandles(poly, 1).map((h) => h.id)).toEqual(["v0", "v1", "v2", "feather"]);
    expect(windowCenter(poly)).toMatchObject({ x: 50 });
  });

  it("未闭合的钢笔：点回起点即闭合（几何上就是连最靠近的那条边）", () => {
    // 闭合 = 最后一点连回第一点，命中测试按闭合多边形算
    const poly: GradeWindow = {
      kind: "poly",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      feather: 0,
    };
    expect(windowHit(poly, 50, 40)).toBe(true);
    expect(windowHit(poly, 20, 80)).toBe(false);
  });
});
