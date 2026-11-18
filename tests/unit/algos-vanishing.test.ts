/**
 * 消失点几何测试：消失点交点、焦距反解、平面有效性、单位方形单应、3D 抬升往返。
 */
import { describe, expect, it } from "vitest";
import {
  meet,
  vanishingPoints,
  planeFocal,
  checkPlane,
  homographyFromUnitSquare,
  applyPlaneH,
  liftPlane,
  projectLifted,
  liftedLengths,
  normalizePlane,
  type VpPlane,
} from "../../src/engine/algos/vanishing";

const plane = (q: [number, number][]): VpPlane => ({
  corners: [q[0], q[1], q[2], q[3]] as VpPlane["corners"],
});

describe("消失点与焦距", () => {
  it("meet：平行线交于无穷远（第三分量≈0）", () => {
    const v = meet([0, 0], [10, 0], [0, 5], [10, 5]);
    expect(Math.abs(v[2])).toBeLessThan(1e-9);
  });

  it("meet：相交线求交点", () => {
    const v = meet([0, 0], [10, 10], [0, 10], [10, 0]);
    expect(v[0] / v[2]).toBeCloseTo(5, 6);
    expect(v[1] / v[2]).toBeCloseTo(5, 6);
  });

  it("矩形平面两个消失点都在无穷远 → 无有限焦距", () => {
    const p = plane([[100, 100], [300, 100], [300, 200], [100, 200]]);
    expect(planeFocal(p, [200, 150])).toBeNull();
  });

  it("从已知焦距的透视平面能精确反解回焦距", () => {
    // 相机 f=400，把平面绕 X/Y 双轴倾斜后投影到图像（两组对边都有有限消失点）。
    // 单轴倾斜时一组对边仍平行于像面、消失点在无穷远，物理上解不出焦距。
    const f = 400, cx = 320, cy = 240;
    const ax = 0.30, ay = -0.25;
    const proj = (X: number, Y: number): [number, number] => {
      const x3 = X * Math.cos(ay) + 1000 * Math.sin(ay);
      const z1 = 1000 * Math.cos(ay) - X * Math.sin(ay);
      const y3 = Y * Math.cos(ax) - z1 * Math.sin(ax);
      const z2 = Y * Math.sin(ax) + z1 * Math.cos(ax);
      return [cx + f * x3 / z2, cy + f * y3 / z2];
    };
    const p = plane([
      proj(-300, -200), proj(300, -200),
      proj(300, 200), proj(-300, 200),
    ]);
    const est = planeFocal(p, [cx, cy]);
    expect(est).not.toBeNull();
    expect(est!).toBeCloseTo(f, 4);
  });
});

describe("平面有效性", () => {
  it("矩形有效", () => {
    const p = plane([[100, 100], [300, 100], [300, 200], [100, 200]]);
    expect(checkPlane(p, [200, 150])).toBe("valid");
  });

  it("自交四边形无效", () => {
    const p = plane([[0, 0], [100, 100], [100, 0], [0, 100]]);
    expect(checkPlane(p, [50, 50])).toBe("invalid");
  });

  it("角太尖 → 存疑或无效，但不会判有效", () => {
    const p = plane([[100, 100], [300, 100], [301, 101], [100, 200]]);
    expect(checkPlane(p, [200, 150])).not.toBe("valid");
  });

  it("乱序四角能归一到左上起顺时针", () => {
    // 从右下开始逆时针给矩形
    const p = plane([[300, 200], [100, 200], [100, 100], [300, 100]]);
    const n = normalizePlane(p);
    expect(n.corners[0]).toEqual([100, 100]);
    expect(checkPlane(n, [200, 150])).toBe("valid");
  });
});

describe("单位方形单应", () => {
  it("矩形四角：单应把 (0,0)(1,0)(1,1)(0,1) 分别映射过去", () => {
    const q: [number, number][] = [[120, 80], [420, 90], [410, 290], [110, 280]];
    const h = homographyFromUnitSquare(plane(q))!;
    expect(h).toHaveLength(9);
    for (let i = 0; i < 4; i += 1) {
      const [x, y] = [[0, 0], [1, 0], [1, 1], [0, 1]][i];
      const [u, v] = applyPlaneH(h, x, y);
      expect(u).toBeCloseTo(q[i][0], 4);
      expect(v).toBeCloseTo(q[i][1], 4);
    }
  });

  it("退化平面（三点共线）返回 null", () => {
    const p = plane([[0, 0], [10, 0], [20, 0], [30, 0]]);
    expect(homographyFromUnitSquare(p)).toBeNull();
  });
});

describe("3D 抬升与投影", () => {
  it("四角投影回图像与原四角一致（往返）", () => {
    const q: [number, number][] = [[120, 80], [420, 90], [410, 290], [110, 280]];
    const p = plane(q);
    const center: [number, number] = [265, 185];
    const focal = planeFocal(p, center) ?? 800;
    const l = liftPlane(p, focal, center);
    for (let i = 0; i < 4; i += 1) {
      const back = projectLifted(l, l.pts[i])!;
      expect(back[0]).toBeCloseTo(q[i][0], 4);
      expect(back[1]).toBeCloseTo(q[i][1], 4);
    }
  });

  it("矩形平面抬升后 u/v 边长与图像边长同量级", () => {
    const p = plane([[100, 100], [300, 100], [300, 200], [100, 200]]);
    const l = liftPlane(p, 800, [200, 150]);
    const [u, v] = liftedLengths(l);
    expect(u).toBeGreaterThan(0);
    expect(v).toBeGreaterThan(0);
    expect(u).toBeGreaterThan(v); // 宽边 > 高边
  });
});
