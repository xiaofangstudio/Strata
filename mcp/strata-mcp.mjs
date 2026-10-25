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

/* ------------------------------------------------------------- 图像管线 */

/**
 * 会话里的活动图像（内存中的 RGBA）。
 *
 * 之所以要「会话」而不是每次都传 base64 来回搬：一张 4000×3000 的图
 * base64 要几十 MB，来回传带宽全耗在编码上。这里按 sessionId 缓在进程里，
 * 后续调整 / 滤镜 / 导出都只认一个短 id。
 */
import {
  ADJUSTERS,
  FILTERS,
  backgroundFloodMask,
  bilinearResize,
  compositeOver,
  cutout,
  decodeImage,
  encodeImageJpeg,
  encodeImagePng,
  inpaintFill,
  largestIsland,
  lightBeam,
  radialGlow,
  resize,
  softShadow,
  vignette,
} from "./lib/imageOps.mjs";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath, dirname, isAbsolute } from "node:path";

const sessions = new Map();
let sessionSeq = 0;

/** 图片根目录沙箱（可选）：设了就只允许读写该目录内的图片。 */
const IMAGE_ROOT = process.env.STRATA_MCP_ROOT || null;

/**
 * 解析并校验图片路径。
 * 与工程路径同一套原则：必须绝对路径、必须在沙箱内（若设了沙箱）；
 * 扩展名只用来生成一个默认名，真正的格式判断交给魔数识别。
 */
function resolveImagePath(p, mustExist) {
  if (typeof p !== "string" || p.trim() === "") {
    throw new ToolError("路径不能为空");
  }
  if (!isAbsolute(p)) {
    throw new ToolError(`路径必须是绝对路径：${p}`);
  }
  const abs = resolvePath(p);
  if (IMAGE_ROOT && !abs.startsWith(resolvePath(IMAGE_ROOT) + "\\") && !abs.startsWith(resolvePath(IMAGE_ROOT) + "/")) {
    throw new ToolError(`路径越权：必须落在 ${IMAGE_ROOT} 内（收到 ${abs}）`);
  }
  if (mustExist && !existsSync(abs)) {
    throw new ToolError(`文件不存在：${abs}`);
  }
  return abs;
}

const EXPORT_EXTS = ["png", "jpg", "jpeg", "webp"];

function extOf(p) {
  const seg = p.split(/[\\/]/).pop() ?? "";
  const dot = seg.lastIndexOf(".");
  return dot > 0 ? seg.slice(dot + 1).toLowerCase() : "";
}

/** 从会话取图，id 不对就报可读错误。 */
function sessionImage(sessionId) {
  if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
    throw new ToolError(
      `会话不存在或已过期：${sessionId}。请先用 strata_open_image 打开一张图。`,
    );
  }
  return sessions.get(sessionId);
}

server.registerTool(
  "strata_open_image",
  {
    title: "打开图片",
    description:
      "把一张 PNG / JPEG 读进内存会话，返回会话 id 与图片信息（尺寸 / 像素数 / 格式）。" +
      "后续的 strata_adjust_image / strata_filter_image / strata_export_image 都认这个会话 id。" +
      "可用 maxSide 先等比缩小（如 1600）以加快大图处理速度。",
    inputSchema: {
      path: z.string().describe("图片的绝对路径（支持 .png / .jpg / .jpeg）"),
      maxSide: z
        .number()
        .int()
        .min(16)
        .max(16384)
        .optional()
        .describe("可选：等比缩放到最长边不超过该值"),
    },
  },
  guard(async ({ path, maxSide }) => {
    const abs = resolveImagePath(path, true);
    const bytes = readFileSync(abs);
    let img = decodeImage(bytes);
    const originalWG = `${img.width}×${img.height}`;
    if (maxSide) img = resize(img, maxSide);
    sessionSeq += 1;
    const id = `img-${sessionSeq}-${Date.now().toString(36)}`;
    sessions.set(id, { img, base: img, source: abs });
    return ok({
      sessionId: id,
      source: abs,
      width: img.width,
      height: img.height,
      pixels: img.width * img.height,
      original: originalWG,
      resized: Boolean(maxSide && maxSide < Math.max(img.width, img.height)),
      hint: "后续调用请把 sessionId 带上；导出用 strata_export_image。",
    });
  }),
);

