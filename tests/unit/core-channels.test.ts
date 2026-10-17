/**
 * `src/core/channels.ts` 的纯逻辑契约。
 *
 * 通道是**派生视图**：面板一个像素都不改，所有像素运算都先落到
 * `applyChannelViewToBuffer` / `channelGrayToBuffer` / `channelMaskToBuffer`
 * 这几支纯函数上，画布只是薄壳。测试正围绕这层纯函数 —— 直接用一小段
 * RGBA 缓冲喂进去、原样读回来，逐字节断言；只有涉及画布的入口
 * （applyChannelView / channelThumb / channelToSelection）才用最小 DOM 替身，
 * 且只验证**控制流**（是否真的去读写了画布、几何是否居中），不验证任何
 * 像素结果 —— 替身不做真实光栅化，像素正确性属于运行时与人工验收。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHANNEL_ORDER,
  DEFAULT_CHANNEL_VIS,
  applyChannelView,
  applyChannelViewToBuffer,
  channelGrayToBuffer,
  channelMaskToBuffer,
  channelThumb,
  channelToSelection,
  channelValue,
  isChannelViewDefault,
  toggleChannelVis,
  type ChannelId,
  type ChannelVis,
} from "../../src/core/channels";
import {
  StubCanvas,
  drawCalls,
  installDomStub,
  type DomStub,
} from "../helpers/canvas";

let dom: DomStub;

beforeAll(() => {
  dom = installDomStub();
});
afterAll(() => {
  dom.restore();
});

/** 测试用的「源画布」：替身不做光栅化，只当作一个可绘制的对象传进 drawImage。 */
const canvas = (w: number, h: number): HTMLCanvasElement =>
  new StubCanvas(w, h) as unknown as HTMLCanvasElement;

/** 取画布上记录的调用名序列（替身记录 putImageData 等）。 */
const callsOf = (c: HTMLCanvasElement): string[] =>
  (c.getContext("2d") as unknown as { calls: string[] }).calls;

/** 造一段 RGBA 缓冲，参数按 [r,g,b,a, r,g,b,a, …] 平铺。 */
const rgba = (...bytes: number[]): Uint8ClampedArray => new Uint8ClampedArray(bytes);

/** 整段缓冲拆成逐像素的 [r,g,b,a]，便于断言。 */
const pixels = (p: Uint8ClampedArray): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < p.length; i += 4) out.push([p[i], p[i + 1], p[i + 2], p[i + 3]]);
  return out;
};

describe("通道清单", () => {
  it("顺序固定为 复合 → 红 → 绿 → 蓝 → 透明度", () => {
    expect(CHANNEL_ORDER).toEqual(["rgb", "red", "green", "blue", "alpha"]);
  });

  it("默认视图四个通道全开", () => {
    expect(DEFAULT_CHANNEL_VIS).toEqual({
      red: true,
      green: true,
      blue: true,
      alpha: true,
    });
  });
});

describe("channelValue", () => {
  it("原色通道直接取对应分量", () => {
    expect(channelValue(10, 20, 30, 40, "red")).toBe(10);
    expect(channelValue(10, 20, 30, 40, "green")).toBe(20);
    expect(channelValue(10, 20, 30, 40, "blue")).toBe(30);
    expect(channelValue(10, 20, 30, 40, "alpha")).toBe(40);
  });

  it("复合通道取 Rec.601 亮度并四舍五入", () => {
    // 0.299*10 + 0.587*20 + 0.114*30 = 18.15 → 18
    expect(channelValue(10, 20, 30, 40, "rgb")).toBe(18);
    expect(channelValue(255, 0, 0, 255, "rgb")).toBe(76);
    expect(channelValue(0, 255, 0, 255, "rgb")).toBe(150);
    expect(channelValue(0, 0, 255, 255, "rgb")).toBe(29);
  });
});

