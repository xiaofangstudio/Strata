/**
 * MCP capabilities 单一事实来源对账（防漂测试）。
 *
 * 背景：mcp/lib/capabilities.mjs 曾 19 天没跟上主程序——对外只写 PNG 导出、
 * 8 种导入、TOOLS 缺 4 个已接入的工具，版本号还挂在 2.6.2。这组测试把
 * 「声明侧」（capabilities.mjs）与「实现侧」（strata-mcp.mjs / catalog.ts /
 * image.ts / exportImage.ts）逐个对齐钉死：以后任何一侧漂移，vitest 直接红灯。
 *
 * 刻意用文本提取而不是 import mjs：capabilities.mjs 面向 Node MCP 服务，
 * 不想在 vitest 里拉起它的依赖链。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");

function read(rel: string): string {
  return readFileSync(repoRoot + rel, "utf8");
}

/** 从 capabilities.mjs 提取 `export const NAME = [...]` 块。 */
function exportBlock(source: string, name: string): string {
  const m = source.match(new RegExp(`export const ${name} = \\[[\\s\\S]*?\\n\\];`));
  if (!m) throw new Error(`capabilities.mjs 缺少 ${name}`);
  return m[0];
}

const capabilities = read("mcp/lib/capabilities.mjs");
const mcpServer = read("mcp/strata-mcp.mjs");
const catalog = read("src/tools/catalog.ts");
const imageTs = read("src/engine/image.ts");
const exportTs = read("src/engine/exportImage.ts");
const mcpPkg = JSON.parse(read("mcp/package.json"));
const mainPkg = JSON.parse(read("package.json"));

function idsOf(block: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of block.matchAll(re)) out.add(m[1]);
  return out;
}

describe("MCP capabilities 单一事实来源对账", () => {
  it("MCP_TOOLS 与 strata-mcp.mjs 实际注册的工具逐一相等", () => {
    const declared = idsOf(exportBlock(capabilities, "MCP_TOOLS"), /id: "(strata_[a-z_0-9]+)"/g);
    const registered = idsOf(mcpServer, /"(strata_[a-z_0-9]+)"/g);
    expect(registered.size, "strata-mcp.mjs 里应恰好是 60 个 strata_* 字面量").toBe(60);
    const missing = [...registered].filter((id) => !declared.has(id));
    const extra = [...declared].filter((id) => !registered.has(id));
    expect(missing, "capabilities 声明漏掉的工具").toEqual([]);
    expect(extra, "capabilities 声明了但没注册的工具").toEqual([]);
  });

  it("UI 工具目录与 src/tools/catalog.ts 一致（此前缺 smudge/shapeStar/leafPen/adjustmentBrush）", () => {
    const declared = idsOf(exportBlock(capabilities, "TOOLS"), /id: "([a-zA-Z]+)"/g);
    const real = idsOf(catalog, /\{ id: "([a-zA-Z]+)", shortcut/g);
    expect([...real].filter((id) => !declared.has(id))).toEqual([]);
    expect([...declared].filter((id) => !real.has(id))).toEqual([]);
  });

  it("IMPORT_FORMATS 覆盖 image.ts 的 IMAGE_EXTENSIONS 全量", () => {
    const extBlock = imageTs.match(/export const IMAGE_EXTENSIONS = \[[\s\S]*?\];/);
    expect(extBlock).toBeTruthy();
    const real = new Set([...extBlock![0].matchAll(/"([a-z0-9]{1,4})"/g)].map((m) => m[1]));
    const declared = idsOf(exportBlock(capabilities, "IMPORT_FORMATS"), /ext: "([a-z0-9]{1,4})"/g);
    expect([...real].filter((e) => !declared.has(e)), "capabilities 漏掉的导入扩展").toEqual([]);
    expect([...declared].filter((e) => !real.has(e)), "capabilities 多写的导入扩展").toEqual([]);
  });

  it("EXPORT_FORMATS 与 exportImage.ts 的三条落盘编码一致", () => {
    const declared = idsOf(exportBlock(capabilities, "EXPORT_FORMATS"), /id: "([a-z]+)"/g);
    const real = idsOf(exportTs, /id: "(png|jpeg|webp)"/g);
    expect([...real].filter((id) => !declared.has(id))).toEqual([]);
    expect([...declared].filter((id) => !real.has(id))).toEqual([]);
  });

  it("版本号三处一致：capabilities / mcp 包 / 主程序", () => {
    const version = capabilities.match(/export const SERVER_VERSION = "([^"]+)"/)![1];
    expect(version).toBe(mcpPkg.version);
    expect(version).toBe(mainPkg.version);
  });
});
