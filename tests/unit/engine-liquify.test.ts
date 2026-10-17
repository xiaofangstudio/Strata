/**
 * 液化内核（`liquify.ts`）的测试。
 *
 * 液化最容易被做坏的两件事，这里各钉一条：
 *
 *   1. 就地改像素。那样来回推十遍，边缘就被反复插值插烂了。位移场 + 反向映射
 *      （`out(p) = src(p + d(p))`）保证「推几遍」和「推一遍」结果一样干净，
 *      所以这里反复对同一张原图重建，断言结果稳定。
 *   2. 笔迹退化成一串孤立圆点。液化沿用画笔那套「时间低通 + 按间距投放笔尖」，
 *      时间戳不可信时退回名义间隔，绝不逐个采样点吸附 —— 与画笔同一个坑。
 *
 * 另外断言两件容易被忽略的事：往外推不会啃掉画布边缘（alpha 不丢），
 * 以及单笔尖位移有上限（拖再快也不会把半个画面甩出去）。
 */
import {
  applyLiquifyOps,
  cloneField,
  createField,
  DEFAULT_LIQUIFY,
  fieldIsIdentity,
  LiquifyStroke,
  LIQUIFY_MODES,
  warp,
  warpInto,
  type LiquifyField,
} from "../../src/engine/liquify";
import { createRaster, type Raster } from "../../src/engine/raster";

/** 纵向条纹（周期 8px：4 亮 4 暗），用来观察像素有没有被搬动。 */
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

/** 单通道取值。 */
function at(r: Raster, x: number, y: number, c = 0): number {
  return r.data[(y * r.width + x) * 4 + c];
}

/** 位移场里的最大位移量。 */
function maxAbs(f: LiquifyField): number {
  let m = 0;
  for (let i = 0; i < f.dx.length; i += 1) {
    m = Math.max(m, Math.abs(f.dx[i]), Math.abs(f.dy[i]));
  }
  return m;
}

/** 位移场里的位移总量（用来观察「重建画笔」有没有把场拉回去）。 */
function sumAbs(f: LiquifyField): number {
  let s = 0;
  for (let i = 0; i < f.dx.length; i += 1) s += Math.abs(f.dx[i]) + Math.abs(f.dy[i]);
  return s;
}

describe("位移场", () => {
  it("新建的场是恒等，不动任何像素", () => {
    const f = createField(16, 9);
    expect(f.width).toBe(16);
    expect(f.height).toBe(9);
    expect(f.dx.length).toBe(16 * 9);
    expect(fieldIsIdentity(f)).toBe(true);
  });

  it("cloneField 是深拷贝", () => {
    const f = createField(4, 4);
    const g = cloneField(f);
    g.dx[0] = 5;
    expect(f.dx[0]).toBe(0);
    expect(g.dx[0]).toBe(5);
  });

  it("fieldIsIdentity 认得微小但真实的位移", () => {
    const f = createField(4, 4);
    f.dy[7] = 0.5;
    expect(fieldIsIdentity(f)).toBe(false);
    // 容差内视为没动
    f.dy[7] = 0.001;
    expect(fieldIsIdentity(f)).toBe(true);
  });
});

