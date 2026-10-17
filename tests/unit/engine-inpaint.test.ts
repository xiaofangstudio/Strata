/**
 * 内容识别填充内核（`inpaint.ts`）的测试。
 *
 * 这一功能最容易做坏的只有一件事：**洞没被真正填掉**。
 * 洞里原来是什么，填完还是什么（只是变模糊了）。所以这里不测「模糊了多少」，
 * 而是直接断言：洞里出现的是「图里别处那种纹理」，并且绝不是原来的东西。
 *
 * 另外钉住三条工程性要求：
 *   - 非破坏：原图不动（界面要拿原图做「取消」）。
 *   - 确定性：同样的种子必得同样的结果（测试可重放，用户重做也能复现）。
 *   - 边界情况不崩：空掩膜 / 全掩膜 / 无可用样本时原样返回，不越界不 NaN。
 */
import {
  inpaint,
  inpaintRect,
  rectMask,
  type InpaintOptions,
} from "../../src/engine/inpaint";
import { createRaster, type Raster } from "../../src/engine/raster";

/** 纵向条纹（周期 8px：4 暗 4 亮），灰度 40 / 220。用来当「图里别处的纹理」。 */
function stripes(w: number, h: number): Raster {
  const r = createRaster(w, h, [255, 255, 255, 255]);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const v = x % 8 < 4 ? 40 : 220;
      r.data[i] = v;
      r.data[i + 1] = v;
      r.data[i + 2] = v;
      r.data[i + 3] = 255;
    }
  }
  return r;
}

/** 把一块矩形涂成一个显眼的颜色（默认品红），用来当「要被抹掉的东西」。 */
function punch(
  r: Raster,
  rect: { x: number; y: number; width: number; height: number },
  color: [number, number, number, number] = [255, 0, 255, 255],
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const o = (y * r.width + x) * 4;
      r.data[o] = color[0];
      r.data[o + 1] = color[1];
      r.data[o + 2] = color[2];
      r.data[o + 3] = color[3];
    }
  }
}

function at(r: Raster, x: number, y: number, c = 0): number {
  return r.data[(y * r.width + x) * 4 + c];
}

function snapshot(r: Raster): number[] {
  return Array.from(r.data);
}

/** 洞内某通道的取值范围。 */
function holeSpan(
  r: Raster,
  rect: { x: number; y: number; width: number; height: number },
  c = 0,
): [number, number] {
  let lo = 255;
  let hi = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const v = at(r, x, y, c);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return [lo, hi];
}

describe("rectMask 矩形掩膜", () => {
  it("矩形内的像素被标记，其余为 0", () => {
    const m = rectMask(10, 10, { x: 2, y: 3, width: 4, height: 2 });
    let count = 0;
    for (let i = 0; i < m.length; i += 1) if (m[i]) count += 1;
    expect(count).toBe(8);
    expect(m[3 * 10 + 2]).toBe(1);
    expect(m[4 * 10 + 5]).toBe(1);
    expect(m[3 * 10 + 6]).toBe(0); // 右边越界的那格没被点
    expect(m[5 * 10 + 2]).toBe(0); // 下边越界的那格没被点
  });

  it("越界的矩形被夹回画布内", () => {
    const m = rectMask(10, 10, { x: -5, y: -5, width: 100, height: 100 });
    let count = 0;
    for (let i = 0; i < m.length; i += 1) if (m[i]) count += 1;
    expect(count).toBe(100);
  });

  it("小数坐标向外取整覆盖", () => {
    const m = rectMask(10, 10, { x: 1.4, y: 1.4, width: 1.2, height: 1.2 });
    let count = 0;
    for (let i = 0; i < m.length; i += 1) if (m[i]) count += 1;
    // x: floor(1.4)=1 .. ceil(2.6)=3（含 1、2）；y 同理
    expect(count).toBe(4);
    expect(m[1 * 10 + 1]).toBe(1);
    expect(m[2 * 10 + 2]).toBe(1);
  });

  it("空矩形不标记任何像素", () => {
    const m = rectMask(10, 10, { x: 3, y: 3, width: 0, height: 0 });
    let count = 0;
    for (let i = 0; i < m.length; i += 1) if (m[i]) count += 1;
    expect(count).toBe(0);
  });
});

