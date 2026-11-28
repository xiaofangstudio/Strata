/**
 * PS 教程验收回归：图层切换与 Ctrl+点击缩略图载入选区。
 *
 * 这两处都不是算法 bug，而是「接线 bug」：功能都在 core 里，但 UI 曾经只改
 * 预览 ref、不改文档状态，或者压根没给缩略图挂点击。项目刻意不引入 jsdom，
 * 因此这里用源码契约守住接线，防止以后重构又把入口接回去。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const readSrc = (rel: string): string =>
  readFileSync(resolve(root, rel), "utf8");

const layersPanel = readSrc("src/ui/components/LayersPanel.tsx");
const editorShell = readSrc("src/ui/EditorShell.tsx");

describe("图层行点击必须写回文档状态", () => {
  it("图层行 onClick 走 onSelectLayer，不再走只改预览 ref 的 onPreview", () => {
    expect(layersPanel).toMatch(/onClick=\{\(\) => onSelectLayer\(layer\.id\)\}/);
    expect(layersPanel).not.toMatch(/onClick=\{\(\) => onPreview\(selectLayer\(doc, layer\.id\)\)\}/);
  });

  it("EditorShell 把 onSelectLayer 接到 App 的 onPreview（写 docs、不入撤销栈）", () => {
    expect(editorShell).toMatch(/onSelectLayer=\{\(id\) => \{/);
    expect(editorShell).toMatch(/onPreview\(selectLayer\(doc, id\)\)/);
  });
});

describe("PS 图层样式「填充」入口", () => {
  it("图层面板有独立的填充滑杆，拖动走预览、松手走 setFillOpacity", () => {
    expect(layersPanel).toMatch(/setFillOpacity\(doc, cur\.id, v\)/);
    expect(layersPanel).toMatch(/zh\.layers\.fillOpacity/);
  });

  it("合成器把填充不透明度只乘到本层像素上，不动样式", () => {
    const styles = readSrc("src/engine/styles.ts");
    expect(styles).toMatch(/layer\.fillOpacity \?\? 100/);
    expect(styles).toMatch(/blendInto\(ctx, src, fillAlpha, layer\.blend\)/);
    const gpuBridge = readSrc("src/engine/gpuBridge.ts");
    expect(gpuBridge).toMatch(/fillOpacity \?\? 100/);
  });
});

describe("Ctrl+点击缩略图载入选区接线", () => {
  it("图层缩略图把图层透明度交给 layerToSelection", () => {
    expect(layersPanel).toMatch(/layerToSelection\(doc, layer\.id\)/);
    expect(layersPanel).toMatch(/onClick=\{onLoadSelection\}/);
  });

  it("蒙版缩略图把蒙版像素克隆成选区", () => {
    expect(layersPanel).toMatch(/cloneSurface\(layer\.mask\)/);
    expect(layersPanel).toMatch(/onLoadSelection=\{loadMaskSelection\}/);
  });

  it("修饰键语义要求 Ctrl/Cmd，并区分加选 / 减选 / 交叠", () => {
    expect(layersPanel).toMatch(/function thumbnailSelectionMode/);
    expect(layersPanel).toMatch(/if \(!\(e\.ctrlKey \|\| e\.metaKey\)\) return null/);
    expect(layersPanel).toMatch(/return "intersect"/);
    expect(layersPanel).toMatch(/return "add"/);
    expect(layersPanel).toMatch(/return "subtract"/);
  });
});
