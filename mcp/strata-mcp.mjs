#!/usr/bin/env node
/**
 * Strata MCP 服务器（stdio）。
 *
 * 让外部 AI（Claude Desktop / 任意 MCP 客户端）在不打开界面的前提下，
 * 读写 .strata 工程：查能力清单、读工程、改图层属性、增删移动复制图层、
 * 校验合法性、从「配方」直接生成一份工程。
 *
 * 设计要点：
 * 1. 单一事实来源 —— 所有数值与中文名都取自 lib/capabilities.mjs，
 *    而它又逐字对齐 src/core/layer.ts、src/tools/catalog.ts、
 *    src/i18n/zh-CN.ts、src/core/presets.ts、src/engine/image.ts、
 *    src/engine/project.ts。本文件不重复定义任何业务常量。
 * 2. 零业务逻辑 —— 校验/规范化/增删改全部调用 lib/project.mjs，
 *    与界面的落盘结果完全一致，不会出现「MCP 写出来的文件界面打不开」。
 * 3. 路径安全 —— 一律走 lib/project.mjs 的 resolveProjectPath：
 *    必须绝对路径、必须 .strata 结尾；若环境变量 STRATA_MCP_ROOT 有值，
 *    则路径必须落在该根目录内，防止越权写盘。
 *
 * 启动：
 *   node mcp/strata-mcp.mjs              # 正常服务
 *   node mcp/strata-mcp.mjs --selftest   # 自检后退出（不碰磁盘）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  buildCapabilities,
} from "./lib/capabilities.mjs";
import {
  ToolError,
  addLayerToFile,
  applyPatch,
  buildProjectFile,
  duplicateLayerInFile,
  moveLayerInFile,
  readProjectFile,
  removeLayerFromFile,
  summarizeProject,
  validateProject,
  writeProjectFile,
} from "./lib/project.mjs";

/** 把任意返回值包成 MCP 的文本结果（JSON 便于机器继续处理）。 */
function ok(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** 失败也要给出结构化原因，而不是抛异常把连接打断。 */
function fail(message, extra = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

/**
 * 统一包装工具体：把 ToolError 转成可读中文错误，
 * 其余异常照实报出（便于定位代码问题，不吞错）。
 */
function guard(fn) {
  return async (args) => {
    try {
      return await fn(args ?? {});
    } catch (e) {
      if (e instanceof ToolError) return fail(e.message);
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

/* ------------------------------------------------------------------ 公共参数 */

/** 工程路径。真正的合法性（绝对路径 / 扩展名 / 越权）由 project.mjs 负责。 */
const pathArg = z.string().describe("工程文件的绝对路径，必须以 .strata 结尾");

/** 图层序号。 */
const indexArg = z.number().int().min(0).describe("图层下标，0 是最底层");

/** 图层描述对象（宽容结构，缺字段自动补默认值，非法值会报错）。 */
const layerArg = z
  .object({
    name: z.string().optional().describe("图层名"),
    kind: z.enum(["pixel", "adjust"]).optional().describe("图层类型，默认 pixel"),
    visible: z.boolean().optional(),
    opacity: z.number().optional().describe("不透明度 0–100"),
    blend: z.string().optional().describe("混合模式 id，见 strata_capabilities"),
    locked: z.boolean().optional(),
    clip: z.boolean().optional().describe("剪贴蒙版（调整层不支持）"),
    maskActive: z.boolean().optional(),
    adjust: z
      .object({ id: z.string(), params: z.record(z.string(), z.number()).optional() })
      .passthrough()
      .optional()
      .describe("调整层参数，id 见 strata_capabilities 的 adjustTypes"),
    styles: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    surface: z.string().optional().describe("像素层底图，base64 编码的 PNG（不含 data: 前缀）"),
    mask: z.string().optional().describe("图层蒙版，base64 编码的 PNG"),
  })
  .passthrough();

/* ------------------------------------------------------------------ 工具注册 */

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

/** 实际注册过的工具名，供 --selftest 与 capabilities 比对。 */
const registered = new Set();
const rawRegister = server.registerTool.bind(server);
server.registerTool = (name, ...rest) => {
  registered.add(name);
  return rawRegister(name, ...rest);
};

server.registerTool(
  "strata_capabilities",
  {
    title: "Strata 能力清单",
    description:
      "返回 Strata 图像编辑器的完整能力字典：画布尺寸限制与预设、混合模式、" +
      "调整类型及其参数范围与默认值、图层样式、图层类型、选区模式与选区运算、" +
      "工具清单（含中文名与快捷键）、可导入导出格式、.strata 工程文件格式说明、" +
      "以及本服务器提供的工具名列表。" +
      "调用任何其它 strata_* 工具前，建议先取一次这份清单，避免凭记忆编造 id。",
    inputSchema: {},
  },
  guard(async () => ok(buildCapabilities())),
);

server.registerTool(
  "strata_read_project",
  {
    title: "读取 .strata 工程",
    description:
      "读取并解析一份 .strata 工程，返回结构化摘要：画布尺寸 / dpi / 当前图层、" +
      "每层的名称、类型、可见性、不透明度、混合模式、蒙版与剪贴状态、图层样式、" +
      "调整层的类型与参数，以及像素层底图的字节数。默认不回传像素数据（体积大），" +
      "需要时把 includePixels 置 true 才会带上 base64。",
    inputSchema: {
      path: pathArg,
      includePixels: z.boolean().optional().describe("是否回传像素 base64，默认 false"),
    },
  },
  guard(async ({ path, includePixels }) => {
    const { file, abs, bom } = readProjectFile(path);
    const summary = summarizeProject(file, includePixels === true, {
      path: abs,
      fileBytes: Buffer.byteLength(JSON.stringify(file), "utf8"),
      bomDetected: bom,
    });
    return ok(summary);
  }),
);

server.registerTool(
  "strata_write_project",
  {
    title: "写入 .strata 工程",
    description:
      "把一份 manifest 规范化后写成 .strata 工程文件。" +
      "manifest 结构：{ name, width, height, dpi?, active?, layers:[...], selection? }。" +
      "写入前会完整校验（尺寸范围、混合模式、调整类型与参数范围、像素必须是合法 PNG base64），" +
      "任何一处不合法就整体拒绝、不落盘，并逐条给出中文原因。" +
      "dryRun 为 true 时只校验并返回「将要写入的内容摘要」，不碰磁盘。",
    inputSchema: {
      path: pathArg,
      manifest: z
        .object({
          name: z.string().optional(),
          width: z.number().int(),
          height: z.number().int(),
          dpi: z.number().int().optional(),
          active: z.number().int().optional(),
          layers: z.array(layerArg),
          selection: z.string().optional().describe("选区蒙版，base64 PNG"),
        })
        .passthrough(),
      dryRun: z.boolean().optional().describe("只校验不写盘"),
    },
  },
  guard(async ({ path, manifest, dryRun }) => {
    const built = buildProjectFile(manifest);
    if (!built.ok) {
      return fail("工程不合法，已拒绝写入", { errors: built.errors, warnings: built.warnings });
    }
    // 先确认路径本身没问题（绝对路径 / .strata / 目录存在 / 越权），再决定写不写
    const preview = summarizeProject(built.file, false, { path });
    if (dryRun === true) {
      return ok({ written: false, dryRun: true, warnings: built.warnings, project: preview });
    }
    const res = writeProjectFile(path, built.file);
    return ok({
      written: true,
      path: res.abs,
      bytes: res.bytes,
      warnings: built.warnings,
      project: preview,
    });
  }),
);

server.registerTool(
  "strata_patch_layer",
  {
    title: "修改图层属性",
    description:
      "改某层的基础属性，支持字段：name / visible / opacity / blend / clip / locked / maskActive。" +
      "不允许用本工具改像素或调整参数（改像素用 strata_write_project 重写整份，" +
      "改调整参数请重建该层）。默认直接落盘；write 置 false 则只返回预览不写盘。",
    inputSchema: {
      path: pathArg,
      index: indexArg,
      patch: z
        .object({
          name: z.string().optional(),
          visible: z.boolean().optional(),
          opacity: z.number().optional().describe("0–100，越界会夹到边界并给出提示"),
          blend: z.string().optional(),
          clip: z.boolean().optional(),
          locked: z.boolean().optional(),
          maskActive: z.boolean().optional(),
        })
        .passthrough(),
      write: z.boolean().optional().describe("默认 true；false 表示只预览"),
    },
  },
  guard(async ({ path, index, patch, write }) => {
    const { file } = readProjectFile(path);
    const res = applyPatch(file, index, patch);
    if (!res.ok) return fail("修改被拒绝", { errors: res.errors, warnings: res.warnings });
    const preview = summarizeProject(res.file, false, { path });
    if (write === false) {
      return ok({ written: false, warnings: res.warnings, layer: preview.layers[index], project: preview });
    }
    const out = writeProjectFile(path, res.file);
    return ok({
      written: true,
      path: out.abs,
      bytes: out.bytes,
      warnings: res.warnings,
      layer: preview.layers[index],
    });
  }),
);

server.registerTool(
  "strata_add_layer",
  {
    title: "新增图层",
    description:
      "往工程里加一层，像素层或调整层都可以。index 缺省表示置顶；" +
      "像素层可带 surface（base64 PNG），调整层必须带 adjust。" +
      "写入前会规范化（补默认值、校验 PNG 文件头），不合法整体拒绝。",
    inputSchema: {
      path: pathArg,
      layer: layerArg,
      index: z.number().int().min(0).optional().describe("插入位置，缺省置顶"),
    },
  },
  guard(async ({ path, layer, index }) => {
    const { file } = readProjectFile(path);
    const res = addLayerToFile(file, layer, index);
    if (!res.ok) return fail("新增图层被拒绝", { errors: res.errors, warnings: res.warnings });
    const out = writeProjectFile(path, res.file);
    const preview = summarizeProject(res.file, false, { path });
    return ok({
      written: true,
      path: out.abs,
      bytes: out.bytes,
      warnings: res.warnings,
      layerCount: preview.layerCount,
      activeLayerName: preview.activeLayerName,
    });
  }),
);

server.registerTool(
  "strata_remove_layer",
  {
    title: "删除图层",
    description: "删掉指定图层。工程至少保留一层，删最后一层会被拒绝。",
    inputSchema: { path: pathArg, index: indexArg },
  },
  guard(async ({ path, index }) => {
    const { file } = readProjectFile(path);
    const res = removeLayerFromFile(file, index);
    if (!res.ok) return fail("删除被拒绝", { errors: res.errors });
    const out = writeProjectFile(path, res.file);
    return ok({
      written: true,
      path: out.abs,
      bytes: out.bytes,
      removed: res.removed ? { name: res.removed.name, kind: res.removed.kind } : null,
      layerCount: res.file.layers.length,
    });
  }),
);

server.registerTool(
  "strata_move_layer",
  {
    title: "移动图层顺序",
    description: "调整图层叠放顺序。direction 取 up（上移一层）/ down（下移一层）/ top（置顶）/ bottom（置底）。",
    inputSchema: {
      path: pathArg,
      index: indexArg,
      direction: z.enum(["up", "down", "top", "bottom"]),
    },
  },
  guard(async ({ path, index, direction }) => {
    const { file } = readProjectFile(path);
    const res = moveLayerInFile(file, index, direction);
    if (!res.ok) return fail("移动被拒绝", { errors: res.errors });
    const out = writeProjectFile(path, res.file);
    return ok({
      written: true,
      path: out.abs,
      bytes: out.bytes,
      moved: res.moved,
      from: res.from,
      to: res.to,
      warnings: res.warnings,
    });
  }),
);

server.registerTool(
  "strata_duplicate_layer",
  {
    title: "复制图层",
    description:
      "复制指定图层，副本插在原层正上方，命名沿用「原名 副本」。" +
      "复制调整层时参数一并带过去。",
    inputSchema: { path: pathArg, index: indexArg },
  },
  guard(async ({ path, index }) => {
    const { file } = readProjectFile(path);
    const res = duplicateLayerInFile(file, index);
    if (!res.ok) return fail("复制被拒绝", { errors: res.errors });
    const out = writeProjectFile(path, res.file);
    const preview = summarizeProject(res.file, false, { path });
    return ok({
      written: true,
      path: out.abs,
      bytes: out.bytes,
      copyIndex: res.copyIndex,
      copyName: preview.layers[res.copyIndex]?.name ?? null,
      layerCount: preview.layerCount,
    });
  }),
);

server.registerTool(
  "strata_validate",
  {
    title: "校验工程",
    description:
      "校验一份工程是否合法，逐条返回问题（含 level: error/warning、字段路径 path、中文 message），" +
      "并给出问题计数。二选一：给 path 从磁盘读，或给 project 直接传工程对象。" +
      "本工具只读，不写盘、不改文件。",
    inputSchema: {
      path: pathArg.optional(),
      project: z.record(z.string(), z.unknown()).optional().describe("直接传入的工程对象"),
    },
  },
  guard(async ({ path, project }) => {
    if (!path && !project) return fail("path 与 project 至少提供一个");
    if (path && project) return fail("path 与 project 只能提供一个");
    let file = project;
    let from = "project";
    let abs = null;
    if (path) {
      const r = readProjectFile(path);
      file = r.file;
      abs = r.abs;
      from = "file";
      if (r.bom) {
        // BOM 不是错误，但值得提示（工程应存为 UTF-8 无 BOM）
        const v = validateProject(file);
        v.issues.push({
          level: "warning",
          code: "bom",
          path: "",
          message: "文件带 UTF-8 BOM，建议以无 BOM 保存",
        });
        v.counts.total += 1;
        v.counts.warnings += 1;
        return ok({ source: from, path: abs, ...v });
      }
    }
    return ok({ source: from, path: abs, ...validateProject(file) });
  }),
);

server.registerTool(
  "strata_build_recipe",
  {
    title: "按配方生成工程",
    description:
      "用一段「配方」直接生成一份规范的 .strata 工程 JSON——不读盘、不写盘，" +
      "用来在内存里造工程。配方即 manifest：{ name, width, height, dpi?, active?, layers:[...], selection? }。" +
      "返回规范化后的完整工程对象（可直接交给 strata_write_project 的 manifest，" +
      "或自行落盘），以及摘要与警告。宽高请优先从 strata_capabilities 的 canvas.presets 里取。",
    inputSchema: {
      name: z.string().optional().describe("工程名，缺省「未命名」"),
      width: z.number().int(),
      height: z.number().int(),
      dpi: z.number().int().optional(),
      active: z.number().int().optional(),
      layers: z.array(layerArg).describe("图层数组，至少一层"),
      selection: z.string().optional().describe("选区蒙版，base64 PNG"),
    },
  },
  guard(async (recipe) => {
    const built = buildProjectFile(recipe);
    if (!built.ok) {
      return fail("配方不合法，无法生成工程", { errors: built.errors, warnings: built.warnings });
    }
    return ok({
      ok: true,
      warnings: built.warnings,
      project: built.file,
      summary: summarizeProject(built.file, false),
    });
  }),
);

/* ------------------------------------------------------------------ 启动 */

/** 自检：确认能力清单里声明的每个工具都真的注册上了，且常量没跑偏。 */
function selftest() {
  const declared = buildCapabilities().tools_available;
  const problems = [];
  for (const name of declared) {
    if (!registered.has(name)) problems.push(`能力清单声明了但未注册：${name}`);
  }
  for (const name of registered) {
    if (!declared.includes(name)) problems.push(`已注册但能力清单未声明：${name}`);
  }
  if (SERVER_NAME !== "strata") problems.push(`SERVER_NAME 异常：${SERVER_NAME}`);
  if (PROTOCOL_VERSION.length === 0) problems.push("PROTOCOL_VERSION 为空");
  return problems;
}

async function main() {
  if (process.argv.includes("--selftest")) {
    const problems = selftest();
    if (problems.length > 0) {
      process.stderr.write(`自检失败：\n- ${problems.join("\n- ")}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `自检通过：${SERVER_NAME} v${SERVER_VERSION}（协议 ${PROTOCOL_VERSION}），` +
        `已注册 ${registered.size} 个工具\n`,
    );
    process.exit(0);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 传输下 stdout 属于协议通道，日志一律走 stderr
  process.stderr.write(`${SERVER_NAME} MCP 服务器已就绪（协议 ${PROTOCOL_VERSION}）\n`);
}

main().catch((e) => {
  process.stderr.write(`启动失败：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