describe("inpaint 内容识别填充", () => {
  const HOLE = { x: 12, y: 14, width: 8, height: 4 };

  it("空掩膜：原样返回副本，不改动原图", () => {
    const src = stripes(32, 32);
    const before = snapshot(src);
    const out = inpaint(src, new Uint8Array(32 * 32));
    expect(out).not.toBe(src);
    expect(snapshot(out)).toEqual(before);
    expect(snapshot(src)).toEqual(before);
  });

  it("全掩膜：没有可借的样本，原样返回", () => {
    const src = stripes(32, 32);
    const mask = new Uint8Array(32 * 32).fill(1);
    const out = inpaint(src, mask);
    expect(snapshot(out)).toEqual(snapshot(src));
  });

  it("不改动原图（界面要拿原图做取消）", () => {
    const src = stripes(32, 32);
    punch(src, HOLE);
    const before = snapshot(src);
    const mask = rectMask(32, 32, HOLE);
    inpaint(src, mask);
    expect(snapshot(src)).toEqual(before);
  });

  it("同样的种子必得同样的结果", () => {
    const a = stripes(32, 32);
    punch(a, HOLE);
    const b = stripes(32, 32);
    punch(b, HOLE);
    const mask = rectMask(32, 32, HOLE);
    const opts: InpaintOptions = { seed: 12345, iterations: 4 };
    expect(snapshot(inpaint(a, mask, opts))).toEqual(snapshot(inpaint(b, mask, opts)));
  });

  it("洞被图里别处的纹理填上：不是原来的品红，也不越出画面色域", () => {
    const src = stripes(32, 32);
    punch(src, HOLE);
    const out = inpaint(src, rectMask(32, 32, HOLE), { seed: 7, iterations: 5 });

    // 原内容是品红 R=255；填完必须落在画面的灰度区间 [40, 220] 内
    const [lo, hi] = holeSpan(out, HOLE, 0);
    expect(lo).toBeGreaterThanOrEqual(40);
    expect(hi).toBeLessThanOrEqual(220);
    // 填充结果是灰的（源纹理就是灰的）
    for (let y = HOLE.y; y < HOLE.y + HOLE.height; y += 1) {
      for (let x = HOLE.x; x < HOLE.x + HOLE.width; x += 1) {
        expect(at(out, x, y, 1)).toBe(at(out, x, y, 0));
        expect(at(out, x, y, 2)).toBe(at(out, x, y, 0));
      }
    }
  });

  it("洞内透明像素被填成不透明（借来的纹理是实心的）", () => {
    const src = stripes(32, 32);
    punch(src, HOLE, [0, 0, 0, 0]); // 掏个透明洞
    const out = inpaint(src, rectMask(32, 32, HOLE), { seed: 9 });
    for (let y = HOLE.y; y < HOLE.y + HOLE.height; y += 1) {
      for (let x = HOLE.x; x < HOLE.x + HOLE.width; x += 1) {
        expect(at(out, x, y, 3)).toBe(255);
      }
    }
  });

  it("洞外的像素一根都不动", () => {
    const src = stripes(32, 32);
    punch(src, HOLE);
    const before = snapshot(src);
    const out = inpaint(src, rectMask(32, 32, HOLE), { seed: 3 });
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        if (x >= HOLE.x && x < HOLE.x + HOLE.width && y >= HOLE.y && y < HOLE.y + HOLE.height) {
          continue;
        }
        const o = (y * 32 + x) * 4;
        expect(Array.from(out.data.slice(o, o + 4))).toEqual(before.slice(o, o + 4));
      }
    }
  });

  it("轮数为 0 也至少能导出洞（不会原样留着）", () => {
    const src = stripes(32, 32);
    punch(src, HOLE);
    const out = inpaint(src, rectMask(32, 32, HOLE), { iterations: 0, seed: 5 });
    expect(at(out, 14, 15, 0)).not.toBe(255);
  });

  it("inpaintRect 与手动掩膜结果一致", () => {
    const src = stripes(32, 32);
    punch(src, HOLE);
    const opts: InpaintOptions = { seed: 77 };
    const a = inpaint(src, rectMask(32, 32, HOLE), opts);
    const b = inpaintRect(src, HOLE, opts);
    expect(snapshot(b)).toEqual(snapshot(a));
  });
});
