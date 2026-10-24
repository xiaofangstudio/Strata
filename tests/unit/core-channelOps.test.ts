/**
 * 通道系统单测（node 环境纯数学 + 纯函数）。
 *
 * 通道运算：加盖 PS 语义 —— 相加 = 并集取大、相减 = 差集、交叠 = 交集取小。
 * 测试用小尺寸 alpha 数组，直接比对逐格数值，防止后续重构悄悄改坏语义。
 *
 * 算法参考 PhotoCraft `engine/channel_cmds.rs`，MIT / Apache-2.0。
 */
import { describe, expect, it } from "vitest";
import { combineChannelData, nextChannelName } from "../../src/core/channelOps";

/**
 * 造一条纯 alpha 数组（长度 = n×4）。RGB 一律写 255，与「白底 + alpha 选中程度」的
 * 选区口径一致。
 */
function alphaMask(values: number[]): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => {
    buf[i * 4] = 255;
    buf[i * 4 + 1] = 255;
    buf[i * 4 + 2] = 255;
    buf[i * 4 + 3] = v;
  });
  return buf;
}

/** 取回 alpha 序列，方便断言。 */
function readAlpha(buf: Uint8ClampedArray): number[] {
  const out: number[] = [];
  for (let i = 3; i < buf.length; i += 4) out.push(buf[i]);
  return out;
}

describe("combineChannelData", () => {
  const a = alphaMask([0, 100, 200, 255]);
  const b = alphaMask([255, 150, 60, 0]);

  it("相加 = 取大（并集）", () => {
    expect(readAlpha(combineChannelData(a, b, "add"))).toEqual([255, 150, 200, 255]);
  });

  it("相减 = 差值且不产生负数", () => {
    // 0-255 → 0；100-150 → 0；200-60 → 140；255-0 → 255
    expect(readAlpha(combineChannelData(a, b, "subtract"))).toEqual([0, 0, 140, 255]);
  });

  it("交叠 = 取小（交集）", () => {
    expect(readAlpha(combineChannelData(a, b, "intersect"))).toEqual([0, 100, 60, 0]);
  });

  it("源 1 反相后再相加", () => {
    // (255-0)&255 → 255；255-100=155 vs 150 → 155；255-200=55 vs 60 → 60；255-255=0 vs 0 → 0
    expect(readAlpha(combineChannelData(a, b, "add", true, false))).toEqual([255, 155, 60, 0]);
  });

  it("结果反相", () => {
    expect(readAlpha(combineChannelData(a, b, "intersect", false, false, true))).toEqual([
      255, 155, 195, 255,
    ]);
  });

  it("输出 RGB 恒为白、长度不变", () => {
    const out = combineChannelData(a, b, "add");
    expect(out.length).toBe(a.length);
    for (let i = 0; i < out.length; i += 4) {
      expect(out[i]).toBe(255);
      expect(out[i + 1]).toBe(255);
      expect(out[i + 2]).toBe(255);
    }
  });

  it("不改原数组", () => {
    combineChannelData(a, b, "add");
    expect(readAlpha(a)).toEqual([0, 100, 200, 255]);
    expect(readAlpha(b)).toEqual([255, 150, 60, 0]);
  });
});

describe("nextChannelName", () => {
  const fakeDoc = (names: string[]) =>
    ({
      alphaChannels: names.map((n, i) => ({ id: `c${i}`, name: n, mask: null as never })),
    }) as never;

  it("空文档给出 Alpha 1", () => {
    expect(nextChannelName(fakeDoc([]))).toBe("Alpha 1");
  });

  it("跳过已占用的编号", () => {
    expect(nextChannelName(fakeDoc(["Alpha 1", "Alpha 2"]))).toBe("Alpha 3");
  });

  it("自定义前缀也按序号递增", () => {
    expect(nextChannelName(fakeDoc(["运算 1"]), "运算")).toBe("运算 2");
  });
});
