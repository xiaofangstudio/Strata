/**
 * 像素内核地基（`raster.ts`）的测试。
 *
 * 液化、内容识别填充、自动调整全都长在这一层上，所以这里的每条不变量都
 * 直接决定上层算法的观感：
 *
 *   - `sampleBilinear` 越界必须按边缘夹取。若退化成「采到画布外的透明像素」，
 *     往外推的形变会顺带啃掉画布边缘，推一次缺一圈。
 *   - `falloff` 在半径边界处的值与一阶导要同时归零，否则一次涂抹就会在
 *     作用范围的边界留下一圈可见的圆环接缝。
 *
 * 全是纯计算，无 DOM，`environment: node` 下直接跑。
 */
import {
  asRaster,
  cloneRaster,
  createRaster,
  falloff,
  intersectRect,
  sameSize,
  sampleBilinear,
  type Raster,
} from "../../src/engine/raster";

/** 4×1 的实心横向渐变，R 通道 10 / 20 / 30 / 40，alpha 全 255。 */
function grad(): Raster {
  const r = createRaster(4, 1, [255, 255, 255, 255]);
  for (let i = 0; i < 4; i += 1) {
    r.data[i * 4] = (i + 1) * 10;
    r.data[i * 4 + 1] = 0;
    r.data[i * 4 + 2] = 0;
  }
  return r;
}

/** 取一个采样点的四个通道（浮点）。 */
function sample(src: Raster, x: number, y: number): number[] {
  const out = new Float32Array(4);
  sampleBilinear(src, x, y, out);
  return Array.from(out);
}

describe("Raster 数据形状", () => {
  it("createRaster 默认全透明，尺寸向下取整且至少 1", () => {
    const r = createRaster(3, 2);
    expect(r.width).toBe(3);
    expect(r.height).toBe(2);
    expect(r.data.length).toBe(3 * 2 * 4);
    for (let i = 0; i < r.data.length; i += 1) expect(r.data[i]).toBe(0);

    // 0 / 负值 / 小数都不该造出非法缓冲区
    expect(createRaster(0, 0).width).toBe(1);
    expect(createRaster(-5, 2.4).width).toBe(1);
    expect(createRaster(2.6, 2).width).toBe(3);
  });

  it("createRaster 指定填充色时 alpha 缺省为不透明", () => {
    const r = createRaster(2, 1, [10, 20, 30]);
    expect(Array.from(r.data)).toEqual([10, 20, 30, 255, 10, 20, 30, 255]);
  });

  it("asRaster 只是取视图，不拷贝像素", () => {
    const img = { data: new Uint8ClampedArray(8), width: 2, height: 1 };
    const r = asRaster(img);
    img.data[0] = 77;
    expect(r.data[0]).toBe(77);
  });

  it("cloneRaster 是深拷贝：改副本不影响原件", () => {
    const a = grad();
    const b = cloneRaster(a);
    b.data[0] = 200;
    expect(a.data[0]).toBe(10);
    expect(b.data[0]).toBe(200);
    expect(sameSize(a, b)).toBe(true);
  });

  it("sameSize 只比尺寸", () => {
    expect(sameSize(createRaster(4, 4), createRaster(4, 4))).toBe(true);
    expect(sameSize(createRaster(4, 4), createRaster(4, 5))).toBe(false);
    expect(sameSize(createRaster(4, 4), createRaster(5, 4))).toBe(false);
  });
});

describe("sampleBilinear", () => {
  it("整数坐标取到的就是那一个像素本身", () => {
    expect(sample(grad(), 0, 0)[0]).toBe(10);
    expect(sample(grad(), 3, 0)[0]).toBe(40);
  });

  it("半程坐标取两侧的线性平均", () => {
    expect(sample(grad(), 0.5, 0)[0]).toBeCloseTo(15, 5);
    expect(sample(grad(), 2.25, 0)[0]).toBeCloseTo(32.5, 5);
  });

  it("纵向同样做双线性", () => {
    const r = createRaster(1, 2, [0, 0, 0, 255]);
    r.data[0] = 0;
    r.data[4] = 100;
    expect(sample(r, 0, 0.5)[0]).toBeCloseTo(50, 5);
  });

  it("越界一律按边缘夹取，绝不采到画布外的透明像素", () => {
    // 这是「往外推出空白」的防线：边缘像素是实心的，夹取后仍应是实心的
    for (const [x, y] of [[-50, 0], [99, 0], [0, -50], [0, 99], [-9, -9]] as const) {
      const o = sample(grad(), x, y);
      expect(o[3]).toBe(255);
      expect(o[0]).toBeGreaterThan(0);
    }
    // 夹到最左 / 最右那一列
    expect(sample(grad(), -50, 0)[0]).toBe(10);
    expect(sample(grad(), 99, 0)[0]).toBe(40);
    expect(sample(grad(), 0, -50)[0]).toBe(10);
  });

  it("单像素图任何坐标都采到它自己", () => {
    const r = createRaster(1, 1, [7, 8, 9, 128]);
    for (const [x, y] of [[-3, 5], [0, 0], [12, -12]] as const) {
      expect(sample(r, x, y)).toEqual([7, 8, 9, 128]);
    }
  });
});

describe("falloff 距离衰减", () => {
  it("中心为 1、半径处为 0、半径外恒为 0", () => {
    expect(falloff(0, 10)).toBe(1);
    expect(falloff(10, 10)).toBe(0);
    expect(falloff(25, 10)).toBe(0);
  });

  it("退化半径不产生 NaN", () => {
    expect(falloff(0, 0)).toBe(0);
    expect(falloff(0, -3)).toBe(0);
  });

  it("沿半径单调不增", () => {
    let prev = Infinity;
    for (let d = 0; d <= 10; d += 0.5) {
      const v = falloff(d, 10);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  it("边界处一阶导趋于零：不留圆环接缝", () => {
    // (1-t²)² 在 t→1 时值本身已经很小，且变化率也趋零
    expect(falloff(9.9, 10)).toBeLessThan(0.001);
    const near = falloff(9.99, 10);
    const edge = falloff(10, 10);
    expect(near - edge).toBeLessThan(1e-5);
  });
});

describe("intersectRect", () => {
  const a = { x: 10, y: 10, width: 20, height: 20 };

  it("相交时取重叠部分", () => {
    expect(intersectRect(a, { x: 20, y: 25, width: 30, height: 30 })).toEqual({
      x: 20,
      y: 25,
      width: 10,
      height: 5,
    });
  });

  it("完全包含时取被包含的那个", () => {
    const inner = { x: 12, y: 14, width: 4, height: 6 };
    expect(intersectRect(a, inner)).toEqual(inner);
    expect(intersectRect(inner, a)).toEqual(inner);
  });

  it("不相交时宽或高为 0，绝不给出负尺寸", () => {
    const far = intersectRect(a, { x: 100, y: 100, width: 5, height: 5 });
    expect(far.width).toBe(0);
    expect(far.height).toBe(0);
    expect(far.x).toBeGreaterThanOrEqual(0);

    const side = intersectRect(a, { x: 40, y: 0, width: 5, height: 50 });
    expect(side.width).toBe(0);
  });

  it("边界相切也算不相交", () => {
    const t = intersectRect(a, { x: 30, y: 10, width: 10, height: 10 });
    expect(t.width).toBe(0);
  });
});
