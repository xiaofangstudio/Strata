import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");
}

function inline(name: string, rel: string): string {
  const src = read(rel);
  const match = src.match(new RegExp(`export const ${name} = \`([\\s\\S]*)\`;`));
  expect(match, `${rel} 里必须有 ${name} 模板字符串`).not.toBeNull();
  return match![1];
}

describe("WGSL 运行时副本与可读副本", () => {
  it("compose.wgsl 两份文本逐字一致", () => {
    expect(inline("COMPOSE_WGSL", "src/engine/gpu/compose.wgsl.ts").trim()).toBe(
      read("shaders/compose.wgsl").trim(),
    );
  });

  it("adjust.wgsl 两份文本逐字一致", () => {
    expect(inline("ADJUST_WGSL", "src/engine/gpu/adjust.wgsl.ts").trim()).toBe(
      read("shaders/adjust.wgsl").trim(),
    );
  });

  it("端到端对拍覆盖全部 28 个 shader id", () => {
    const e2e = read("tests/e2e/webgpu-compose.mjs");
    expect(e2e).toContain("const MODES = Array.from({ length: 28 }");
    expect(e2e).toContain('requestAdapter()');
    expect(e2e).toContain('createShaderModule');
  });
});
