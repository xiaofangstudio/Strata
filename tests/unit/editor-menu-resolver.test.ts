/**
 * EditorShell 菜单 resolver 结构性回归测试。
 *
 * 背景：resolve 是一个上千行的 switch，历史上出现过 3 组重复 case
 * （window.panel.layers / window.panel.history / view.proofColors）。
 * 重复 case 在 TS 与构建期都不报错，只由 esbuild 给出 warning，
 * 但语义上后者永远是死代码 —— 曾导致「窗口面板关不掉」「色盲模拟关不掉」
 * 两个真实 bug。这里用源码结构断言把它们钉死，防止再退化。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const shellSrc = readFileSync(
  path.resolve(here, "../../src/ui/EditorShell.tsx"),
  "utf8",
);

/** 抽出 resolve switch 里全部 case 标签（只看带引号的字面量）。 */
function allCaseLabels(src: string): string[] {
  return [...src.matchAll(/^\s*case\s+"([^"]+)":/gm)].map((m) => m[1]);
}

describe("EditorShell 菜单 resolver 结构", () => {
  it("switch 里没有重复的 case 标签", () => {
    const labels = allCaseLabels(shellSrc);
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dupes, `重复 case: ${dupes.join(", ")}`).toEqual([]);
  });

  it("三个曾有问题的 id 都恰好只有一个 case", () => {
    const labels = allCaseLabels(shellSrc);
    for (const id of ["window.panel.layers", "window.panel.history", "view.proofColors"]) {
      expect(labels.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it("窗口面板走 toggleDock（可开可关），不是强制打开", () => {
    const layersBlock = shellSrc.match(
      /case "window\.panel\.layers":\s*return \{([^}]*)\}/,
    );
    expect(layersBlock).not.toBeNull();
    expect(layersBlock![1]).toContain("toggleDock(\"layers\")");
  });

  it("校样颜色总开关同时覆盖 ICC 校样与色盲模拟两套状态", () => {
    const proofColors = shellSrc.match(
      /case "view\.proofColors":\s*return \{[\s\S]*?\n\s*\};/,
    );
    expect(proofColors).not.toBeNull();
    const block = proofColors![0];
    // 色盲分支：按 proofOn 切换；ICC 分支：按 proofActive 切换
    expect(block).toMatch(/proof !== "none"/);
    expect(block).toContain("setProofOn(on)");
    expect(block).toContain("setProofActive(on)");
    expect(block).toContain("checked: proof !== \"none\" ? proofOn : proofActive");
  });

  it("Proof Setup 单选：切 ICC 关色盲、切色盲关 ICC", () => {
    // 9 个 ICC 设置项里都应带关闭色盲的调用
    const iccBlocks = [...shellSrc.matchAll(
      /case "view\.proofSetup\.(workingCmyk|workingCyanPlate|workingMagentaPlate|workingYellowPlate|workingBlackPlate|workingCmyPlate|legacyMacintoshRgb|internetStandardRgb|monitorRgb)":[\s\S]*?setProofActive\(true\);\s*setProofOn\(false\)/g,
    )];
    expect(iccBlocks).toHaveLength(9);

    for (const blind of ["protanopia", "deuteranopia"]) {
      const block = shellSrc.match(
        new RegExp(`case "view\\.proofSetup\\.colorBlindness${blind[0].toUpperCase()}${blind.slice(1)}":[\\s\\S]*?setProofOn\\(true\\);\\s*setProofActive\\(false\\)`, "i"),
      );
      expect(block, `${blind} 应关闭 ICC 校样`).not.toBeNull();
    }
  });
});
