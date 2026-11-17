/**
 * Focus Area（焦区域）算法升级回归：modified Laplacian + guided filter。
 */
import { describe, expect, it } from "vitest";
import { focusAreaHit } from "../../src/engine/algos/focusArea";

function makeImage(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b] = px(x, y);
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  }
  return d;
}

function count(hit: Uint8Array | null): number {
  if (!hit) return 0;
  let n = 0;
  for (let i = 0; i < hit.length; i += 1) n += hit[i];
  return n;
}

describe("focusAreaHit 焦区域", () => {
  it("前景清晰、背景模糊时主要选中前景", () => {
    const w = 48;
    const h = 48;
    const d = makeImage(w, h, (x, y) => {
      // 背景是缓慢渐变（低锐度），中心 16×16 是棋盘（高锐度）
      const inSubject = x >= 16 && x < 32 && y >= 16 && y < 32;
      const v = inSubject
        ? (x + y) % 2 === 0 ? 20 : 235
        : 100 + Math.round((x + y) * 0.7);
      return [v, v, v];
    });
    const hit = focusAreaHit(d, w, h, 24);
    expect(hit).not.toBeNull();
    const center = hit![24 * w + 24];
    const corner = hit![4 * w + 4];
    expect(center).toBe(1);
    expect(corner).toBe(0);
  });

  it("纯色图没有合焦区域", () => {
    const d = makeImage(24, 24, () => [120, 120, 120]);
    expect(focusAreaHit(d, 24, 24, 24)).toBeNull();
  });

  it("In-Focus Range 越大，入选像素越多", () => {
    const d = makeImage(40, 40, (x, y) => {
      const highContrast = x < 20;
      const v = (x + y) % 2 === 0
        ? highContrast ? 20 : 90
        : highContrast ? 235 : 110;
      return [v, v, v];
    });
    const narrow = count(focusAreaHit(d, 40, 40, 10));
    const wide = count(focusAreaHit(d, 40, 40, 90));
    expect(wide).toBeGreaterThan(narrow);
  });
});