server.registerTool(
  "strata_image_info",
  {
    title: "查看会话图片信息",
    description: "返回当前会话图片的尺寸与来源路径，以及当前已存在的会话 id 列表。",
    inputSchema: {
      sessionId: z.string().optional().describe("会话 id；省略则只列出全部会话"),
    },
  },
  guard(async ({ sessionId }) => {
    if (!sessionId) {
      return ok({
        sessions: [...sessions.keys()],
        count: sessions.size,
      });
    }
    const s = sessionImage(sessionId);
    return ok({
      sessionId,
      source: s.source,
      width: s.img.width,
      height: s.img.height,
      pixels: s.img.width * s.img.height,
    });
  }),
);

server.registerTool(
  "strata_adjust_image",
  {
    title: "调色（按算子序列）",
    description:
      "对一个会话里的图按顺序施加多个调色算子。算子名必须来自 strata_capabilities 的 " +
      "imageOps.adjusters 列表（brightnessContrast / saturation / vibrance / levels / curves / " +
      "channelMixer / blackWhite / exposure / whiteBalance / hueRotate / colorBalance / " +
      "invert / grayscale / posterize / threshold）。" +
      "参数逐个写在 op 对象里，例如 {type:'saturation', amount:60}、" +
      "{type:'channelMixer', red:{r:100}, green:{}, blue:{}} 表示「只留红通道」。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      ops: z
        .array(z.object({ type: z.string() }).passthrough())
        .min(1)
        .describe("按数组顺序执行的调色算子"),
      preview: z
        .boolean()
        .optional()
        .describe("是否回传一张 320px 的 base64 PNG 预览（默认 false）"),
    },
  },
  guard(async ({ sessionId, ops, preview }) => {
    const s = sessionImage(sessionId);
    let img = s.img;
    const applied = [];
    for (const op of ops) {
      const adj = ADJUSTERS[op.type];
      if (!adj) {
        throw new ToolError(
          `未知调色算子：${op.type}。可用：${Object.keys(ADJUSTERS).join(" / ")}`,
        );
      }
      img = adj.run(img, op);
      applied.push(op.type);
    }
    s.img = img;
    const payload = {
      ok: true,
      sessionId,
      applied,
      width: img.width,
      height: img.height,
      hint: "改动还在内存里；用 strata_export_image 落盘。",
    };
    if (preview === true) {
      const small = resize(img, 320);
      payload.previewBase64 = encodeImagePng(small).toString("base64");
    }
    return ok(payload);
  }),
);

server.registerTool(
  "strata_filter_image",
  {
    title: "施加滤镜",
    description:
      "对一个会话里的图施加一个滤镜。滤镜名取自 strata_capabilities 的 imageOps.filters " +
      "（gaussianBlur / boxBlur / unsharpMask / addNoise / mosaic / median / motionBlur）。" +
      "参数写在同级对象里，例如 {filter:'gaussianBlur', radius:6}。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      filter: z.string().describe("滤镜名"),
      radius: z.number().optional(),
      amount: z.number().optional(),
      threshold: z.number().optional(),
      monochrome: z.boolean().optional(),
      seed: z.number().optional(),
      cell: z.number().optional(),
      angleDeg: z.number().optional(),
      distance: z.number().optional(),
      preview: z.boolean().optional(),
    },
  },
  guard(async (args) => {
    const s = sessionImage(args.sessionId);
    const f = FILTERS[args.filter];
    if (!f) {
      throw new ToolError(
        `未知滤镜：${args.filter}。可用：${Object.keys(FILTERS).join(" / ")}`,
      );
    }
    const img = f.run(s.img, args);
    s.img = img;
    const payload = {
      ok: true,
      sessionId: args.sessionId,
      applied: args.filter,
      width: img.width,
      height: img.height,
    };
    if (args.preview === true) {
      payload.previewBase64 = encodeImagePng(resize(img, 320)).toString("base64");
    }
    return ok(payload);
  }),
);

