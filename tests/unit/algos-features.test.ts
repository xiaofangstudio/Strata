/**
 * 图像配准纯函数测试（移植自 PhotoCraft features.rs 测试口径）。
 * 覆盖：Harris 角点、BRIEF 确定性、汉明距离、匹配、fit 精确性、RANSAC 抗外点、register 端到端。
 */
import { describe, expect, it } from "vitest";
import {
  harris, describe as describeBrief, hamming, matchDescriptors,
  fit, ransac, register, boxBlur, hApply, hInverse, hMul,
  lumaPlane, IDENTITY,
  type Corner, type Desc, type Pt2, type Homography, type RegModel,
} from "../../src/engine/algos/features";
import { makeBuffer } from "../../src/engine/filters/kernels";

/** 确定性纹理图（用简单 LCG，避免依赖实现内部的 RNG）。 */
function texture(w: number, h: number, seed = 42): Float32Array {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  const img = new Float32Array(w * h).fill(0.3);
  for (let k = 0; k < 140; k += 1) {
    const cx = rnd() * w;
    const cy = rnd() * h;
    const r = 3 + rnd() * 9;
    const v = rnd();
    const sq = rnd() > 0.5;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        const inside = sq ? (Math.abs(dx) < r && Math.abs(dy) < r * 0.6) : Math.hypot(dx, dy) < r;
        if (inside) img[y * w + x] = v;
      }
    }
  }
  return img;
}