describe("warp 重建", () => {
  it("位移场把像素搬到该去的位置", () => {
    // 16×1 里 x=6 处一个亮点；全场 dx=+2 ⇒ out(p)=src(p+2)，亮点应出现在 x=4
    const src = createRaster(16, 1);
    src.data[6 * 4] = 255;
    src.data[6 * 4 + 3] = 255;

    const f = createField(16, 1);
    for (let i = 0; i < 16; i += 1) f.dx[i] = 2;

    const out = warp(src, f);
    expect(at(out, 4, 0)).toBe(255);
    expect(at(out, 6, 0)).toBe(0);
    expect(at(out, 4, 0, 3)).toBe(255); // 搬运时 alpha 一起跟过来
  });

  it("恒等场重建出的图与原图逐字节一致", () => {
    const src = stripes(24, 24);
    const out = warp(src, createField(24, 24));
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("限定矩形时只重算那一块，矩形外原样保留", () => {
    const src = stripes(16, 16);
    const dst = createRaster(16, 16, [128, 128, 128, 255]);
    const f = createField(16, 16);
    for (let i = 0; i < 16 * 16; i += 1) f.dx[i] = 1;

    warpInto(src, f, dst, { x: 0, y: 0, width: 4, height: 4 });

    expect(at(dst, 0, 0)).toBe(40); // 采样到 src(1,0)，条纹的暗格
    expect(at(dst, 5, 5)).toBe(128); // 矩形外一点没被动过
    expect(at(dst, 4, 0)).toBe(128);
  });

  it("超出画布的矩形不会越界写坏内存", () => {
    const src = stripes(8, 8);
    const dst = createRaster(8, 8, [128, 128, 128, 255]);
    const f = createField(8, 8);
    warpInto(src, f, dst, { x: 6, y: 6, width: 100, height: 100 });
    expect(at(dst, 7, 7)).toBe(220); // x%8=7 ⇒ 条纹的亮格
    expect(at(dst, 5, 5)).toBe(128); // 矩形外未被碰过
  });
});

describe("位移方向", () => {
  const src = () => stripes(64, 64);

  it("推：位移量正比于拖动距离，中心位移最大", () => {
    const f = createField(64, 64);
    applyLiquifyOps(src(), f, [{ x: 32, y: 32, radius: 16, power: 1, mode: "push", dx: 6 }]);
    // 圆心处被完整搬运
    expect(f.dx[32 * 64 + 32]).toBeCloseTo(-6, 5);
    // 半径外没有任何位移
    expect(f.dx[32 * 64 + 32 + 20]).toBe(0);
    // 方向：向右推 ⇒ 位移为负（反向映射）
    expect(f.dx[32 * 64 + 40]).toBeLessThan(0);
  });

  it("膨胀把两侧向外撑开，收缩把两侧向内拉", () => {
    const outer = 32 * 64 + 40; // 圆心右侧一点
    const blo = createField(64, 64);
    applyLiquifyOps(src(), blo, [{ x: 32, y: 32, radius: 16, power: 1, mode: "bloat" }]);
    const pin = createField(64, 64);
    applyLiquifyOps(src(), pin, [{ x: 32, y: 32, radius: 16, power: 1, mode: "pinch" }]);

    // 膨胀 / 收缩方向相反，且都沿半径方向
    expect(blo.dx[outer]).toBeLessThan(0);
    expect(pin.dx[outer]).toBeGreaterThan(0);
    expect(Math.abs(blo.dy[outer])).toBeLessThan(1e-6);
  });

  it("旋转产生与半径垂直的位移", () => {
    const f = createField(64, 64);
    applyLiquifyOps(src(), f, [{ x: 32, y: 32, radius: 16, power: 1, mode: "twirl", angle: 0.3 }]);
    const i = 32 * 64 + 40; // 圆心正右方
    expect(Math.abs(f.dy[i])).toBeGreaterThan(0.1); // 被转到纵向上去了
    expect(Math.abs(f.dx[i])).toBeGreaterThan(0);
  });

  it("笔尖正中心不参与方向类操作（那里没有方向可言）", () => {
    for (const mode of ["bloat", "pinch", "twirl"] as const) {
      const f = createField(64, 64);
      applyLiquifyOps(src(), f, [{ x: 32, y: 32, radius: 16, power: 1, mode }]);
      expect(fieldIsIdentity(f)).toBe(false); // 周围动了
      expect(f.dx[32 * 64 + 32]).toBe(0);
      expect(f.dy[32 * 64 + 32]).toBe(0);
    }
  });

  it("重建画笔把场朝恒等收敛，圆心归零", () => {
    const f = createField(64, 64);
    applyLiquifyOps(src(), f, [{ x: 32, y: 32, radius: 16, power: 1, mode: "push", dx: 6 }]);
    const before = sumAbs(f);
    expect(before).toBeGreaterThan(0);

    applyLiquifyOps(src(), f, [{ x: 32, y: 32, radius: 16, power: 1, mode: "restore" }]);
    const after = sumAbs(f);
    expect(after).toBeLessThan(before * 0.8);
    expect(f.dx[32 * 64 + 32]).toBeCloseTo(0, 5);
  });

  it("同一组操作必得同一张位移场（确定性）", () => {
    const run = () => {
      const f = createField(64, 64);
      applyLiquifyOps(src(), f, [
        { x: 20, y: 20, radius: 12, power: 0.8, mode: "push", dx: 3, dy: -2 },
        { x: 40, y: 40, radius: 10, power: 0.5, mode: "twirl", angle: 0.2 },
      ]);
      return Array.from(f.dx).concat(Array.from(f.dy));
    };
    expect(run()).toEqual(run());
  });
});

describe("LiquifyStroke 笔迹", () => {
  /** 从 (12,32) 拖到 (52,32)，每帧 16ms。 */
  function drag(s: LiquifyStroke, from: number, to: number, steps: number, time = 0): void {
    s.begin(from, 32, 0.5, time);
    for (let i = 1; i <= steps; i += 1) {
      s.extend(from + ((to - from) * i) / steps, 32, 0.5, time + i * 16);
    }
    s.finish();
  }

  it("默认参数可用，五种模式都在", () => {
    expect(LIQUIFY_MODES.length).toBe(5);
    expect(LIQUIFY_MODES).toContain(DEFAULT_LIQUIFY.mode);
  });

  it("一笔拖完：场不再是恒等，touched 为真，结果与原型不同", () => {
    const src = stripes(64, 64);
    const s = new LiquifyStroke(src, {
      size: 40,
      hardness: 50,
      strength: 100,
      spacing: 10,
      mode: "push",
    });
    drag(s, 12, 52, 20);
    const rect = s.pull();

    expect(rect).not.toBeNull();
    expect(s.touched).toBe(true);
    expect(fieldIsIdentity(s.field)).toBe(false);
    expect(Array.from(s.result.data)).not.toEqual(Array.from(src.data));
    // 原图绝不能被就地改写
    expect(Array.from(src.data)).toEqual(Array.from(stripes(64, 64).data));
  });

  it("总搬运量不超过实际拖动距离（单笔尖位移有上限）", () => {
    const src = stripes(64, 64);
    const s = new LiquifyStroke(src, {
      size: 40,
      hardness: 50,
      strength: 100,
      spacing: 10,
      mode: "push",
    });
    drag(s, 12, 52, 20); // 拖动 40px
    const m = maxAbs(s.field);
    expect(m).toBeGreaterThan(5);
    expect(m).toBeLessThanOrEqual(40.5);
  });

  it("时间戳不可信（全同值 / 零 / NaN）也照常推进，不会挤成孤点", () => {
    for (const bad of [0, 12345, Number.NaN]) {
      const s = new LiquifyStroke(stripes(64, 64), {
        size: 40,
        hardness: 50,
        strength: 100,
        spacing: 10,
        mode: "push",
      });
      s.begin(12, 32, 0.5, bad);
      for (let i = 1; i <= 20; i += 1) s.extend(12 + i * 2, 32, 0.5, bad);
      s.finish();
      s.pull();
      expect(s.touched).toBe(true);
      expect(maxAbs(s.field)).toBeGreaterThan(5);
    }
  });

  it("抬笔冲刷：末端笔尖补齐，脏矩形覆盖整条笔迹", () => {
    const s = new LiquifyStroke(stripes(64, 64), {
      size: 40,
      hardness: 50,
      strength: 100,
      spacing: 10,
      mode: "push",
    });
    drag(s, 12, 52, 20);
    const rect = s.pull();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeLessThanOrEqual(12);
    expect(rect!.x + rect!.width).toBeGreaterThanOrEqual(52);
  });

  it("拖动方向决定搬运方向（向左拖则位移为正）", () => {
    const s = new LiquifyStroke(stripes(64, 64), {
      size: 40,
      hardness: 50,
      strength: 100,
      spacing: 10,
      mode: "push",
    });
    drag(s, 52, 12, 20);
    const i = 32 * 64 + 32;
    expect(s.field.dx[i]).toBeGreaterThan(0);
  });

  it("往外推不会啃掉画布边缘：alpha 始终实心", () => {
    const src = createRaster(32, 32, [200, 200, 200, 255]);
    const f = createField(32, 32);
    applyLiquifyOps(src, f, [{ x: 3, y: 16, radius: 14, power: 1, mode: "push", dx: -12 }]);
    const out = warp(src, f);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });

  it("可传入已有位移场接着涂，两笔的形变会累积", () => {
    const src = stripes(64, 64);
    const settings = {
      size: 40,
      hardness: 50,
      strength: 100,
      spacing: 10,
      mode: "push" as const,
    };
    const first = new LiquifyStroke(src, settings);
    drag(first, 12, 32, 10);
    first.pull();
    const carried = cloneField(first.field);

    const second = new LiquifyStroke(src, settings, { field: carried });
    drag(second, 32, 52, 10);
    second.pull();

    // 第二笔从第一笔的场继续，位移量应明显大于只用第二笔
    const alone = new LiquifyStroke(src, settings);
    drag(alone, 32, 52, 10);
    alone.pull();

    expect(maxAbs(carried)).toBeGreaterThan(maxAbs(alone.field));
  });
});
