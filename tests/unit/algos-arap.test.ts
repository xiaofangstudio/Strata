/**
 * P2-B：ARAP 木偶变形回归测试。
 */
import { describe, expect, it } from "vitest";
import { arapWarp, solveArapMesh } from "../../src/engine/algos/arap";
import { makeBuffer } from "../../src/engine/filters/kernels";
import type { WarpPin } from "../../src/engine/meshWarp";

function gradient(w: number, h: number) {
  const img = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      img.data[p] = Math.round((x / (w - 1)) * 255);
      img.data[p + 1] = Math.round((y / (h - 1)) * 255);
      img.data[p + 2] = 128;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

const pin = (ox: number, oy: number, x: number, y: number): WarpPin => ({ ox, oy, x, y });

describe("ARAP 网格求解", () => {
  it("钉点数不足返回 null", () => {
    expect(solveArapMesh(32, 32, [pin(4, 4, 4, 4), pin(28, 28, 28, 28)])).toBeNull();
  });

  it("静止钉点保持网格不变", () => {
    // cell=8 时网格步长 31/4=7.75，钉点落在真实网格节点上才是恒等
    const pins = [pin(0, 0, 0, 0), pin(31, 0, 31, 0), pin(15.5, 31, 15.5, 31)];
    const mesh = solveArapMesh(32, 32, pins, { cell: 8, iterations: 10 })!;
    for (let i = 0; i < mesh.rest.length; i += 1) {
      expect(mesh.solved[i]).toBeCloseTo(mesh.rest[i], 4);
    }
  });

  it("移动钉点确实约束到目标位置", () => {
    const pins = [pin(0, 0, 6, 0), pin(31, 0, 31, 0), pin(15.5, 31, 15.5, 31)];
    const mesh = solveArapMesh(32, 32, pins, { cell: 8, iterations: 20 })!;
    const cols = mesh.cols;
    const nearest = (px: number, py: number) => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < mesh.rest.length / 2; i += 1) {
        const d = Math.hypot(mesh.rest[i * 2] - px, mesh.rest[i * 2 + 1] - py);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    void cols;
    const i = nearest(0, 0);
    expect(mesh.solved[i * 2]).toBeCloseTo(6, 3);
    expect(mesh.solved[i * 2 + 1]).toBeCloseTo(0, 3);
  });
});

describe("ARAP 变形", () => {
  it("钉点不足时原样返回", () => {
    const src = gradient(32, 32);
    const out = arapWarp(src, [pin(4, 4, 8, 8)], { cell: 8, iterations: 5 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("静止钉点近似恒等", () => {
    const src = gradient(32, 32);
    const pins = [pin(0, 0, 0, 0), pin(31, 0, 31, 0), pin(15.5, 31, 15.5, 31)];
    const out = arapWarp(src, pins, { cell: 8, iterations: 10 });
    let maxDiff = 0;
    for (let i = 0; i < src.data.length; i += 4) {
      maxDiff = Math.max(maxDiff, Math.abs(out.data[i] - src.data[i]));
    }
    expect(maxDiff).toBeLessThanOrEqual(2);
  });

  it("整体平移钉点会把纹理搬到对应位置", () => {
    const src = gradient(64, 64);
    const pins = [pin(10.5, 10.5, 22.5, 10.5), pin(52.5, 10.5, 64.5, 10.5), pin(31.5, 52.5, 43.5, 52.5)];
    const out = arapWarp(src, pins, { cell: 12, iterations: 30 });
    // 输出 (40,32) 应来自原图约 (28,32)
    const got = out.data[(32 * 64 + 40) * 4];
    const want = src.data[(32 * 64 + 28) * 4];
    expect(Math.abs(got - want)).toBeLessThan(30);
  });
});