server.registerTool(
  "strata_export_image",
  {
    title: "导出会话图片",
    description:
      "把会话里的图落成文件。格式按扩展名自动判断（.png / .jpg / .jpeg），" +
      "JPEG 可用 quality 指定画质（默认 92）。返回落盘路径与字节数。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      path: z.string().describe("导出文件的绝对路径，扩展名决定格式"),
      quality: z.number().min(1).max(100).optional().describe("JPEG 画质，默认 92"),
    },
  },
  guard(async ({ sessionId, path, quality }) => {
    const s = sessionImage(sessionId);
    const ext = extOf(path);
    if (!EXPORT_EXTS.includes(ext)) {
      throw new ToolError(
        `导出扩展名必须是 ${EXPORT_EXTS.join(" / ")}（收到 .${ext || "无"}）`,
      );
    }
    const abs = resolveImagePath(path, false);
    const bytes =
      ext === "png" ? encodeImagePng(s.img) : encodeImageJpeg(s.img, quality ?? 92);
    writeFileSync(abs, bytes);
    return ok({
      ok: true,
      sessionId,
      path: abs,
      format: ext,
      bytes: bytes.length,
      width: s.img.width,
      height: s.img.height,
    });
  }),
);

/**
 * 一步到位的编辑：直接算子**: 打开 → 调色 → 滤镜 → 落盘。
 *
 * 做「批处理多张图」或「我只想改出来一张」时用它最省来回，
 * 内部就是把上面几个工具串起来，结果完全一样。
 */
server.registerTool(
  "strata_edit_image",
  {
    title: "一步编辑图片（打开→调色→滤镜→导出）",
    description:
      "最常用的批处理入口：给定一张源图、一串算子、一串滤镜，直接算出结果并落成文件。" +
      "不产生会话、不留中间态。ops / filters 的写法与 strata_adjust_image / " +
      "strata_filter_image 完全一致；两者都省略时等于只做格式转换 / 缩放。",
    inputSchema: {
      source: z.string().describe("源图绝对路径（PNG / JPEG）"),
      target: z.string().describe("输出文件绝对路径（扩展名决定格式）"),
      maxSide: z.number().int().min(16).max(16384).optional().describe("处理前等比缩放到最长边"),
      quality: z.number().min(1).max(100).optional().describe("JPEG 画质，默认 92"),
      ops: z.array(z.object({ type: z.string() }).passthrough()).optional().describe("调色算子序列"),
      filters: z
        .array(z.object({ filter: z.string() }).passthrough())
        .optional()
        .describe("滤镜序列"),
      preview: z.boolean().optional().describe("是否回传 320px 预览 base64"),
    },
  },
  guard(async ({ source, target, maxSide, quality, ops, filters, preview }) => {
    const src = resolveImagePath(source, true);
    let img = decodeImage(readFileSync(src));
    if (maxSide) img = resize(img, maxSide);
    const applied = { ops: [], filters: [] };

    for (const op of ops ?? []) {
      const adj = ADJUSTERS[op.type];
      if (!adj) throw new ToolError(`未知调色算子：${op.type}`);
      img = adj.run(img, op);
      applied.ops.push(op.type);
    }
    for (const spec of filters ?? []) {
      const f = FILTERS[spec.filter];
      if (!f) throw new ToolError(`未知滤镜：${spec.filter}`);
      img = f.run(img, spec);
      applied.filters.push(spec.filter);
    }

    const ext = extOf(target);
    if (!EXPORT_EXTS.includes(ext)) {
      throw new ToolError(`导出扩展名必须是 ${EXPORT_EXTS.join(" / ")}（收到 .${ext || "无"}）`);
    }
    const abs = resolveImagePath(target, false);
    const bytes = ext === "png" ? encodeImagePng(img) : encodeImageJpeg(img, quality ?? 92);
    writeFileSync(abs, bytes);

    const payload = {
      ok: true,
      source: src,
      path: abs,
      applied,
      bytes: bytes.length,
      width: img.width,
      height: img.height,
    };
    if (preview === true) {
      payload.previewBase64 = encodeImagePng(resize(img, 320)).toString("base64");
    }
    return ok(payload);
  }),
);