describe("isChannelViewDefault", () => {
  it("只有在 rgb 且四通道全开时才算默认", () => {
    expect(isChannelViewDefault(DEFAULT_CHANNEL_VIS, "rgb")).toBe(true);
  });

  it("单独查看某个通道就不再是默认", () => {
    for (const id of ["red", "green", "blue", "alpha"] as ChannelId[]) {
      expect(isChannelViewDefault(DEFAULT_CHANNEL_VIS, id)).toBe(false);
    }
  });

  it("任一通道被关掉都不是默认", () => {
    const off = (id: keyof ChannelVis): ChannelVis => ({
      ...DEFAULT_CHANNEL_VIS,
      [id]: false,
    });
    for (const id of ["red", "green", "blue", "alpha"] as (keyof ChannelVis)[]) {
      expect(isChannelViewDefault(off(id), "rgb")).toBe(false);
    }
  });
});

describe("toggleChannelVis", () => {
  it("逐个通道翻转，且不碰其它通道", () => {
    expect(toggleChannelVis(DEFAULT_CHANNEL_VIS, "red")).toEqual({
      red: false,
      green: true,
      blue: true,
      alpha: true,
    });
    expect(toggleChannelVis(DEFAULT_CHANNEL_VIS, "alpha")).toEqual({
      red: true,
      green: true,
      blue: true,
      alpha: false,
    });
  });

  it("不改入参（纯函数）", () => {
    const before = { ...DEFAULT_CHANNEL_VIS };
    toggleChannelVis(before, "green");
    expect(before).toEqual(DEFAULT_CHANNEL_VIS);
  });

  it("复合通道是三原色总开关：全亮则一起关，否则一起开", () => {
    const allOff = toggleChannelVis(DEFAULT_CHANNEL_VIS, "rgb");
    expect(allOff).toEqual({ red: false, green: false, blue: false, alpha: true });
    expect(toggleChannelVis(allOff, "rgb")).toEqual({
      red: true,
      green: true,
      blue: true,
      alpha: true,
    });

    // 只亮一个也算「没全开」→ 点复合通道应把三个全打开
    const partial = toggleChannelVis(allOff, "red");
    expect(partial).toEqual({ red: true, green: false, blue: false, alpha: true });
    expect(toggleChannelVis(partial, "rgb")).toEqual({
      red: true,
      green: true,
      blue: true,
      alpha: true,
    });
  });

  it("复合通道不动透明度", () => {
    const off = toggleChannelVis(DEFAULT_CHANNEL_VIS, "alpha");
    expect(toggleChannelVis(off, "rgb").alpha).toBe(false);
  });
});

describe("applyChannelViewToBuffer · 合成模式", () => {
  it("全开时原样不动", () => {
    const p = rgba(1, 2, 3, 4, 250, 251, 252, 253);
    applyChannelViewToBuffer(p, DEFAULT_CHANNEL_VIS, "rgb");
    expect(pixels(p)).toEqual([
      [1, 2, 3, 4],
      [250, 251, 252, 253],
    ]);
  });

  it("关掉红，红分量归零、其余不动（画面偏青）", () => {
    const p = rgba(200, 100, 50, 255);
    applyChannelViewToBuffer(p, { ...DEFAULT_CHANNEL_VIS, red: false }, "rgb");
    expect(pixels(p)).toEqual([[0, 100, 50, 255]]);
  });

  it("关掉透明度时按 255 处理，当不透明看", () => {
    const p = rgba(10, 20, 30, 0);
    applyChannelViewToBuffer(p, { ...DEFAULT_CHANNEL_VIS, alpha: false }, "rgb");
    expect(pixels(p)).toEqual([[10, 20, 30, 255]]);
  });

  it("一次处理多像素、原位改写", () => {
    const p = rgba(1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3);
    applyChannelViewToBuffer(
      p,
      { red: false, green: false, blue: false, alpha: false },
      "rgb",
    );
    expect(pixels(p)).toEqual([
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    ]);
  });
});

