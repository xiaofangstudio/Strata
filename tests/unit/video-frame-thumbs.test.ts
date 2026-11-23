import { describe, expect, it } from "vitest";
import { sampleFrameIndices } from "../../src/core/videoLayer";

describe("sampleFrameIndices", () => {
  it("帧数不足时全部返回，顺序正确", () => {
    expect(sampleFrameIndices(3, 1, 5)).toEqual([0, 1, 2]);
  });

  it("均匀取样并始终包含首尾和当前帧", () => {
    const got = sampleFrameIndices(100, 73, 5);
    expect(got).toHaveLength(5);
    expect(got[0]).toBe(0);
    expect(got[4]).toBe(99);
    expect(got).toContain(73);
    for (let i = 1; i < got.length; i += 1) expect(got[i]).toBeGreaterThan(got[i - 1]);
  });

  it("当前帧在边缘时也保持首尾", () => {
    expect(sampleFrameIndices(10, 0, 4)).toEqual([0, 3, 6, 9]);
    expect(sampleFrameIndices(10, 9, 4)).toEqual([0, 3, 6, 9]);
  });

  it("空帧序列 / 只取一帧时安全", () => {
    expect(sampleFrameIndices(0, 0, 5)).toEqual([]);
    expect(sampleFrameIndices(12, 8, 1)).toEqual([8]);
  });
});