server.registerTool(
  "strata_image_preview",
  {
    title: "预览会话图片",
    description:
      "把会话里的图缩到指定大小并回传 base64 PNG，用于在不落盘的情况下查看效果。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      maxSide: z.number().int().min(16).max(2048).optional().describe("预览最长边，默认 320"),
    },
  },
  guard(async ({ sessionId, maxSide }) => {
    const s = sessionImage(sessionId);
    const small = resize(s.img, maxSide ?? 320);
    return ok({
      sessionId,
      width: small.width,
      height: small.height,
      base64: encodeImagePng(small).toString("base64"),
    });
  }),
);

/* --------------------------------------------------------- 合成套件工具 */

/** 会话或文件路径：合成叠层既可以是内存会话，也可以直接给一张盘上的图。 */
const overlayArg = z
  .object({
    sessionId: z.string().optional().describe("叠层来源：已有会话 id"),
    path: z.string().optional().describe("叠层来源：图片文件绝对路径"),
  })
  .describe("叠层来源，二选一");

/** 从会话或文件把 RGBA 读出来。 */
function loadOverlay(spec) {
  if (spec.sessionId) {
    return sessionImage(spec.sessionId).img;
  }
  if (spec.path) {
    const abs = resolveImagePath(spec.path, true);
    return decodeImage(readFileSync(abs));
  }
  throw new ToolError("叠层来源必须给 sessionId 或 path 之一");
}

server.registerTool(
  "strata_cutout",
  {
    title: "抠图（拆主体 / 拆背景）",
    description:
      "把图里的主体从背景里拆出来（mode=subject：背景透明、裁到主体包围盒），" +
      "或反过来把主体挖走留下背景（mode=background：主体区域自动用周边颜色填补）。" +
      "算法是边界洪水填充 + 最大连通域 + 羽化，适合背景较平整 / 浅景深的照片。" +
      "tolerance 越大背景吃得越宽（10–80，默认 28）；feather 是边缘羽化像素（默认 2）。" +
      "返回新会话。",
    inputSchema: {
      sessionId: z.string().describe("要拆解的会话 id"),
      mode: z.enum(["subject", "background"]).describe("subject=留主体，background=留背景"),
      tolerance: z.number().min(5).max(120).optional().describe("背景判定容差，默认 28"),
      feather: z.number().min(0).max(30).optional().describe("边缘羽化像素，默认 2"),
      edgeGate: z
        .number()
        .min(0)
        .max(120)
        .optional()
        .describe("边缘闸门（Sobel 梯度阈值，0=关闭）。越大越容易穿过，建议 12–24"),
      sides: z
        .string()
        .optional()
        .describe(
          "取种子的画面边：t/b/l/r 组合，默认 tlbr。留背景（mode=background）时建议用 tlr，" +
            "避免贴底边的主体被误判成背景",
        ),
      inpaint: z
        .boolean()
        .optional()
        .describe("mode=background 时是否填补主体留下的洞（默认 true）"),
    },
  },
  guard(async ({ sessionId, mode, tolerance, feather, edgeGate, sides, inpaint }) => {
    const s = sessionImage(sessionId);
    const opts = {
      tolerance: tolerance ?? 28,
      feather: feather ?? 2,
      edgeGate: edgeGate ?? 0,
      sides: sides ?? "tlbr",
    };
    let img;
    let hole = null;
    if (mode === "subject") {
      img = cutout(s.img, { ...opts, invert: false, trim: true });
    } else {
      // 背景模式：主体（最大连通域）挖掉；洞用周边色扩散填平
      const { width: w, height: h } = s.img;
      const bg = backgroundFloodMask(s.img, opts.tolerance, opts.edgeGate, opts.sides);
      const subject = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i += 1) subject[i] = bg[i] ? 0 : 1;
      hole = largestIsland(subject, w, h);
      img = cutout(s.img, { ...opts, invert: true, trim: false });
      if (inpaint !== false) {
        img = inpaintFill(img, hole, 30, 8);
      }
    }
    sessionSeq += 1;
    const id = `img-${sessionSeq}-${Date.now().toString(36)}`;
    sessions.set(id, { img, base: img, source: `${s.source}(${mode})` });
    const out = {
      ok: true,
      sessionId: id,
      mode,
      width: img.width,
      height: img.height,
    };
    if (mode === "subject") {
      out.note = "背景已透明并裁到主体；直接可作为 strata_composite 的叠层。";
    }
    return ok(out);
  }),
);

