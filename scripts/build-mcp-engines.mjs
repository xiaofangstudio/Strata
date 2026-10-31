/**
 * 把 src 里的纯算法模块打包成 MCP 可用的 ESM 包。
 *
 * 为什么要有这一步：MCP 服务器是独立的 Node 进程（零构建、直接跑 .mjs），
 * 而算法写在 TypeScript 里。与其在 mcp/lib 里抄一份（必然漂移），不如用
 * esbuild 把「不依赖 DOM 的纯函数」原样打成一个文件，界面与 MCP 共用同一份实现。
 *
 * 用法：
 *   node scripts/build-mcp-engines.mjs
 *   npm run mcp:engines        （同一条）
 *
 * 产出 mcp/lib/engines.gen.mjs —— **自动生成，勿手改**。
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outfile = resolve(root, "mcp/lib/engines.gen.mjs");

const header = `/**
 * 自动生成 —— 请勿手改！
 *
 * 由 scripts/build-mcp-engines.mjs 从 scripts/mcp-engines-entry.ts 打包而来。
 * 改算法请改 src/，然后执行：npm run mcp:engines
 *
 * 内容：滤镜注册表（FILTER_DEFS）、颜色模式、接缝雕刻、MLS 变形、
 * 智能选区判定、自动对齐、色彩配置文件换算。
 * 全部是「RGBA 字节数组进 / 出」的纯函数，界面与 MCP 共用同一份实现。
 */
`;

await build({
  entryPoints: [resolve(root, "scripts/mcp-engines-entry.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  legalComments: "none",
  logLevel: "warning",
  banner: { js: header },
});

const text = readFileSync(outfile, "utf8");
writeFileSync(outfile, text, "utf8");
const kb = (text.length / 1024).toFixed(1);
process.stdout.write(`已生成 ${outfile}（${kb} KB）\n`);
