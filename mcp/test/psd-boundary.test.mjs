/**
 * PSD 边界测试：证明「为什么 MCP 不提供 PSD 工具」。
 *
 * src/engine/psd.ts 的读写桥接层依赖浏览器 canvas（surface.ts 的
 * document.createElement、drawImage、getImageData），而 MCP 是独立的
 * Node 进程，没有 DOM。本测试用 esbuild 把 psd.ts 按 Node 平台打包
 * （打包能过 —— 它不 import Tauri），然后真的调用一次导出函数，
 * 证明运行时必炸，从而把 README「PSD 依赖浏览器 API，MCP 不提供」
 * 的说法钉在可执行的证据上。
 *
 * 运行：node mcp/test/psd-boundary.test.mjs（需在仓库根目录，esbuild 来自根依赖）
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`通过：${name}\n`);
  } catch (e) {
    failures += 1;
    process.stderr.write(`失败：${name}\n  ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/* 第 1 步：打包能成功（psd.ts 不 import Tauri，esbuild 不报错）。 */
const tmp = mkdtempSync(join(tmpdir(), "strata-psd-boundary-"));
const outfile = join(tmp, "psd.bundle.mjs");
await build({
  stdin: {
    contents: `export { readNode, isPsdPath, PSD_EXTENSION } from "${join(root, "src/engine/psd.ts").replace(/\\/g, "/")}";`,
    resolveDir: root,
  },
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "silent",
});

/* 第 2 步：运行时依赖 DOM —— 调 readNode 建像素层必走 document.createElement。 */
const psd = await import(pathToFileURL(outfile).href);

check("isPsdPath 是纯字符串判断（这部分不依赖 DOM）", () => {
  if (!psd.isPsdPath("a/b.psd")) throw new Error("isPsdPath(.psd) 应为 true");
  if (psd.isPsdPath("a/b.strata")) throw new Error("isPsdPath(.strata) 应为 false");
});

check("readNode 在 Node 里必然抛错（缺 document / canvas）", () => {
  // 一个最普通的像素层节点：readNode 会 createLayer → createSurface → document
  const node = { name: "像素层", left: 0, top: 0, right: 4, bottom: 4 };
  let err = null;
  try {
    psd.readNode(node, 4, 4, null, []);
  } catch (e) {
    err = e;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (!err) throw new Error("readNode 竟然成功了 —— 若如此应重新评估能否提供 PSD 工具");
  if (!/document|createElement|Canvas|canvas/i.test(msg)) {
    throw new Error(`抛错原因与 DOM 无关，需人工复查：${msg}`);
  }
  process.stdout.write(`  运行时报错（预期）：${msg}\n`);
});

rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  process.stderr.write(`psd-boundary：${failures} 项失败\n`);
  process.exit(1);
}
process.stdout.write("psd-boundary：确认 psd.ts 依赖浏览器 API，MCP 不提供 PSD 工具（见 README 能力边界）\n");
