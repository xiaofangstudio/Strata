/**
 * 扫描裁剪 / 裁正照片纯函数测试（移植自 PhotoCraft scancrop.rs 测试口径）。
 * 覆盖：Otsu、形态学、凸包、最小外接矩形、旋转照片检测与阅读顺序。
 */
import { describe, expect, it } from "vitest";
import {
  otsu,
  morph,
  convexHull,
  minRect,
  photoCorners,
  findPhotos,
  type FoundPhoto,
} from "../../src/engine/algos/scancrop";
import { makeBuffer, type RgbaBuffer } from "../../src/engine/filters/kernels";

/** 白底扫描图 + 若干旋转的纹理照片（0..255 RGBA）。 */
function scan(w: number, h: number, photos: FoundPhoto[]): RgbaBuffer {
  const img = makeBuffer(w, h);
  const bg = [247, 247, 245];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      img.data[i] = bg[0]; img.data[i + 1] = bg[1]; img.data[i + 2] = bg[2]; img.data[i + 3] = 255;
    }
  }
  for (const p of photos) {
    const s = Math.sin(p.angle * Math.PI / 180);
    const c = Math.cos(p.angle * Math.PI / 180);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = x + 0.5 - p.center[0];
        const dy = y + 0.5 - p.center[1];
        const u = c * dx + s * dy;
        const v = -s * dx + c * dy;
        if (Math.abs(u) < p.width / 2 && Math.abs(v) < p.height / 2) {
          const i = (y * w + x) * 4;
          const t = Math.sin(u * 0.05) * Math.cos(v * 0.07);
          img.data[i] = Math.round(255 * (0.3 + 0.2 * t));
          img.data[i + 1] = Math.round(255 * 0.2);
          img.data[i + 2] = Math.round(255 * (0.5 - 0.2 * t));
        }
      }
    }
  }
  return img;
}

const photo = (cx: number, cy: number, w: number, h: number, angle: number): FoundPhoto => ({
  center: [cx, cy], width: w, height: h, angle, area: 0, corners: [],
});

describe("otsu", () => {
  it("双峰直方图阈值能正确切分两类样本", () => {
    // 标准 Otsu 在两峰间一片 bin 方差相同，取第一次达到最大值的 bin，
    // 阈值可能正好落在低峰 bin 上（PhotoCraft 同款），因此不苛求落在两峰正中。
    const v = new Float32Array(200);
    for (let i = 0; i < 100; i += 1) v[i] = 0.1;
    for (let i = 100; i < 200; i += 1) v[i] = 0.9;
    const t = otsu(v);
    expect(t).toBeGreaterThan(0.05);
    expect(t).toBeLessThan(0.95);
    // 落在低峰那一侧（允许 bin 量化带来的半个 bin 误差）
    const low = v.filter((x) => x < t + 0.01).length;
    const high = v.filter((x) => x >= t + 0.01).length;
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(0);
    expect(low + high).toBe(v.length);
  });
});

describe("morph", () => {
  it("膨胀扩张前景、腐蚀收缩前景", () => {
    const w = 9, h = 9;
    const m = new Uint8Array(w * h);
    m[4 * w + 4] = 1;
    const dil = morph(w, h, m, 1, true);
    const ero = morph(w, h, dil, 1, false);
    expect(dil.reduce((a, b) => a + b, 0)).toBe(9);
    expect(ero[4 * w + 4]).toBe(1);
    expect(ero[4 * w + 3]).toBe(0);
  });
});

describe("convexHull / minRect", () => {
  it("凸包包住所有点，矩形面积不超过包围盒", () => {
    const pts: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [3, 8]];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    const r = minRect(hull);
    expect(r.width).toBeCloseTo(10, 5);
    expect(r.height).toBeCloseTo(10, 5);
    expect(Math.abs(r.angle)).toBeLessThan(0.001);
    expect(r.center[0]).toBeCloseTo(5, 5);
    expect(r.center[1]).toBeCloseTo(5, 5);
  });

  it("旋转矩形能测出角度并归一化到 -45..45", () => {
    const ang = 20 * Math.PI / 180;
    const s = Math.sin(ang), c = Math.cos(ang);
    const hw = 30, hh = 10;
    const corners: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
      .map(([x, y]) => [c * x - s * y + 100, s * x + c * y + 100]);
    const r = minRect(convexHull(corners));
    expect(Math.abs(r.angle)).toBeCloseTo(20, 0);
  });

  it("photoCorners 四角中心与 photo 中心一致", () => {
    const p = photo(100, 100, 40, 20, 15);
    const cs = photoCorners(p);
    expect(cs).toHaveLength(4);
    const cx = cs.reduce((a, q) => a + q[0], 0) / 4;
    const cy = cs.reduce((a, q) => a + q[1], 0) / 4;
    expect(cx).toBeCloseTo(100, 5);
    expect(cy).toBeCloseTo(100, 5);
  });
});

describe("findPhotos", () => {
  it("太小的图返回空", () => {
    expect(findPhotos(makeBuffer(4, 4))).toEqual([]);
  });

  it("纯色白底返回空（没有前景）", () => {
    expect(findPhotos(makeBuffer(64, 64))).toEqual([]);
  });

  it("按阅读顺序找出三张旋转照片，角度误差 <1.5°", () => {
    const truth = [
      photo(150, 120, 180, 120, 7),
      photo(450, 130, 160, 130, -12),
      photo(300, 330, 220, 110, 3),
    ];
    const img = scan(600, 440, truth);
    const found = findPhotos(img);
    expect(found).toHaveLength(3);
    for (let i = 0; i < found.length; i += 1) {
      expect(Math.abs(found[i].angle - truth[i].angle)).toBeLessThan(1.5);
      expect(Math.abs(found[i].center[0] - truth[i].center[0])).toBeLessThan(12);
      expect(Math.abs(found[i].center[1] - truth[i].center[1])).toBeLessThan(12);
      expect(found[i].corners).toHaveLength(4);
      expect(found[i].area).toBeGreaterThan(0.01);
    }
  });

  it("输出角度始终落在 -45..45", () => {
    const found = findPhotos(scan(400, 400, [photo(200, 200, 160, 100, 40)]));
    for (const p of found) {
      expect(p.angle).toBeGreaterThanOrEqual(-45);
      expect(p.angle).toBeLessThanOrEqual(45);
    }
  });
});