/** 按单应矩阵重采样（目标→源反查，双线性，边缘夹取）。 */
function warp(w: number, h: number, img: Float32Array, inv: Homography): Float32Array {
  const out = new Float32Array(w * h).fill(0.3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [sx, sy] = hApply(inv, x, y);
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const tx = sx - x0, ty = sy - y0;
      const p = (xx: number, yy: number) => img[yy * w + xx];
      const top = p(x0, y0) + (p(x0 + 1, y0) - p(x0, y0)) * tx;
      const bot = p(x0, y0 + 1) + (p(x0 + 1, y0 + 1) - p(x0, y0 + 1)) * tx;
      out[y * w + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

describe("homography 矩阵", () => {
  it("apply / inverse / mul 自洽", () => {
    const m: Homography = [1.1, 0.05, 3, -0.02, 0.95, -2, 0.001, 0.0005, 1];
    const inv = hInverse(m)!;
    expect(inv).not.toBeNull();
    const composed = hMul(m, inv);
    for (const [x, y] of [[0, 0], [12, 34], [-5, 7]] as Pt2[]) {
      const [px, py] = hApply(composed, x, y);
      expect(px).toBeCloseTo(x, 6);
      expect(py).toBeCloseTo(y, 6);
    }
    const [ix, iy] = hApply(IDENTITY, 7, 9);
    expect(ix).toBe(7);
    expect(iy).toBe(9);
  });
});

describe("boxBlur", () => {
  it("常数图模糊后仍是常数", () => {
    const out = boxBlur(16, 16, new Float32Array(256).fill(0.7), 2);
    for (const v of out) expect(v).toBeCloseTo(0.7, 5);
  });
});

describe("harris", () => {
  it("能找到方块的角点", () => {
    const w = 80, h = 80;
    const img = new Float32Array(w * h);
    for (let y = 30; y < 50; y += 1) for (let x = 30; x < 50; x += 1) img[y * w + x] = 1;
    const c = harris(w, h, img, 10, 5);
    expect(c.length).toBeGreaterThanOrEqual(4);
    for (const [x, y] of [[30, 30], [49, 49]] as Pt2[]) {
      expect(c.some((k) => Math.abs(k.x - x) <= 2 && Math.abs(k.y - y) <= 2)).toBe(true);
    }
  });

  it("纯色图没有角点", () => {
    expect(harris(64, 64, new Float32Array(64 * 64).fill(0.5), 20, 5)).toEqual([]);
  });
});

describe("BRIEF 描述子", () => {
  it("确定性：同图同角点两次描述一致", () => {
    const w = 96, h = 96;
    const img = texture(w, h);
    const c = harris(w, h, img, 50, 6);
    expect(describeBrief(w, h, img, c, false)).toEqual(describeBrief(w, h, img, c, false));
  });

  it("汉明距离按位统计", () => {
    const zero: Desc = [0, 0, 0, 0, 0, 0, 0, 0];
    const one: Desc = [1, 3, 0, 0, 0, 0, 0, 0xffffffff];
    // popcount(1)=1, popcount(3)=2, popcount(0xffffffff)=32 → 35
    expect(hamming(zero, one)).toBe(35);
    expect(hamming(zero, zero)).toBe(0);
  });

  it("匹配：相似描述子能配上，ratio test 挡掉歧义", () => {
    const a: Desc[] = [[1, 2, 3, 4, 5, 6, 7, 8], [100, 200, 300, 400, 500, 600, 700, 800]];
    const b: Desc[] = [[1, 2, 3, 4, 5, 6, 7, 9], [100, 200, 300, 400, 500, 600, 700, 802]];
    const m = matchDescriptors(a, b, 0.85);
    expect(m).toContainEqual([0, 0]);
    expect(m).toContainEqual([1, 1]);
  });
});

describe("fit", () => {
  const src: Pt2[] = [[0, 0], [10, 0], [10, 10], [0, 10], [5, 3]];

  it("单应在干净数据上精确", () => {
    const truth: Homography = [1.1, 0.05, 3, -0.02, 0.95, -2, 0.001, 0.0005, 1];
    const dst = src.map((p) => hApply(truth, p[0], p[1]));
    const hm = fit("homography", src, dst)!;
    expect(hm).not.toBeNull();
    for (let i = 0; i < src.length; i += 1) {
      const [x, y] = hApply(hm, src[i][0], src[i][1]);
      expect(x).toBeCloseTo(dst[i][0], 5);
      expect(y).toBeCloseTo(dst[i][1], 5);
    }
  });

  it("相似变换精确恢复", () => {
    const truth: Homography = [0.9, -0.2, 4, 0.2, 0.9, 1, 0, 0, 1];
    const dst = src.map((p) => hApply(truth, p[0], p[1]));
    const hm = fit("similarity", src, dst)!;
    for (let i = 0; i < 9; i += 1) expect(hm[i]).toBeCloseTo(truth[i], 6);
  });

  it("平移用最小集合也能拟合", () => {
    const dst = src.map(([x, y]) => [x + 12, y - 5] as Pt2);
    const hm = fit("translation", src, dst)!;
    expect(hm[2]).toBeCloseTo(12, 6);
    expect(hm[5]).toBeCloseTo(-5, 6);
  });
});

describe("ransac", () => {
  it("抗外点：30 个真平移 + 10 个乱点，恢复真平移", () => {
    const s: Pt2[] = [];
    const d: Pt2[] = [];
    for (let i = 0; i < 40; i += 1) {
      const p: Pt2 = [(i * 7) % 50, (i * 13) % 50];
      s.push(p);
      d.push(i % 4 === 0 ? [p[0] * 3 + 40, -p[1]] : [p[0] + 12, p[1] - 5]);
    }
    const res = ransac("translation", s, d, 100, 1, 1)!;
    expect(res).not.toBeNull();
    expect(res.inliers.length).toBe(30);
    expect(res.model[2]).toBeCloseTo(12, 6);
    expect(res.model[5]).toBeCloseTo(-5, 6);
  });
});

describe("register 端到端", () => {
  it("平移图能配准回来（move→reference）", () => {
    const w = 192, h = 160;
    const ref = texture(w, h);
    const shift: Homography = [1, 0, 9, 0, 1, -6, 0, 0, 1];
    const moving = warp(w, h, ref, hInverse(shift)!);
    const res = register(w, h, ref, moving, "translation");
    expect(res).not.toBeNull();
    expect(res!.inliers).toBeGreaterThanOrEqual(6);
    expect(Math.abs(res!.model[2] + 9)).toBeLessThan(1);
    expect(Math.abs(res!.model[5] - 6)).toBeLessThan(1);
  });

  it("相似变换（旋转 4° + 缩放 1.03）能配准", () => {
    const w = 192, h = 160;
    const ref = texture(w, h);
    const c = Math.cos(4 * Math.PI / 180) * 1.03;
    const s = Math.sin(4 * Math.PI / 180) * 1.03;
    const cx = w / 2, cy = h / 2;
    const sim: Homography = [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1];
    const moving = warp(w, h, ref, hInverse(sim)!);
    const res = register(w, h, ref, moving, "similarity");
    expect(res).not.toBeNull();
    // res.model 应抵消 sim：m(sim(p)) ≈ p
    for (const p of [[40, 40], [150, 120], [96, 80]] as Pt2[]) {
      const [x, y] = hApply(sim, p[0], p[1]);
      const [bx, by] = hApply(res!.model, x, y);
      expect(Math.abs(bx - p[0])).toBeLessThan(2);
      expect(Math.abs(by - p[1])).toBeLessThan(2);
    }
  });

  it("lumaPlane 从 RGBA 取 0..1 亮度", () => {
    const img = makeBuffer(2, 2);
    for (let i = 0; i < 4; i += 1) {
      img.data[i * 4] = 255; img.data[i * 4 + 1] = 0; img.data[i * 4 + 2] = 0; img.data[i * 4 + 3] = 255;
    }
    const p = lumaPlane(img);
    expect(p).toHaveLength(4);
    expect(p[0]).toBeCloseTo(0.299, 3);
  });
});
