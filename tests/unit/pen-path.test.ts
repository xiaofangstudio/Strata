import { describe, expect, it } from "vitest";
import { penPressureWidth, samplePenPath } from "../../src/core/penPath";

describe("钢笔路径采样", () => {
  it("空路径 / 单点路径原样返回", () => {
    expect(samplePenPath([])).toEqual([]);
    expect(samplePenPath([{ x: 3, y: 7 }])).toEqual([{ x: 3, y: 7 }]);
  });

  it("直线路径采样后首尾仍精确落在落点上", () => {
    const pts = samplePenPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      4,
    );
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 0 });
    for (const p of pts) expect(p.y).toBeCloseTo(0, 6);
  });

  it("多点曲线穿过所有用户落点", () => {
    const anchors = [
      { x: 0, y: 0 },
      { x: 30, y: 40 },
      { x: 70, y: -10 },
      { x: 100, y: 20 },
    ];
    const pts = samplePenPath(anchors, 8);
    // 每段最后一个采样点就是该段落点
    for (let i = 0; i < anchors.length; i += 1) {
      const at = i === 0 ? 0 : i * 8;
      expect(pts[at].x).toBeCloseTo(anchors[i].x, 6);
      expect(pts[at].y).toBeCloseTo(anchors[i].y, 6);
    }
  });

  it("模拟压力两端收尖、中段最粗", () => {
    expect(penPressureWidth(0)).toBeCloseTo(0.22, 6);
    expect(penPressureWidth(1)).toBeCloseTo(0.22, 6);
    expect(penPressureWidth(0.5)).toBeCloseTo(1, 6);
    expect(penPressureWidth(0.1)).toBeLessThan(penPressureWidth(0.3));
  });
});
