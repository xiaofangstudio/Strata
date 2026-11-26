import { describe, expect, it } from "vitest";
import { createRaster, type Raster } from "../../src/engine/raster";
import { inpaint } from "../../src/engine/inpaint";
import { completeInpaint } from "../../src/engine/algos/inpaintComplete";

const W = 24;
const H = 16;

/** 左侧纯红、右侧纯蓝、中间中性：取样区选哪边，洞里就该补成哪边的颜色。 */
function fixture(): { image: Raster; hole: Uint8Array } {
  const image = createRaster(W, H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const c = x < 10 ? [220, 30, 30] : x >= 14 ? [30, 30, 220] : [120, 120, 120];
      image.data[i] = c[0];
      image.data[i + 1] = c[1];
      image.data[i + 2] = c[2];
      image.data[i + 3] = 255;
    }
  }
  const hole = new Uint8Array(W * H);
  for (let y = 6; y < 10; y += 1) {
    for (let x = 11; x < 13; x += 1) hole[y * W + x] = 1;
  }
  return { image, hole };
}

function onlyRange(fromX: number, toX: number): Uint8Array {
  const sample = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = fromX; x < toX; x += 1) sample[y * W + x] = 1;
  }
  return sample;
}

function holeAverage(image: Raster, hole: Uint8Array): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < hole.length; i += 1) {
    if (!hole[i]) continue;
    r += image.data[i * 4];
    g += image.data[i * 4 + 1];
    b += image.data[i * 4 + 2];
    n += 1;
  }
  return [r / n, g / n, b / n];
}

describe("内容识别填充的自定义取样区", () => {
  it("inpaint 只从取样平面允许的像素借纹理", () => {
    const { image, hole } = fixture();
    const opts = { patch: 1, iterations: 3, search: 12, seed: 7, meld: false };
    const red = inpaint(image, hole, { ...opts, sample: onlyRange(0, 10) });
    const blue = inpaint(image, hole, { ...opts, sample: onlyRange(14, W) });
    const [rr, , rb] = holeAverage(red, hole);
    const [br, , bb] = holeAverage(blue, hole);

    expect(rr).toBeGreaterThan(br + 30);
    expect(bb).toBeGreaterThan(rb + 30);
    // 取样区外的像素不能被改动。
    for (let i = 0; i < hole.length; i += 1) {
      if (hole[i]) continue;
      for (let c = 0; c < 4; c += 1) {
        expect(red.data[i * 4 + c]).toBe(image.data[i * 4 + c]);
      }
    }
  });

  it("completeInpaint 的多尺度路径同样尊重取样平面", () => {
    const { image, hole } = fixture();
    const opts = { patch: 1, iterations: 2, search: 12, seed: 7, meld: false };
    const red = completeInpaint(image, hole, { ...opts, sample: onlyRange(0, 10) });
    const blue = completeInpaint(image, hole, { ...opts, sample: onlyRange(14, W) });
    const [rr, , rb] = holeAverage(red, hole);
    const [br, , bb] = holeAverage(blue, hole);
    expect(rr).toBeGreaterThan(br + 20);
    expect(bb).toBeGreaterThan(rb + 20);
  });

  it("不传取样平面时保持原有全图取样行为", () => {
    const { image, hole } = fixture();
    const base = inpaint(image, hole, { patch: 1, iterations: 3, search: 12, seed: 7 });
    const all = inpaint(image, hole, {
      patch: 1,
      iterations: 3,
      search: 12,
      seed: 7,
      sample: new Uint8Array(W * H).fill(1),
    });
    expect(Array.from(base.data)).toEqual(Array.from(all.data));
  });
});
