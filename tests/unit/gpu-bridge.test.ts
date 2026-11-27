import { describe, expect, it } from "vitest";
import type { StrataLayer } from "../../src/core/layer";
import { gpuCanComposeLayers } from "../../src/engine/gpuBridge";

function layer(patch: Partial<StrataLayer> = {}): StrataLayer {
  return {
    id: "l",
    kind: "pixel",
    name: "图层",
    visible: true,
    opacity: 100,
    blend: "normal",
    x: 0,
    y: 0,
    mask: null,
    maskActive: false,
    clip: false,
    styles: [],
    surface: { width: 10, height: 8 },
    ...patch,
  } as unknown as StrataLayer;
}

describe("GPU 主合成资格判定", () => {
  it("接受干净的纯像素层", () => {
    expect(gpuCanComposeLayers([layer()], 10, 8)).toBe(true);
  });

  it("拒绝调整层 / 组层", () => {
    expect(gpuCanComposeLayers([layer({ kind: "adjust" })], 10, 8)).toBe(false);
    expect(gpuCanComposeLayers([layer({ kind: "group" })], 10, 8)).toBe(false);
  });

  it("拒绝会改变像素语义的结构", () => {
    expect(gpuCanComposeLayers([layer({ mask: {} as HTMLCanvasElement, maskActive: true })], 10, 8)).toBe(false);
    expect(gpuCanComposeLayers([layer({ clip: true })], 10, 8)).toBe(false);
    expect(gpuCanComposeLayers([layer({ styles: [{ id: "dropShadow", enabled: true }] })] as never, 10, 8)).toBe(false);
    expect(gpuCanComposeLayers([layer({ blendIf: { enabled: true, thisBlack: 20, thisWhite: 255, underBlack: 0, underWhite: 255 } })] as never, 10, 8)).toBe(false);
  });

  it("关闭的蒙版与图层样式不阻挡 GPU", () => {
    expect(gpuCanComposeLayers([layer({ mask: {} as HTMLCanvasElement, maskActive: false })], 10, 8)).toBe(true);
    expect(gpuCanComposeLayers([layer({ styles: [{ id: "dropShadow", enabled: false }] })] as never, 10, 8)).toBe(true);
  });

  it("拒绝未知混合模式与尺寸不符", () => {
    expect(gpuCanComposeLayers([layer({ blend: "not-a-blend" as never })], 10, 8)).toBe(false);
    expect(gpuCanComposeLayers([layer()], 11, 8)).toBe(false);
  });
});
