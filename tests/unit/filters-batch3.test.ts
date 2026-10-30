/**
 * 第三批滤镜内核 + 注册表契约。
 *
 * 覆盖：平均 / 高反差保留 / 最大值 / 最小值 / 位移 / 分块 / 多面体 /
 * 点状化 / 锯齿 / 剪切 / 极坐标 / 扩散 / 等高线 / 云彩 / 差值云彩 /
 * 纤维 / NTSC / 逐行 / 凸出，以及「所有已注册滤镜都能在任意小图上运行」
 * 的遍历断言 —— 防止菜单里再出现点了没反应的空条目。
 */
import { describe, expect, it } from "vitest";
import {
  average,
  clouds,
  deInterlace,
  differenceClouds,
  highPass,
  maximum,
  minimum,
  ntscColors,
  offset,
} from "../../src/engine/filters/kernels";
import {
  FILTER_DEFS,
  filterDef,
  filterParams,
} from "../../src/engine/filters/defs";

const W = 8;
const H = 8;

/** 用像素回调造一张 RGBA 缓冲。 */
function make(
  w: number,
  h: number,
  px: (x: number, y: number) => [number, number, number, number],
) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b, a] = px(x, y);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { data, width: w, height: h };
}

const solid = (r: number, g: number, b: number) => make(W, H, () => [r, g, b, 255]);

describe("平均 / 高反差保留", () => {
  it("平均把整层填成平均色", () => {
    const buf = make(2, 2, (x, y) => {
      const v = [0, 100, 200, 255][y * 2 + x];
      return [v, v, v, 255];
    });
    const out = average(buf);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(139); // (0+100+200+255)/4 = 138.75 → 139
      expect(out.data[i + 3]).toBe(255);
    }
  });

  it("高反差保留在纯色上等于 128 灰", () => {
    const out = highPass(solid(200, 120, 40), 4);
    // 纯色图的模糊仍是原色，差为 0 → 128
    expect(out.data[0]).toBe(128);
    expect(out.data[1]).toBe(128);
    expect(out.data[2]).toBe(128);
    expect(out.data[3]).toBe(255);
  });
});

describe("最大值 / 最小值（膨胀 / 腐蚀）", () => {
  it("一维序列经最大/最小滤波后分别取极大/极小", () => {
    const buf = make(3, 1, (x) => {
      const v = [10, 50, 90][x];
      return [v, v, v, 255];
    });
    const mx = maximum(buf, 1);
    const mn = minimum(buf, 1);
    // 边界夹取：x=0 的窗口是 {10,10,50}，x=2 的窗口是 {50,90,90}
    expect([mx.data[0], mx.data[4], mx.data[8]]).toEqual([50, 90, 90]);
    expect([mn.data[0], mn.data[4], mn.data[8]]).toEqual([10, 10, 50]);
  });
});

describe("位移 / 逐行", () => {
  it("位移按折回语义移动整幅", () => {
    const buf = make(2, 2, (x, y) => {
      const v = [10, 20, 30, 40][y * 2 + x];
      return [v, 0, 0, 255];
    });
    const out = offset(buf, 1, 0);
    // 右移一格并折回：row0 变 B A，row1 变 D C
    expect([out.data[0], out.data[4]]).toEqual([20, 10]);
    expect([out.data[8], out.data[12]]).toEqual([40, 30]);
  });

  it("逐行保留偶数行、奇数行取相邻均值", () => {
    const buf = make(1, 3, (_x, y) => [y * 100, 0, 0, 255]);
    const out = deInterlace(buf, 0);
    expect(out.data[0]).toBe(0); // row0 保留
    expect(out.data[4]).toBe(100); // row1 = (row0 + row2)/2
    expect(out.data[8]).toBe(200); // row2 保留
  });
});

describe("NTSC / 云彩", () => {
  it("NTSC 把过饱和红压回安全范围", () => {
    const out = ntscColors(solid(255, 0, 0));
    expect(out.data[0]).toBeLessThan(255);
    expect(out.data[0]).toBeGreaterThan(200);
    expect(out.data[1]).toBeGreaterThan(0);
  });

  it("云彩可复现且落在 0–255", () => {
    const a = clouds(solid(0, 0, 0), 4, 5);
    const b = clouds(solid(0, 0, 0), 4, 5);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    for (let i = 0; i < a.data.length; i += 4) {
      expect(a.data[i]).toBeGreaterThanOrEqual(0);
      expect(a.data[i]).toBeLessThanOrEqual(255);
      expect(a.data[i + 3]).toBe(255);
    }
  });

  it("差值云彩 = |原图 − 云彩|", () => {
    const src = solid(200, 200, 200);
    const cl = clouds(src, 4, 5);
    const out = differenceClouds(src, 4, 5);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(Math.abs(200 - cl.data[i]));
    }
  });
});

describe("注册表：每个已注册滤镜都能真正跑通", () => {
  const base = make(16, 16, (x, y) => [
    (x * 16) % 256,
    (y * 16) % 256,
    ((x + y) * 8) % 256,
    255,
  ]);

  it("FILTER_DEFS 全部默认可应用、尺寸不变、像素有限", () => {
    expect(FILTER_DEFS.length).toBeGreaterThan(40);
    for (const def of FILTER_DEFS) {
      const out = def.apply(base, filterParams(def));
      expect(out.width, def.id).toBe(base.width);
      expect(out.height, def.id).toBe(base.height);
      expect(out.data.length, def.id).toBe(base.data.length);
      for (let i = 0; i < out.data.length; i += 1) {
        expect(Number.isFinite(out.data[i]), `${def.id} @${i}`).toBe(true);
      }
    }
  });

  it("第三批新增的菜单 id 都已注册（不再是灰的）", () => {
    const ids = [
      "filter.blur.average",
      "filter.other.highPass",
      "filter.other.maximum",
      "filter.other.minimum",
      "filter.other.offset",
      "filter.other.custom",
      "filter.pixelate.facet",
      "filter.pixelate.pointillize",
      "filter.distort.zigZag",
      "filter.distort.shear",
      "filter.distort.polarCoordinates",
      "filter.stylize.diffuse",
      "filter.stylize.tiles",
      "filter.stylize.traceContour",
      "filter.stylize.extrude",
      "filter.render.clouds",
      "filter.render.differenceClouds",
      "filter.render.fibers",
      "filter.video.ntscColors",
      "filter.video.deInterlace",
    ];
    for (const id of ids) expect(filterDef(id), id).toBeTruthy();
  });
});
