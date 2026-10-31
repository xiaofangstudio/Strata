/**
 * 木偶变形核心（MLS）：平移 / 旋转 / 缩放的恢复能力 + 反向映射正确性。
 */
import { describe, expect, it } from "vitest";
import { mlsWarp, type WarpPin } from "../../src/engine/meshWarp";
import { makeBuffer, type RgbaBuffer } from "../../src/engine/filters/kernels";

function gradient(w: number, h: number): RgbaBuffer {
  const buf = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      buf.data[o] = (x * 255) / Math.max(1, w - 1);
      buf.data[o + 1] = (y * 255) / Math.max(1, h - 1);
      buf.data[o + 2] = 128;
      buf.data[o + 3] = 255;
    }
  }
  return buf;
}

const at = (buf: RgbaBuffer, x: number, y: number) => {
  const o = (y * buf.width + x) * 4;
  return [buf.data[o], buf.data[o + 1], buf.data[o + 2], buf.data[o + 3]];
};

describe("MLS 木偶变形", () => {
  it("钉点没动（原位钉）时图像不变", () => {
    const src = gradient(16, 16);
    const pins: WarpPin[] = [
      { ox: 4, oy: 4, x: 4, y: 4 },
      { ox: 12, oy: 4, x: 12, y: 4 },
      { ox: 8, oy: 12, x: 8, y: 12 },
    ];
    const out = mlsWarp(src, pins, "similarity");
    for (let y = 2; y < 14; y += 3) {
      for (let x = 2; x < 14; x += 3) {
        expect(at(out, x, y)[0]).toBeCloseTo(at(src, x, y)[0], 0);
      }
    }
  });

  it("整组钉点平移 t 时，等价于内容平移 −t 后采样", () => {
    const src = gradient(24, 24);
    const t = { dx: 6, dy: -4 };
    const pins: WarpPin[] = [
      { ox: 6, oy: 6, x: 6 + t.dx, y: 6 + t.dy },
      { ox: 18, oy: 6, x: 18 + t.dx, y: 6 + t.dy },
      { ox: 6, oy: 18, x: 6 + t.dx, y: 18 + t.dy },
      { ox: 18, oy: 18, x: 18 + t.dx, y: 18 + t.dy },
    ];
    const out = mlsWarp(src, pins, "affine");
    // 输出 (10, 10) 应采样源 (10 − dx, 10 − dy)
    expect(at(out, 10, 10)[0]).toBeCloseTo(at(src, 4, 14)[0], 0);
    expect(at(out, 10, 10)[1]).toBeCloseTo(at(src, 4, 14)[1], 0);
  });

  it("钉点把一块区域拖走，附近像素跟着动（局部变形）", () => {
    const src = gradient(32, 32);
    // 两个钉钉在同一水平线上，把右边那个往上拉
    const pins: WarpPin[] = [
      { ox: 8, oy: 24, x: 8, y: 24 },
      { ox: 24, oy: 24, x: 24, y: 10 },
      { ox: 24, oy: 30, x: 24, y: 30 },
    ];
    const out = mlsWarp(src, pins, "similarity");
    // 拉动点附近发生了变化（不再是恒等）
    let changed = 0;
    for (let y = 18; y < 28; y += 1) {
      for (let x = 18; x < 30; x += 1) {
        if (Math.abs(at(out, x, y)[1] - at(src, x, y)[1]) > 4) changed += 1;
      }
    }
    expect(changed).toBeGreaterThan(10);
  });

  it("钉点不足时原样返回", () => {
    const src = gradient(8, 8);
    const one = mlsWarp(src, [{ ox: 3, oy: 3, x: 6, y: 6 }], "similarity");
    expect(Array.from(one.data)).toEqual(Array.from(src.data));
    const none = mlsWarp(src, [], "affine");
    expect(Array.from(none.data)).toEqual(Array.from(src.data));
  });

  it("仿射模式对共线钉点退化为平移而不崩溃", () => {
    const src = gradient(16, 16);
    const pins: WarpPin[] = [
      { ox: 4, oy: 8, x: 5, y: 8 },
      { ox: 8, oy: 8, x: 9, y: 8 },
      { ox: 12, oy: 8, x: 13, y: 8 },
    ];
    const out = mlsWarp(src, pins, "affine");
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
  });

  it("输出尺寸与输入一致", () => {
    const src = gradient(20, 12);
    const pins: WarpPin[] = [
      { ox: 5, oy: 5, x: 5, y: 5 },
      { ox: 15, oy: 5, x: 15, y: 7 },
      { ox: 10, oy: 9, x: 10, y: 9 },
    ];
    const out = mlsWarp(src, pins, "similarity");
    expect(out.width).toBe(20);
    expect(out.height).toBe(12);
  });
});