describe("applyChannelViewToBuffer · 单通道模式", () => {
  it("整幅换成该通道灰度并强制不透明", () => {
    const p = rgba(200, 100, 50, 128);
    applyChannelViewToBuffer(p, DEFAULT_CHANNEL_VIS, "red");
    expect(pixels(p)).toEqual([[200, 200, 200, 255]]);
  });

  it("透明度通道用 alpha 值当灰度（透明处即纯黑）", () => {
    const p = rgba(9, 9, 9, 0, 9, 9, 9, 128);
    applyChannelViewToBuffer(p, DEFAULT_CHANNEL_VIS, "alpha");
    expect(pixels(p)).toEqual([
      [0, 0, 0, 255],
      [128, 128, 128, 255],
    ]);
  });

  it("单独查看时忽略通道开关（视图优先）", () => {
    const p = rgba(100, 150, 200, 255);
    applyChannelViewToBuffer(
      p,
      { red: false, green: false, blue: false, alpha: false },
      "blue",
    );
    expect(pixels(p)).toEqual([[200, 200, 200, 255]]);
  });
});

describe("channelGrayToBuffer", () => {
  it("改写 rgb 三通道为灰度、保留 alpha", () => {
    const p = rgba(200, 100, 50, 77);
    channelGrayToBuffer(p, "green");
    expect(pixels(p)).toEqual([[100, 100, 100, 77]]);
  });

  it("复合通道用亮度", () => {
    const p = rgba(10, 20, 30, 255);
    channelGrayToBuffer(p, "rgb");
    expect(pixels(p)).toEqual([[18, 18, 18, 255]]);
  });
});

describe("channelMaskToBuffer", () => {
  it("白底 + 通道值写进 alpha（载入通道作为选区）", () => {
    const p = rgba(200, 100, 50, 255);
    channelMaskToBuffer(p, "green");
    expect(pixels(p)).toEqual([[255, 255, 255, 100]]);
  });

  it("透明度通道载入后 alpha 就是原 alpha", () => {
    const p = rgba(1, 2, 3, 64);
    channelMaskToBuffer(p, "alpha");
    expect(pixels(p)).toEqual([[255, 255, 255, 64]]);
  });
});

describe("画布入口（只验控制流与几何）", () => {
  it("applyChannelView 默认态直接跳过，不写回画布", () => {
    const c = canvas(2, 2);
    applyChannelView(c, DEFAULT_CHANNEL_VIS, "rgb");
    expect(callsOf(c)).not.toContain("putImageData");
  });

  it("applyChannelView 非默认态读改写回整张画布", () => {
    const c = canvas(2, 2);
    applyChannelView(c, DEFAULT_CHANNEL_VIS, "red");
    expect(callsOf(c)).toContain("putImageData");
  });

  it("channelThumb 等比居中绘制到 size×size", () => {
    const src = canvas(20, 10);
    const out = channelThumb(src, "rgb", 36);
    expect(out.width).toBe(36);
    expect(out.height).toBe(36);
    const drawn = drawCalls(out);
    expect(drawn).toHaveLength(1);
    // 20×10 等比缩进 36×36：k=1.8 → 36×18，垂直居中 y=(36-18)/2=9
    expect(drawn[0]).toEqual([src, 0, 9, 36, 18]);
  });

  it("channelThumb 只在单通道时回写灰度，复合通道保持彩色", () => {
    const src = canvas(20, 10);
    const color = channelThumb(src, "rgb", 40);
    expect(callsOf(color)).not.toContain("putImageData");

    const mono = channelThumb(src, "blue", 40);
    expect(callsOf(mono)).toContain("putImageData");
  });

  it("channelThumb 对空尺寸源图直接返回空白，不绘制", () => {
    const out = channelThumb(canvas(0, 0), "red", 36);
    expect(out.width).toBe(36);
    expect(out.height).toBe(36);
    expect(drawCalls(out)).toHaveLength(0);
  });

  it("channelToSelection 产出与源同尺寸的遮罩并写回", () => {
    const mask = channelToSelection(canvas(8, 6), "red");
    expect(mask.width).toBe(8);
    expect(mask.height).toBe(6);
    expect(callsOf(mask)).toContain("putImageData");
  });
});
