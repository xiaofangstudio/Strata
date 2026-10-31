/**
 * 裁正照片（连通域）与 3D LUT 导出。
 */
import { describe, expect, it } from "vitest";
import { findPhotoRegions } from "../../src/core/photoCrop";
import { identityCube, identityLut, lutToCube } from "../../src/core/lut";

/** 造一张纯色画布，并把矩形区域涂成另一个颜色。 */
function canvas(
  w: number,
  h: number,
  bg: [number, number, number],
  rects: { x: number; y: number; w: number; h: number; c: [number, number, number] }[],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p += 1) {
    data[p * 4] = bg[0];
    data[p * 4 + 1] = bg[1];
    data[p * 4 + 2] = bg[2];
    data[p * 4 + 3] = 255;
  }
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) {
        const i = (y * w + x) * 4;
        data[i] = r.c[0];
        data[i + 1] = r.c[1];
        data[i + 2] = r.c[2];
      }
    }
  }
  return data;
}

describe("裁正照片", () => {
  it("白底上两块内容 → 切成 2 张", () => {
    const w = 200;
    const h = 120;
    const data = canvas(w, h, [255, 255, 255], [
      { x: 10, y: 10, w: 60, h: 80, c: [40, 90, 160] },
      { x: 110, y: 20, w: 70, h: 60, c: [190, 80, 40] },
    ]);
    const res = findPhotoRegions(data, w, h, 32, 0.004);
    expect(res.boxes.length).toBe(2);
    expect(res.singleBlob).toBe(false);
    // 两个框都该落在大致正确的位置（外扩 2px）
    const first = res.boxes[0];
    expect(first.x).toBeLessThanOrEqual(10);
    expect(first.w).toBeGreaterThanOrEqual(60);
  });

  it("整张都是内容 → 判定为单块，不切", () => {
    const w = 120;
    const h = 120;
    const data = canvas(w, h, [255, 255, 255], [
      { x: 0, y: 0, w, h, c: [30, 30, 30] },
    ]);
    const res = findPhotoRegions(data, w, h, 32, 0.004);
    expect(res.singleBlob).toBe(true);
  });

  it("灰尘级的小点被最小面积过滤掉", () => {
    const w = 200;
    const h = 200;
    const data = canvas(w, h, [255, 255, 255], [
      { x: 20, y: 20, w: 100, h: 100, c: [20, 60, 120] },
      { x: 180, y: 10, w: 2, h: 2, c: [0, 0, 0] },
    ]);
    const res = findPhotoRegions(data, w, h, 32, 0.005);
    expect(res.boxes.length).toBe(1);
  });

  it("黑底也能用（背景是中位数，不是固定白）", () => {
    const w = 160;
    const h = 100;
    const data = canvas(w, h, [0, 0, 0], [
      { x: 20, y: 20, w: 50, h: 50, c: [240, 240, 240] },
      { x: 90, y: 20, w: 40, h: 60, c: [200, 60, 60] },
    ]);
    const res = findPhotoRegions(data, w, h, 40, 0.004);
    expect(res.background[0]).toBe(0);
    expect(res.boxes.length).toBe(2);
  });

  it("空图不崩", () => {
    const res = findPhotoRegions(new Uint8ClampedArray(0), 0, 0);
    expect(res.boxes.length).toBe(0);
  });
});

describe("3D LUT", () => {
  it("恒等网格四个角是黑与白", () => {
    const { data, width } = identityLut(2);
    // r/g/b 全 0 → 黑
    const black = 0;
    expect(data[black]).toBe(0);
    expect(data[black + 1]).toBe(0);
    expect(data[black + 2]).toBe(0);
    // 最后一格（r=1,g=1,b=1）→ 白
    const last = (width * 2 - 1) * 4;
    expect(data[last]).toBe(255);
    expect(data[last + 1]).toBe(255);
    expect(data[last + 2]).toBe(255);
  });

  it(".cube 头与条目数正确", () => {
    const size = 5;
    const { data, width } = identityLut(size);
    const text = lutToCube(data, width, size, "测试");
    expect(text.startsWith('TITLE "测试"')).toBe(true);
    expect(text).toContain("LUT_3D_SIZE 5");
    expect(text).toContain("DOMAIN_MIN 0.0 0.0 0.0");
    const rows = text.split("\n").filter((l) => /^[0-9.]+ [0-9.]+ [0-9.]+$/.test(l));
    expect(rows.length).toBe(size ** 3);
  });

  it("条目顺序是 r 最快、b 最慢（第一行全 0，最后一格全 1）", () => {
    const size = 3;
    const text = identityCube(size);
    const rows = text.split("\n").filter((l) => /^[0-9.]+ [0-9.]+ [0-9.]+$/.test(l));
    expect(rows[0]).toBe("0.000000 0.000000 0.000000");
    // 第 2 条：r 变大，g/b 还是 0。
    // 注意是 0.501961 而不是 0.5：LUT 的值来自 8 位像素（127.5 被舍入成 128），
    // 这是 8 位管线的固有量化，不是 bug。
    expect(rows[1]).toBe("0.501961 0.000000 0.000000");
    expect(rows[rows.length - 1]).toBe("1.000000 1.000000 1.000000");
  });

  it("标题里的引号被转义，不会破坏文件结构", () => {
    const { data, width } = identityLut(2);
    const text = lutToCube(data, width, 2, 'he said "hi"');
    expect(text.split("\n")[0]).toBe(`TITLE "he said 'hi'"`);
  });
});
