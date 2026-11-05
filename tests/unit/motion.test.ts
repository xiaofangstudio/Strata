/**
 * 动效数学原语测试（纯函数，不碰浏览器 API —— 项目约定）。
 */
import { describe, it, expect } from "vitest";
import {
  EASING,
  clamp,
  lerp,
  createTween,
  zoomSteps,
  ZOOM_NOTCH,
  startZoom,
  stepZoom,
  flickFromSamples,
  stepFlick,
  FLICK_TAU,
  FLICK_MIN_SPEED,
  pinchMetrics,
  pinchDelta,
  normalizeAngle,
  stepHandleAnim,
  HANDLE_ANIM_INIT,
  handleRadius,
} from "../../src/engine/motion";

describe("缓动与补间", () => {
  it("所有缓动曲线两端严格为 0 / 1", () => {
    for (const [name, fn] of Object.entries(EASING)) {
      expect(fn(0), `${name}(0)`).toBeCloseTo(0, 6);
      expect(fn(1), `${name}(1)`).toBeCloseTo(1, 6);
    }
  });

  it("clamp / lerp 边界", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(12, 0, 10)).toBe(10);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });

  it("createTween 起点、中点、终点单调且落在区间内", () => {
    const tw = createTween(10, 20, 100, EASING.outCubic);
    expect(tw.sample(0)).toBe(10);
    expect(tw.sample(50)).toBeGreaterThan(10);
    expect(tw.sample(50)).toBeLessThan(20);
    expect(tw.sample(100)).toBe(20);
    expect(tw.sample(999)).toBe(20); // 越过终点仍夹住
    expect(tw.done(99)).toBe(false);
    expect(tw.done(100)).toBe(true);
  });

  it("duration=0 时瞬时收敛（动效关闭）", () => {
    const tw = createTween(1, 9, 0);
    expect(tw.sample(0)).toBe(9);
    expect(tw.done(0)).toBe(true);
  });

  it("outBack 会过冲但终点仍为 1", () => {
    expect(EASING.outBack(0.6)).toBeGreaterThan(1);
    expect(EASING.outBack(1)).toBeCloseTo(1, 6);
  });
});