server.registerTool(
  "strata_composite",
  {
    title: "合成（把一层贴到另一层上）",
    description:
      "把叠层（另一个会话或一张盘上的图，含透明通道）贴到当前会话的图上。" +
      "overlayWidth 可指定叠层缩放后的目标宽度（等比），缺省按原尺寸。" +
      "x / y 是叠层左上角落点（画布像素坐标）。返回新会话，原图会话不受影响。",
    inputSchema: {
      sessionId: z.string().describe("底层会话 id"),
      overlay: overlayArg,
      x: z.number().int().describe("叠层左上角 x"),
      y: z.number().int().describe("叠层左上角 y"),
      overlayWidth: z.number().int().min(8).max(16384).optional().describe("叠层等比缩放到的宽度"),
      opacity: z.number().min(0).max(1).optional().describe("叠层整体不透明度，默认 1"),
    },
  },
  guard(async ({ sessionId, overlay, x, y, overlayWidth, opacity }) => {
    const s = sessionImage(sessionId);
    let ov = loadOverlay(overlay);
    if (overlayWidth && overlayWidth !== ov.width) {
      const h = Math.max(1, Math.round((ov.height * overlayWidth) / ov.width));
      ov = bilinearResize(ov, overlayWidth, h);
    }
    const img = compositeOver(s.img, ov, x, y, opacity ?? 1);
    sessionSeq += 1;
    const id = `img-${sessionSeq}-${Date.now().toString(36)}`;
    sessions.set(id, { img, base: img, source: `${s.source}+composite` });
    return ok({
      ok: true,
      sessionId: id,
      width: img.width,
      height: img.height,
      overlay: { width: ov.width, height: ov.height, at: [x, y] },
    });
  }),
);

server.registerTool(
  "strata_light",
  {
    title: "打光（光斑 / 光束 / 接触阴影 / 暗角）",
    description:
      "按顺序施加光效。type=glow（径向光斑：cx/cy/radius/color/strength）模拟主体背后的背景光；" +
      "type=beam（自然光束：side=top/left/right/bottom + color/strength）模拟窗外日光；" +
      "type=shadow（接触阴影：cx/cy/rx/ry/opacity）把合成主体钉在场景里；" +
      "type=vignette（暗角：strength）四角压暗聚焦主体。color 用 [r,g,b] 数组。逐个执行、顺序即数组顺序。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      effects: z
        .array(
          z.object({ type: z.enum(["glow", "beam", "shadow", "vignette"]) }).passthrough(),
        )
        .min(1)
        .describe("光效序列"),
      preview: z.boolean().optional().describe("是否回传 320px base64 预览"),
    },
  },
  guard(async ({ sessionId, effects, preview }) => {
    const s = sessionImage(sessionId);
    let img = s.img;
    const applied = [];
    for (const e of effects) {
      if (e.type === "glow") {
        img = radialGlow(img, e);
      } else if (e.type === "beam") {
        img = lightBeam(img, e);
      } else if (e.type === "shadow") {
        img = softShadow(img, e);
      } else if (e.type === "vignette") {
        img = vignette(img, e);
      }
      applied.push(e.type);
    }
    s.img = img;
    const payload = {
      ok: true,
      sessionId,
      applied,
      width: img.width,
      height: img.height,
    };
    if (preview === true) {
      payload.previewBase64 = encodeImagePng(resize(img, 320)).toString("base64");
    }
    return ok(payload);
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
