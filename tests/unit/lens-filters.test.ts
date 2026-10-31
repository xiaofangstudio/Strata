/**
 * 镜头校正 / 自适应广角：几何反畸变内核。
 */
import { describe, expect, it } from "vitest";
import { adaptiveWideAngle, lensCorrection } from "../../src/engine/filters/lens";
import { makeBuffer, type RgbaBuffer } from "../../src/engine/filters/kernels";
import { RAW } from "../../src/ui/components/menuCatalog.data";

function make(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): RgbaBuffer {
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

const solid = (w: number, h: number, v: number) => make(w, h, () => [v, v, v, 255]);
const at = (buf: RgbaBuffer, x: number, y: number) => {
  const o = (y * buf.width + x) * 4;
  return [buf.data[o], buf.data[o + 1], buf.data[o + 2], buf.data[o + 3]];
};

describe("镜头校正", () => {
  it("所有参数为 0 时等于原图", () => {
    const src = make(8, 8, (x, y) => [x * 20, y * 20, 120, 255]);
    const out = lensCorrection(src, 0, 0, 0, 0, 0, 50);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("负晕影提亮四角、中心不变", () => {
    const src = solid(21, 21, 100);
    const out = lensCorrection(src, 0, 0, 0, 0, -50, 50);
    // 中心：rd=0 → 增益 1
    expect(at(out, 10, 10)[0]).toBe(100);
    // 角：rd≈1 → 增益 1 + 0.5 = 1.5 → 150
    expect(at(out, 0, 0)[0]).toBe(150);
  });

  it("正晕影压暗四角", () => {
    const src = solid(21, 21, 200);
    const out = lensCorrection(src, 0, 0, 0, 0, 50, 50);
    expect(at(out, 10, 10)[0]).toBe(200);
    expect(at(out, 0, 0)[0]).toBe(100);
  });

  it("桶形/枕形畸变改变边缘像素而不动中心", () => {
    // 左暗右亮的渐变：径向重采样后中心值不变、边缘被拉动
    const src = make(21, 21, (x) => {
      const v = Math.round((x / 20) * 255);
      return [v, v, v, 255];
    });
    const out = lensCorrection(src, 40, 0, 0, 0, 0, 50);
    expect(at(out, 10, 10)[0]).toBe(at(src, 10, 10)[0]);
    expect(Array.from(out.data)).not.toEqual(Array.from(src.data));
  });

  it("垂直透视把上边收窄（keystone）", () => {
    // 竖条纹图：keystone 后同一行的像素值不再是原始线性分布
    const src = make(21, 21, (x) => {
      const v = x % 2 === 0 ? 0 : 255;
      return [v, v, v, 255];
    });
    const out = lensCorrection(src, 0, 60, 0, 0, 0, 50);
    expect(Array.from(out.data)).not.toEqual(Array.from(src.data));
    // 中间行（ny≈0）几乎不受影响，靠近上下边的行被横向拉开
    expect(at(out, 10, 10)[0]).toBe(at(src, 10, 10)[0]);
    expect(at(out, 3, 0)[0]).not.toBe(at(src, 3, 0)[0]);
  });

  it("色差校正不会在纯色图上制造变化", () => {
    const src = solid(15, 15, 120);
    const out = lensCorrection(src, 0, 0, 0, 6, 0, 50);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(120);
      expect(out.data[i + 1]).toBe(120);
      expect(out.data[i + 2]).toBe(120);
    }
  });
});

describe("自适应广角", () => {
  it("把偏心亮点按鱼眼→直线的映射往中心拉", () => {
    const w = 41;
    const h = 41;
    const src = make(w, h, (x, y) =>
      x === 40 && y === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255],
    );
    const out = adaptiveWideAngle(src, 50, 0);
    // 找最亮像素的 x
    let bestX = 0;
    let bestV = -1;
    for (let x = 0; x < w; x += 1) {
      const v = at(out, x, 20)[0];
      if (v > bestV) {
        bestV = v;
        bestX = x;
      }
    }
    expect(bestV).toBeGreaterThan(200);
    expect(bestX).toBeLessThan(40); // 从最右边被拉进来了
    expect(bestX).toBeGreaterThan(28);
  });

  it("反向模式把亮点往外推", () => {
    const w = 41;
    const h = 41;
    const src = make(w, h, (x, y) =>
      x === 34 && y === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255],
    );
    const out = adaptiveWideAngle(src, 50, 1);
    // 拉伸会把亮点摊薄，所以看亮度重心而不是峰值
    let sum = 0;
    let weighted = 0;
    for (let x = 0; x < w; x += 1) {
      const v = at(out, x, 20)[0];
      sum += v;
      weighted += v * x;
    }
    expect(sum).toBeGreaterThan(100);
    expect(weighted / sum).toBeGreaterThan(34);
  });

  it("纯色图经过去畸变后仍是纯色", () => {
    const src = solid(21, 21, 90);
    const out = adaptiveWideAngle(src, 60, 0);
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i]).toBe(90);
  });
});

describe("最后 4 个菜单 id 的契约", () => {
  it("镜头校正 / 自适应广角 命中菜单目录，灭点与智能滤镜由 EditorShell 接管", () => {
    const ids = new Set(RAW.map((row) => row[3]));
    expect(ids.has("filter.lensCorrection")).toBe(true);
    expect(ids.has("filter.adaptiveWideAngle")).toBe(true);
    expect(ids.has("filter.vanishingPoint")).toBe(true);
    expect(ids.has("filter.convertForSmartFilters")).toBe(true);
  });
});
