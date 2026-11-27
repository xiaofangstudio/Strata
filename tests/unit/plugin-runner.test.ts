import { describe, expect, it, vi } from "vitest";
import type { StrataDoc } from "../../src/core/document";
import { runPluginAction } from "../../src/core/pluginRunner";

const ALL = ["document.read", "document.modify", "file.write"];

function doc(): StrataDoc {
  return {
    id: "doc-test",
    name: "测试",
    width: 100,
    height: 80,
    layers: [],
    activeLayerId: "missing",
  };
}

const noopDeps = { onExportPng: async () => {} };

describe("插件白名单执行器", () => {
  it("只读命令不改文档", async () => {
    const result = await runPluginAction(
      doc(),
      { command: "document.info" },
      ALL,
      noopDeps,
    );
    expect(result.doc).toBeNull();
    expect(result.message).toContain("100");
    expect(result.message).toContain("80");
  });

  it("缩放命令真的改尺寸", async () => {
    const result = await runPluginAction(
      doc(),
      { command: "document.scale", params: { percent: 200 } },
      ALL,
      noopDeps,
    );
    expect(result.doc?.width).toBe(200);
    expect(result.doc?.height).toBe(160);
    expect(result.doc?.dirty).toBe(true);
  });

  it("旋转 / 翻转走宿主引擎", async () => {
    const rotated = await runPluginAction(doc(), { command: "document.rotateHalf" }, ALL, noopDeps);
    // 180° 不改变画布外接矩形，但必须真的走一次引擎并标脏。
    expect([rotated.doc?.width, rotated.doc?.height]).toEqual([100, 80]);
    expect(rotated.doc?.dirty).toBe(true);

    const flipped = await runPluginAction(
      doc(),
      { command: "document.flip", params: { axis: "v" } },
      ALL,
      noopDeps,
    );
    expect([flipped.doc?.width, flipped.doc?.height]).toEqual([100, 80]);
  });

  it("导出命令必须走宿主保存框回调", async () => {
    const onExportPng = vi.fn(async () => {});
    const result = await runPluginAction(
      doc(),
      { command: "file.exportPng" },
      ALL,
      { onExportPng },
    );
    expect(onExportPng).toHaveBeenCalledOnce();
    expect(result.doc).toBeNull();
  });

  it("权限不足与坏参数都直接拒绝，不静默跳过", async () => {
    await expect(
      runPluginAction(doc(), { command: "document.info" }, [], noopDeps),
    ).rejects.toThrow(/document\.info/);

    await expect(
      runPluginAction(
        doc(),
        { command: "document.scale", params: { percent: 0 } },
        ALL,
        noopDeps,
      ),
    ).rejects.toThrow(/1%/);

    await expect(
      runPluginAction(
        doc(),
        { command: "document.addAdjustment", params: { kind: "not-real" } },
        ALL,
        noopDeps,
      ),
    ).rejects.toThrow();

    await expect(
      runPluginAction(
        doc(),
        { command: "document.flip", params: { axis: "diagonal" } },
        ALL,
        noopDeps,
      ),
    ).rejects.toThrow();

    await expect(
      runPluginAction(doc(), { command: "document.rasterizeSmart" }, ALL, noopDeps),
    ).rejects.toThrow();
  });
});
