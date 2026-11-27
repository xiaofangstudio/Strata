/**
 * 特征图层对齐测试：验证降采样后的相似变换估计方向与量级，
 * 以及单应矩阵 → canvas 矩阵的参数顺序（落版方向）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateFeatureTransform, applySimilarityToLayer } from "../../src/core/featureAlign";
import { hInverse, hApply, type Homography } from "../../src/engine/algos/features";
import { makeBuffer, type RgbaBuffer } from "../../src/engine/filters/kernels";
import type { StrataLayer } from "../../src/core/layer";
import { installDomStub, StubCanvas, type DomStub } from "../helpers/canvas";

let dom: DomStub;
beforeAll(() => { dom = installDomStub(); });
afterAll(() => { dom.restore(); });

let seed = 1234;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };

/** 纹理图（用 RGBA 字节）。 */
function textureRGBA(w: number, h: number): RgbaBuffer {
  seed = 42;
  const img = makeBuffer(w, h);
  for (let p = 0; p < w * h; p += 1) {
    const v = Math.round(0.3 * 255);
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v;
    img.data[p * 4 + 3] = 255;
  }
  for (let k = 0; k < 90; k += 1) {
    const cx = rnd() * w, cy = rnd() * h, r = 4 + rnd() * 10;
    const val = Math.round((0.4 + rnd() * 0.5) * 255);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) {
          const i = (y * w + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = val;
        }
      }
    }
  }
  return img;
}

/** 按单应矩阵把 RGBA 重采样成新图（目标→源反查）。 */
function warpRGBA(img: RgbaBuffer, inv: Homography): RgbaBuffer {
  const w = img.width, h = img.height;
  const out = makeBuffer(w, h);
  out.data.set(img.data);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [sx, sy] = hApply(inv, x, y);
      if (!Number.isFinite(sx) || sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const tx = sx - x0, ty = sy - y0;
      const at = (xx: number, yy: number, c: number) => img.data[(yy * w + xx) * 4 + c];
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const top = at(x0, y0, c) + (at(x0 + 1, y0, c) - at(x0, y0, c)) * tx;
        const bot = at(x0, y0 + 1, c) + (at(x0 + 1, y0 + 1, c) - at(x0, y0 + 1, c)) * tx;
        out.data[o + c] = top + (bot - top) * ty;
      }
    }
  }
  return out;
}

describe("estimateFeatureTransform", () => {
  it("尺寸不一致返回 null", () => {
    expect(estimateFeatureTransform(makeBuffer(100, 100), makeBuffer(80, 100))).toBeNull();
  });

  // 200×200 纯色图仍要走完整的 Harris / BRIEF 扫描；全量并行跑时给足超时，
  // 之前 5s 默认超时在满载机器上偶发误报，单跑其实只要 2–3s。
  it("纯色图（无角点）返回 null", () => {
    expect(estimateFeatureTransform(makeBuffer(200, 200), makeBuffer(200, 200))).toBeNull();
  }, 20000);

  it("平移图能估计出正确平移（原图像素尺度）", () => {
    const w = 320, h = 260;
    const ref = textureRGBA(w, h);
    const shift: Homography = [1, 0, 12, 0, 1, -8, 0, 0, 1];
    const moving = warpRGBA(ref, hInverse(shift)!);
    const res = estimateFeatureTransform(ref, moving);
    expect(res).not.toBeNull();
    expect(res!.inliers).toBeGreaterThanOrEqual(6);
    // res.h 把 moving 映回 ref：moving 是 ref 平移 (12,-8)，故校正应为 (-12, +8)
    const [x, y] = hApply(res!.h, 100, 100);
    expect(x).toBeCloseTo(88, 0);
    expect(y).toBeCloseTo(108, 0);
  }, 20000);

  it("旋转+缩放图估计出的变换能把点拉回原位", () => {
    const w = 320, h = 260;
    const ref = textureRGBA(w, h);
    const ang = 5 * Math.PI / 180;
    const c = Math.cos(ang) * 1.04;
    const s = Math.sin(ang) * 1.04;
    const cx = w / 2, cy = h / 2;
    const sim: Homography = [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1];
    const moving = warpRGBA(ref, hInverse(sim)!);
    const res = estimateFeatureTransform(ref, moving);
    expect(res).not.toBeNull();
    for (const p of [[80, 70], [220, 180]] as [number, number][]) {
      const [mx, my] = hApply(sim, p[0], p[1]); // moving 里 p 内容所在位置
      const [bx, by] = hApply(res!.h, mx, my); // 校正后应回到 p
      expect(Math.abs(bx - p[0])).toBeLessThan(3);
      expect(Math.abs(by - p[1])).toBeLessThan(3);
    }
  }, 20000);
});

describe("applySimilarityToLayer 落版方向", () => {
  it("canvas transform 的参数顺序与 hApply 逐点一致（旋转方向不镜像）", () => {
    // 90° 旋转 + 平移，旋转方向可辨：hApply(h,10,0)=(10,30)，hApply(h,0,5)=(-5,20)
    const h: Homography = [0, -1, 10, 1, 0, 20, 0, 0, 1];
    const layer = { surface: new StubCanvas(50, 40) } as unknown as StrataLayer;
    const out = applySimilarityToLayer(layer, h, 60, 50);
    const stub = out as unknown as StubCanvas;
    const calls = stub.__ctx?.transformCalls ?? [];
    expect(calls).toHaveLength(1);
    const [m11, m12, m21, m22, dx, dy] = calls[0];
    // canvas 语义：x' = m11·x + m21·y + dx；y' = m12·x + m22·y + dy
    for (const [x, y] of [[10, 0], [0, 5], [7, 3]] as [number, number][]) {
      const [px, py] = hApply(h, x, y);
      expect(m11 * x + m21 * y + dx).toBeCloseTo(px, 6);
      expect(m12 * x + m22 * y + dy).toBeCloseTo(py, 6);
    }
  });
});