describe("画布缩放", () => {
  it("zoomSteps 按 ×1.1 幂次，正负对称", () => {
    expect(zoomSteps(1, 1)).toBeCloseTo(ZOOM_NOTCH, 6);
    expect(zoomSteps(1, 2)).toBeCloseTo(1.21, 6);
    expect(zoomSteps(1, -1)).toBeCloseTo(1 / 1.1, 6);
    expect(zoomSteps(1, 0)).toBe(1);
  });

  it("stepZoom 逐帧插值并最终到达目标", () => {
    let a = startZoom(1, 2, 100);
    let scale = 1;
    let done = false;
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = stepZoom(a, 10);
      a = r.anim;
      scale = r.scale;
      done = r.done;
      seen.push(scale);
    }
    expect(done).toBe(true);
    expect(scale).toBeCloseTo(2, 6);
    for (let i = 1; i < 8; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it("duration=0 时一步到位（off 档不会卡在中间）", () => {
    const r = stepZoom(startZoom(1, 4, 0), 16);
    expect(r.scale).toBe(4);
    expect(r.done).toBe(true);
  });
});

describe("惯性平移 flick pan", () => {
  it("样本不足 / 太慢都不启动", () => {
    expect(flickFromSamples([{ x: 0, y: 0, t: 0 }])).toEqual({ vx: 0, vy: 0 });
    const slow = flickFromSamples([
      { x: 0, y: 0, t: 0 },
      { x: 1, y: 0, t: 80 },
    ]);
    expect(slow).toEqual({ vx: 0, vy: 0 });
  });

  it("从轨迹估计速度并夹到上限", () => {
    const v = flickFromSamples([
      { x: 0, y: 0, t: 0 },
      { x: 40, y: 30, t: 50 },
    ]);
    expect(v.vx).toBeCloseTo(800, 0);
    expect(v.vy).toBeCloseTo(600, 0);
    const huge = flickFromSamples([
      { x: 0, y: 0, t: 0 },
      { x: 100000, y: 0, t: 16 },
    ]);
    expect(Math.hypot(huge.vx, huge.vy)).toBeLessThanOrEqual(6000.001);
  });

  it("指数衰减：位移单调递减、速度最终低于停止阈值", () => {
    let s = { vx: 1200, vy: 0 };
    const displacements: number[] = [];
    let done = false;
    for (let i = 0; i < 200; i++) {
      const r = stepFlick(s, 1 / 60, FLICK_TAU);
      s = r.next;
      displacements.push(r.dx);
      if (r.done) {
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThan(FLICK_MIN_SPEED);
    for (let i = 1; i < 5; i++) expect(displacements[i]).toBeLessThan(displacements[i - 1]);
  });

  it("总滑行距离收敛于 v*TAU（指数积分有界）", () => {
    let s = { vx: 1000, vy: 0 };
    let total = 0;
    for (let i = 0; i < 500; i++) {
      const r = stepFlick(s, 1 / 120, FLICK_TAU);
      total += r.dx;
      s = r.next;
      if (r.done) break;
    }
    expect(total).toBeGreaterThan(100);
    expect(total).toBeLessThan(1000 * FLICK_TAU + 1);
  });
});

describe("双指手势 pinch / rotate", () => {
  it("pinchMetrics 算距离、角度与中心", () => {
    const m = pinchMetrics({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(m.distance).toBe(5);
    expect(m.angleDeg).toBeCloseTo(53.13, 1);
    expect(m.centerX).toBe(1.5);
    expect(m.centerY).toBe(2);
  });

  it("两指拉开 → scale>1，靠拢 → scale<1", () => {
    const a = pinchMetrics({ x: 0, y: 0 }, { x: 100, y: 0 });
    const b = pinchMetrics({ x: 0, y: 0 }, { x: 200, y: 0 });
    expect(pinchDelta(a, b).scale).toBeCloseTo(2, 6);
    expect(pinchDelta(b, a).scale).toBeCloseTo(0.5, 6);
  });

  it("旋转角跨 ±180° 归一，不跳整圈", () => {
    expect(normalizeAngle(190)).toBeCloseTo(-170, 6);
    expect(normalizeAngle(-190)).toBeCloseTo(170, 6);
    expect(normalizeAngle(360)).toBe(0);
    // 179° → -179° 实际只转了 +2°，不能算成 -358°
    const at = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return pinchMetrics({ x: 0, y: 0 }, { x: Math.cos(r) * 100, y: Math.sin(r) * 100 });
    };
    expect(pinchDelta(at(179), at(-179)).rotationDeg).toBeCloseTo(2, 1);
    expect(pinchDelta(at(-179), at(179)).rotationDeg).toBeCloseTo(-2, 1);
  });

  it("双指中心平移量正确传出", () => {
    const a = pinchMetrics({ x: 0, y: 0 }, { x: 100, y: 0 });
    const b = pinchMetrics({ x: 10, y: 20 }, { x: 110, y: 20 });
    const d = pinchDelta(a, b);
    expect(d.dx).toBe(10);
    expect(d.dy).toBe(20);
    expect(d.scale).toBeCloseTo(1, 6);
  });
});

describe("变换手柄 / 图钉反馈", () => {
  it("appear 从 0 平滑长到 1，hover 放大、抓取收缩", () => {
    let a = HANDLE_ANIM_INIT;
    for (let i = 0; i < 300; i++) {
      a = stepHandleAnim(a, { visible: true, hovered: true, dragging: false }, 16);
    }
    expect(a.appear).toBeCloseTo(1, 3);
    expect(a.hover).toBeCloseTo(1, 3);
    const plain = handleRadius(6, { appear: 1, hover: 0, grab: 0 });
    const hovered = handleRadius(6, a);
    expect(hovered).toBeGreaterThan(plain);
    const grabbed = handleRadius(6, { appear: 1, hover: 1, grab: 1 });
    expect(grabbed).toBeLessThan(hovered);
  });

  it("隐藏时手柄半径收敛到 0", () => {
    let a = { appear: 1, hover: 1, grab: 1 };
    for (let i = 0; i < 400; i++) {
      a = stepHandleAnim(a, { visible: false, hovered: false, dragging: false }, 16);
    }
    expect(handleRadius(6, a)).toBeLessThan(0.01);
  });

  it("动效关闭时一步到位，不留中间态", () => {
    const a = stepHandleAnim(
      HANDLE_ANIM_INIT,
      { visible: true, hovered: true, dragging: true },
      16,
      false,
    );
    expect(a).toEqual({ appear: 1, hover: 1, grab: 1 });
  });
});
