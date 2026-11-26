import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONION,
  frameAtSeconds,
  frameSeconds,
  onionGhosts,
  thumbnailKey,
  wrapFrameIndex,
} from "../../src/core/onionSkin";

describe("洋葱皮与帧时间轴", () => {
  it("帧下标环绕，负数与超界都安全", () => {
    expect(wrapFrameIndex(-1, 5)).toBe(4);
    expect(wrapFrameIndex(7, 5)).toBe(2);
    expect(wrapFrameIndex(3, 0)).toBe(0);
  });

  it("边界不环绕：首帧没有前帧，尾帧没有后帧", () => {
    const on = { ...DEFAULT_ONION, enabled: true, prev: 2, next: 2 };
    const first = onionGhosts(5, 0, on);
    expect(first.map((g) => g.index)).toEqual([2, 1]);
    expect(first.every((g) => g.kind === "next")).toBe(true);
    const last = onionGhosts(5, 4, on);
    expect(last.map((g) => g.index)).toEqual([2, 3]);
    expect(last.every((g) => g.kind === "prev")).toBe(true);
  });

  it("颜色 / 透明度随距离衰减，越远越淡", () => {
    const ghosts = onionGhosts(8, 4, {
      ...DEFAULT_ONION,
      enabled: true,
      prev: 3,
      next: 0,
      opacity: 80,
    });
    expect(ghosts).toHaveLength(3);
    expect(ghosts.every((g) => g.kind === "prev" && g.tint === DEFAULT_ONION.colorPrev)).toBe(true);
    expect(ghosts[0].delta).toBe(3);
    expect(ghosts[0].alpha).toBeLessThan(ghosts[2].alpha);
  });

  it("只显示关键帧时按外部标记过滤", () => {
    const on = {
      ...DEFAULT_ONION,
      enabled: true,
      prev: 2,
      next: 2,
      keyframesOnly: true,
    };
    const keys = new Set([1, 3]);
    const ghosts = onionGhosts(6, 2, on, (i) => keys.has(i));
    expect(ghosts.map((g) => g.index)).toEqual([1, 3]);
  });

  it("关闭或透明度为 0 时不产生幽灵", () => {
    expect(onionGhosts(5, 2, DEFAULT_ONION)).toEqual([]);
    expect(onionGhosts(5, 2, { ...DEFAULT_ONION, enabled: true, opacity: 0 })).toEqual([]);
  });

  it("秒与帧互转，缩略图缓存键含版本", () => {
    const holds = [0.5, 0.5, 1];
    expect(frameSeconds(1, holds)).toBe(0.5);
    expect(frameSeconds(2, holds)).toBe(1);
    expect(frameAtSeconds(0.6, holds)).toBe(1);
    expect(frameAtSeconds(99, holds)).toBe(2);
    expect(thumbnailKey("vid-1", 3, 2)).toBe("strata.frame.vid-1.3.2");
  });
});
