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
  BLEND_IDS,
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
  backgroundFloodMask,
  bilinearResize,
  crop as cropImage,
  glossLayer,
  outerContour,
  rotateImage,
  compositeOver,
  cutout,
  decodeImage,
  encodeImageJpeg,
  gaussianBlur,
  encodeImagePng,
  inpaintFill,
  largestIsland,
  lightBeam,
  radialGlow,
  resize,
  softShadow,
  strokeRingDashed,
  vignette,
} from "./lib/imageOps.mjs";
import {
  FILTER_DEFS,
  PROFILE_LABELS,
  colorRangeHit,
  contentAwareScale,
  convertProfile,
  focusHit,
  medianCutPalette,
  mlsWarp,
  skyHit,
  subjectHit,
  toBitmap,
  toCmyk,
  toDuotone,
  toIndexed,
  toLab,
} from "./lib/engines.gen.mjs";

/** 滤镜 id → 定义（含参数表与内核）。索引一次，供工具与能力清单共用。 */
const FILTER_BY_ID = new Map(FILTER_DEFS.map((d) => [d.id, d]));

/** 老工具里的短名 → 新注册表 id（保持向后兼容）。 */
const FILTER_ALIASES = {
  gaussianBlur: "filter.blur.gaussianBlur",
  boxBlur: "filter.blur.boxBlur",
  unsharpMask: "filter.sharpen.unsharpMask",
  addNoise: "filter.noise.addNoise",
  mosaic: "filter.pixelate.mosaic",
  median: "filter.noise.median",
  motionBlur: "filter.blur.motionBlur",
};

/** 按 id 或短名取滤镜定义。 */
function findFilter(name) {
  const id = FILTER_ALIASES[name] ?? name;
  return FILTER_BY_ID.get(id) ?? null;
}

/** 图片会话里的图就是 {width,height,data}，与内核的 RgbaBuffer 同构，直接传。 */
function applyFilterToSession(img, def, params) {
  const merged = {};
  for (const p of def.params) merged[p.id] = p.def;
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) merged[k] = v;
  }
  return def.apply(img, merged);
}

/** 0/1 命中表 → 可视化蒙版（白 = 选中）。 */
function hitToMask(hit, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const v = hit[i] ? 255 : 0;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
import {
  BLEND_MODES,
  addLayer,
  createDoc,
  flatten,
  layerIndex,
  mixByMask,
  regionMask,
  replaceLayer,
  summarizeDoc,
} from "./lib/doc.mjs";
import {
  renderEllipse,
  renderGlass,
  renderGradient,
  renderPath,
  renderRadialGlow,
  renderRect,
  renderText,
} from "./lib/draw.mjs";
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
      "对一个会话里的图施加任意已注册滤镜（与应用内「滤镜」菜单同一份实现，" +
      "共 " + FILTER_DEFS.length + " 个）。filter 传完整 id，见 strata_capabilities 的 " +
      "imageOps.filters；老短名（gaussianBlur / boxBlur / unsharpMask / addNoise / " +
      "mosaic / median / motionBlur）仍然可用。参数放在 params 里，键名与该滤镜的 " +
      "params 一致，例如 {filter:'filter.blurGallery.tiltShift', params:{radius:18}}。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      filter: z.string().describe("滤镜 id 或老短名"),
      params: z
        .record(z.string(), z.number())
        .optional()
        .describe("滤镜参数（缺省用该滤镜的默认值；键见 capabilities 里该滤镜的 params）"),
      preview: z.boolean().optional(),
    },
  },
  guard(async (args) => {
    const s = sessionImage(args.sessionId);
    const def = findFilter(args.filter);
    if (!def) {
      throw new ToolError(
        `未知滤镜：${args.filter}。用 strata_capabilities 查 imageOps.filters 里的完整 id。`,
      );
    }
    const img = applyFilterToSession(s.img, def, args.params);
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

/** hex → [r,g,b]（双色调用）。 */
function hexToRgb(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return fallback;
  const v = Number.parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

server.registerTool(
  "strata_color_mode",
  {
    title: "转换颜色模式",
    description:
      "把会话里的图转换成另一种颜色模式（与应用内「图像 > 模式」同一套算法）：" +
      "bitmap（阈值二值/半调网点）、duotone（双色墨）、indexed（中位切分量化 + 抖动，" +
      "返回调色板）、cmyk（真实 RGB→CMYK→RGB，含油墨总量与 UCR）、lab（彩度上限收色）、" +
      "multichannel（拆成灰度通道，返回通道图 base64）。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      mode: z
        .enum(["bitmap", "duotone", "indexed", "cmyk", "lab", "multichannel"])
        .describe("目标模式"),
      threshold: z.number().optional().describe("bitmap：阈值 0-255"),
      halftone: z.number().optional().describe("bitmap：半调网点单元 px，0 = 纯二值"),
      dark: z.string().optional().describe("duotone：深色 #rrggbb"),
      light: z.string().optional().describe("duotone：浅色 #rrggbb"),
      strength: z.number().optional().describe("duotone：油墨浓度 0-100"),
      colors: z.number().optional().describe("indexed：颜色数 2-256"),
      dither: z.boolean().optional().describe("indexed：是否抖动"),
      inkLimit: z.number().optional().describe("cmyk：油墨总量上限 %（100-400）"),
      ucr: z.number().optional().describe("cmyk：底色去除 0-100"),
      chroma: z.number().optional().describe("lab：最大彩度 C*ab"),
      preview: z.boolean().optional(),
    },
  },
  guard(async (args) => {
    const s = sessionImage(args.sessionId);
    const src = s.img;
    const payload = { ok: true, sessionId: args.sessionId, mode: args.mode };
    if (args.mode === "bitmap") {
      s.img = toBitmap(src, args.threshold ?? 128, args.halftone ?? 0);
    } else if (args.mode === "duotone") {
      s.img = toDuotone(
        src,
        hexToRgb(args.dark, [27, 42, 74]),
        hexToRgb(args.light, [242, 217, 160]),
        args.strength ?? 100,
      );
    } else if (args.mode === "indexed") {
      const res = toIndexed(src, args.colors ?? 64, args.dither ?? true);
      s.img = res.buf;
      payload.palette = res.palette.map(
        (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`,
      );
      payload.paletteSize = res.palette.length;
    } else if (args.mode === "cmyk") {
      s.img = toCmyk(src, args.inkLimit ?? 300, args.ucr ?? 40);
    } else if (args.mode === "lab") {
      s.img = toLab(src, args.chroma ?? 110);
    } else {
      // multichannel：灰度化，并把三通道各导出一张（供下游分别使用）
      const gray = toDuotone(src, [0, 0, 0], [255, 255, 255], 100);
      s.img = gray;
      const chans = [0, 1, 2].map((ch) => {
        const data = new Uint8ClampedArray(src.width * src.height * 4);
        for (let i = 0; i < src.width * src.height; i += 1) {
          const v = src.data[i * 4 + ch];
          data[i * 4] = v;
          data[i * 4 + 1] = v;
          data[i * 4 + 2] = v;
          data[i * 4 + 3] = 255;
        }
        return {
          channel: ["R", "G", "B"][ch],
          png: encodeImagePng({ width: src.width, height: src.height, data }).toString("base64"),
        };
      });
      payload.channels = chans;
    }
    payload.width = s.img.width;
    payload.height = s.img.height;
    if (args.preview === true) {
      payload.previewBase64 = encodeImagePng(resize(s.img, 320)).toString("base64");
    }
    void medianCutPalette;
    return ok(payload);
  }),
);

server.registerTool(
  "strata_content_aware_scale",
  {
    title: "内容识别缩放",
    description:
      "接缝雕刻（seam carving）：在尽量不拉伸主体的前提下改变图片尺寸。" +
      "反复删/加能量最低的像素路径，与应用内「编辑 > 内容识别缩放」同一份实现。" +
      "大图较慢，建议先缩小再处理。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      width: z.number().describe("目标宽度"),
      height: z.number().describe("目标高度"),
      preview: z.boolean().optional(),
    },
  },
  guard(async (args) => {
    const s = sessionImage(args.sessionId);
    const w = Math.max(1, Math.round(args.width));
    const h = Math.max(1, Math.round(args.height));
    const before = `${s.img.width}×${s.img.height}`;
    s.img = contentAwareScale(s.img, w, h);
    const payload = {
      ok: true,
      sessionId: args.sessionId,
      from: before,
      to: `${s.img.width}×${s.img.height}`,
    };
    if (args.preview === true) {
      payload.previewBase64 = encodeImagePng(resize(s.img, 320)).toString("base64");
    }
    return ok(payload);
  }),
);

server.registerTool(
  "strata_mesh_warp",
  {
    title: "木偶变形（钉点）",
    description:
      "Moving Least Squares 钉点变形（Schaefer 2006）：给若干 `{ox,oy,x,y}` 钉点，" +
      "把图按钉点的位移局部拉扯。similarity 只旋转/缩放（木偶变形），" +
      "affine 允许斜切拉伸（透视变形）。与应用内同一个 mlsWarp 实现。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      pins: z
        .array(
          z.object({
            ox: z.number().describe("原始 x"),
            oy: z.number().describe("原始 y"),
            x: z.number().describe("当前 x"),
            y: z.number().describe("当前 y"),
          }),
        )
        .min(2)
        .describe("钉点（相似模式至少 2 个、仿射至少 3 个，且不能全挤在一点）"),
      mode: z.enum(["similarity", "affine"]).optional(),
      preview: z.boolean().optional(),
    },
  },
  guard(async (args) => {
    const s = sessionImage(args.sessionId);
    s.img = mlsWarp(s.img, args.pins, args.mode ?? "similarity");
    const payload = {
      ok: true,
      sessionId: args.sessionId,
      pins: args.pins.length,
      mode: args.mode ?? "similarity",
      width: s.img.width,
      height: s.img.height,
    };
    if (args.preview === true) {
      payload.previewBase64 = encodeImagePng(resize(s.img, 320)).toString("base64");
    }
    return ok(payload);
  }),
);

server.registerTool(
  "strata_smart_select",
  {
    title: "智能选区",
    description:
      "把图里的某一片「选中」并导出成黑白蒙版 PNG（白 = 选中），与应用内选择菜单同源：" +
      "colorRange（按颜色，需 color+tolerance）、subject（按四周背景估计主体）、" +
      "sky（蓝色相 + 上缘连通）、focus（拉普拉斯合焦区域，需 threshold）。" +
      "返回 coverage（选中像素占比）与 maskBase64。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      kind: z.enum(["colorRange", "subject", "sky", "focus"]).describe("判定方式"),
      color: z.string().optional().describe("colorRange：目标色 #rrggbb"),
      tolerance: z.number().optional().describe("colorRange：容差 0-255"),
      threshold: z.number().optional().describe("focus：局部对比度阈值"),
    },
  },
  guard(async (args) => {
    const s = sessionImage(args.sessionId);
    const { width, height, data } = s.img;
    let hit;
    if (args.kind === "colorRange") {
      hit = colorRangeHit(data, width, height, hexToRgb(args.color, [0, 0, 0]), args.tolerance ?? 32);
    } else if (args.kind === "subject") {
      hit = subjectHit(data, width, height);
    } else if (args.kind === "sky") {
      hit = skyHit(data, width, height);
    } else {
      hit = focusHit(data, width, height, args.threshold ?? 24);
    }
    if (!hit) {
      return ok({ ok: true, sessionId: args.sessionId, kind: args.kind, coverage: 0, maskBase64: null });
    }
    let on = 0;
    for (let i = 0; i < hit.length; i += 1) if (hit[i]) on += 1;
    return ok({
      ok: true,
      sessionId: args.sessionId,
      kind: args.kind,
      coverage: Number((on / (width * height)).toFixed(4)),
      width,
      height,
      maskBase64: encodeImagePng(hitToMask(hit, width, height)).toString("base64"),
    });
  }),
);

server.registerTool(
  "strata_color_profile",
  {
    title: "转换色彩配置文件",
    description:
      "在各色彩空间之间做真实的原色矩阵换算（线性 RGB → XYZ(D65) → 目标线性 RGB）：" +
      "srgb / display-p3 / adobe-rgb / gray。from 省略时按 srgb 处理。",
    inputSchema: {
      sessionId: z.string().describe("会话 id"),
      to: z.enum(["srgb", "display-p3", "adobe-rgb", "gray"]).describe("目标配置文件"),
      from: z.enum(["srgb", "display-p3", "adobe-rgb", "gray"]).optional(),
      preview: z.boolean().optional(),
    },
  },
  guard(async (args) => {
    const s = sessionImage(args.sessionId);
    const from = args.from ?? "srgb";
    if (from === args.to) {
      return ok({ ok: true, sessionId: args.sessionId, from, to: args.to, changed: false });
    }
    s.img = convertProfile(s.img, from, args.to);
    const payload = {
      ok: true,
      sessionId: args.sessionId,
      from: PROFILE_LABELS[from],
      to: PROFILE_LABELS[args.to],
      changed: true,
    };
    if (args.preview === true) {
      payload.previewBase64 = encodeImagePng(resize(s.img, 320)).toString("base64");
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
      const def = findFilter(spec.filter);
      if (!def) throw new ToolError(`未知滤镜：${spec.filter}`);
      const { filter: _f, ...rest } = spec;
      img = applyFilterToSession(img, def, rest.params ?? rest);
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

/* ------------------------------------------------- 图层文档（插画排版） */

/**
 * 文档会话：与图片会话分开存，因为文档是「多层栈」，导出时才压平。
 * docId 形如 doc-3-xxxx，与 img-* 互不影响。
 */
const docs = new Map();
let docSeq = 0;

function newDocSession(doc, source) {
  docSeq += 1;
  const id = `doc-${docSeq}-${Date.now().toString(36)}`;
  docs.set(id, { doc, source });
  return id;
}

function sessionDoc(docId) {
  if (typeof docId !== "string" || !docs.has(docId)) {
    throw new ToolError(`文档不存在：${docId}。先用 strata_doc_new 建一份。`);
  }
  return docs.get(docId);
}

/** 把来源（图片会话 / 磁盘文件 / 纯色）统一取成 RGBA。 */
function sourceImage(spec) {
  if (spec.sessionId) return sessionImage(spec.sessionId).img;
  if (spec.path) return decodeImage(readFileSync(resolveImagePath(spec.path, true)));
  if (spec.color) {
    const [r, g, b, a] = spec.color;
    const img = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
    for (let i = 0; i < 16; i += 1) {
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = a ?? 255;
    }
    return img;
  }
  throw new ToolError("图层来源必须给 sessionId / path / color 之一");
}

const docSourceArg = z
  .object({
    sessionId: z.string().optional().describe("图片会话 id"),
    path: z.string().optional().describe("图片文件绝对路径"),
    color: z.array(z.number()).length(4).optional().describe("纯色 [r,g,b,a]"),
  })
  .describe("图层来源，三选一");

server.registerTool(
  "strata_doc_new",
  {
    title: "新建图层文档",
    description:
      "建一份分层插画文档（后续所有 strata_doc_* 工具都基于它）。" +
      "background 给 [r,g,b] 时自动铺一层背景层；省略则透明。返回 docId 与图层摘要。",
    inputSchema: {
      width: z.number().int().min(8).max(16384),
      height: z.number().int().min(8).max(16384),
      background: z
        .array(z.number())
        .min(3)
        .max(4)
        .optional()
        .describe("背景色 [r,g,b] 或 [r,g,b,a]；省略=透明"),
    },
  },
  guard(async ({ width, height, background }) => {
    const doc = createDoc(width, height, background ? background.slice(0, 4) : null);
    const id = newDocSession(doc, "new");
    return ok({ ok: true, docId: id, ...summarizeDoc(doc) });
  }),
);

server.registerTool(
  "strata_doc_add_image",
  {
    title: "往文档加图片层",
    description:
      "把一个图片会话 / 磁盘图片 / 纯色作为新图层放到文档上（默认加到最上层）。" +
      "width 可指定等比缩放宽度；blend 支持 normal/multiply/screen/overlay/softLight/" +
      "darken/lighten/add；opacity 0–1。返回新的图层摘要。",
    inputSchema: {
      docId: z.string(),
      source: docSourceArg,
      x: z.number().int().optional().describe("左上角 x，默认 0"),
      y: z.number().int().optional().describe("左上角 y，默认 0"),
      width: z.number().int().min(2).max(16384).optional().describe("等比缩放宽度"),
      blend: z.string().optional().describe("混合模式，默认 normal"),
      opacity: z.number().min(0).max(1).optional(),
      name: z.string().optional().describe("图层名"),
      crop: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .optional()
        .describe("从来源里先裁一块（拆局部图层用，比如把脸单独拆出来）"),
    },
  },
  guard(async ({ docId, source, x, y, width, blend, opacity, name, crop }) => {
    const entry = sessionDoc(docId);
    let img = sourceImage(source);
    if (crop) img = cropImage(img, crop);
    if (width && width !== img.width) {
      const h = Math.max(1, Math.round((img.height * width) / img.width));
      img = bilinearResize(img, width, h);
    }
    entry.doc = addLayer(entry.doc, img, { x, y, blend, opacity, name });
    return ok({ ok: true, docId, ...summarizeDoc(entry.doc) });
  }),
);

server.registerTool(
  "strata_doc_add_text",
  {
    title: "加文字层",
    description:
      "排一行/多行文字（支持中文，字体走系统：思源黑 / 微软雅黑 / 黑体）。" +
      "size 字号、weight 字重、letterSpacing 字距、lineHeight 行高倍数、align 对齐、" +
      "shadow 阴影 {color,blur,x,y}、stroke 描边 + strokeWidth。x/y 是文字框左上角落点。",
    inputSchema: {
      docId: z.string(),
      text: z.string().describe("文字内容，\\n 换行"),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      size: z.number().min(6).max(600).optional().describe("字号，默认 64"),
      weight: z.number().min(100).max(900).optional().describe("字重，默认 700"),
      color: z.string().optional().describe("颜色，默认 #ffffff"),
      font: z.string().optional().describe("字体族，可选"),
      letterSpacing: z.number().optional().describe("字距（像素），默认 0"),
      lineHeight: z.number().min(0.8).max(3).optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      italic: z.boolean().optional(),
      shadow: z
        .object({
          color: z.string().optional(),
          blur: z.number().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          alpha: z.number().optional(),
        })
        .optional(),
      stroke: z.string().optional().describe("描边色"),
      strokeWidth: z.number().optional().describe("描边宽"),
      blend: z.string().optional(),
      opacity: z.number().min(0).max(1).optional(),
      name: z.string().optional(),
    },
  },
  guard(async (args) => {
    const entry = sessionDoc(args.docId);
    const img = renderText(args);
    entry.doc = addLayer(entry.doc, img, {
      x: args.x ?? 0,
      y: args.y ?? 0,
      blend: args.blend,
      opacity: args.opacity,
      name: args.name ?? `文字:${String(args.text).slice(0, 12)}`,
    });
    return ok({ ok: true, docId: args.docId, textSize: `${img.width}×${img.height}`, ...summarizeDoc(entry.doc) });
  }),
);

server.registerTool(
  "strata_doc_add_shape",
  {
    title: "加形状层（虚线框 / 椭圆 / 渐变）",
    description:
      "画形状层：shape=rect（可 radius 圆角、dash 虚线、fill 填充）、ellipse（可 dash 虚线圈）、" +
      "gradient（需 stops:[{at,color}] 与 angle）。dash 传 [实,虚] 像素数组，例如 [14,10]。 " +
      "blur 可对形状做高斯模糊（做光斑/软阴影底）。",
    inputSchema: {
      docId: z.string(),
      shape: z.enum(["rect", "ellipse", "gradient"]),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      width: z.number().int().min(2),
      height: z.number().int().min(2),
      stroke: z.string().optional(),
      strokeWidth: z.number().optional(),
      dash: z.array(z.number()).optional(),
      fill: z.string().optional(),
      radius: z.number().optional(),
      stops: z.array(z.object({ at: z.number(), color: z.string() })).optional(),
      angle: z.number().optional().describe("渐变角度，0=从左到右，90=从上到下"),
      blur: z.number().optional().describe("高斯模糊半径（软阴影 / 光斑）"),
      blend: z.string().optional(),
      opacity: z.number().min(0).max(1).optional(),
      name: z.string().optional(),
    },
  },
  guard(async (args) => {
    const entry = sessionDoc(args.docId);
    let img;
    if (args.shape === "rect") {
      img = renderRect({
        width: args.width,
        height: args.height,
        stroke: args.stroke ?? "#ffffff",
        strokeWidth: args.strokeWidth ?? 4,
        dash: args.dash ?? null,
        radius: args.radius ?? 0,
        fill: args.fill ?? null,
      });
    } else if (args.shape === "ellipse") {
      img = renderEllipse({
        width: args.width,
        height: args.height,
        stroke: args.stroke ?? "#ffffff",
        strokeWidth: args.strokeWidth ?? 4,
        dash: args.dash ?? null,
        fill: args.fill ?? null,
      });
    } else {
      img = renderGradient({
        width: args.width,
        height: args.height,
        stops: args.stops ?? [{ at: 0, color: "#ffffff" }, { at: 1, color: "#000000" }],
        angle: args.angle ?? 90,
      });
    }
    if (args.blur && args.blur > 0) img = gaussianBlur(img, args.blur);
    entry.doc = addLayer(entry.doc, img, {
      x: args.x ?? 0,
      y: args.y ?? 0,
      blend: args.blend,
      opacity: args.opacity,
      name: args.name ?? `${args.shape} ${args.width}×${args.height}`,
    });
    return ok({ ok: true, docId: args.docId, ...summarizeDoc(entry.doc) });
  }),
);

server.registerTool(
  "strata_doc_adjust_layer",
  {
    title: "给单层调色（可限定区域）",
    description:
      "对某一层施加调色算子 / 滤镜；给 region 时只在该区域内生效（矩形或椭圆，带 feather 羽化），" +
      "这就是「分区调色」：只给猫脸加暖、只给背景压暗。region 用文档坐标。" +
      "region 写法：{type:'rect', x,y,width,height, feather} 或 {type:'ellipse', cx,cy,rx,ry, feather}。",
    inputSchema: {
      docId: z.string(),
      layer: z.union([z.number().int(), z.string()]).describe("图层序号或名字"),
      ops: z.array(z.object({ type: z.string() }).passthrough()).optional(),
      filters: z.array(z.object({ filter: z.string() }).passthrough()).optional(),
      region: z
        .object({
          type: z.enum(["rect", "ellipse"]).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          cx: z.number().optional(),
          cy: z.number().optional(),
          rx: z.number().optional(),
          ry: z.number().optional(),
          feather: z.number().optional(),
        })
        .optional()
        .describe("作用区域（文档坐标）；省略=整层"),
    },
  },
  guard(async ({ docId, layer, ops, filters, region }) => {
    const entry = sessionDoc(docId);
    const idx = layerIndex(entry.doc, layer);
    if (idx < 0) throw new ToolError(`找不到图层：${layer}`);
    const target = entry.doc.layers[idx];
    let img = target.img;

    for (const op of ops ?? []) {
      const adj = ADJUSTERS[op.type];
      if (!adj) throw new ToolError(`未知调色算子：${op.type}`);
      img = adj.run(img, op);
    }
    for (const spec of filters ?? []) {
      const def = findFilter(spec.filter);
      if (!def) throw new ToolError(`未知滤镜：${spec.filter}`);
      const { filter: _f, ...rest } = spec;
      img = applyFilterToSession(img, def, rest.params ?? rest);
    }

    if (region) {
      // 文档坐标 → 图层局部坐标，再按蒙版混合（羽化边界不出现硬切）
      const local = {
        ...region,
        x: region.x !== undefined ? region.x - target.x : undefined,
        y: region.y !== undefined ? region.y - target.y : undefined,
        cx: region.cx !== undefined ? region.cx - target.x : undefined,
        cy: region.cy !== undefined ? region.cy - target.y : undefined,
      };
      const maskDoc = regionMask(
        { width: img.width, height: img.height },
        local,
      );
      img = mixByMask(target.img, img, maskDoc);
    }
    entry.doc = replaceLayer(entry.doc, idx, img);
    return ok({ ok: true, docId, layer: idx, name: target.name, ...summarizeDoc(entry.doc) });
  }),
);

server.registerTool(
  "strata_doc_drop_shadow",
  {
    title: "给图层加投影（阴影感）",
    description:
      "按某一层的轮廓生成投影：alpha 膨胀模糊 + 偏移，插到该层下方，默认 multiply。" +
      "这是「让主体从背景里立起来」的关键一步。dx/dy 偏移、blur 模糊、opacity 浓度。",
    inputSchema: {
      docId: z.string(),
      layer: z.union([z.number().int(), z.string()]),
      dx: z.number().optional().describe("水平偏移，默认 0"),
      dy: z.number().optional().describe("垂直偏移，默认 18"),
      blur: z.number().optional().describe("模糊半径，默认 22"),
      opacity: z.number().min(0).max(1).optional().describe("投影浓度，默认 0.45"),
      color: z.string().optional().describe("投影颜色，默认 #000000"),
      blend: z.string().optional().describe("混合模式，默认 multiply"),
      spread: z.number().optional().describe("膨胀像素（让影子更厚），默认 0"),
    },
  },
  guard(async ({ docId, layer, dx, dy, blur, opacity, color, blend, spread }) => {
    const entry = sessionDoc(docId);
    const idx = layerIndex(entry.doc, layer);
    if (idx < 0) throw new ToolError(`找不到图层：${layer}`);
    const target = entry.doc.layers[idx];
    const { width: w, height: h } = target.img;

    // 由目标层 alpha 造剪影
    const sil = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    const c = color ?? "#000000";
    const hex = c.replace("#", "");
    const cr = parseInt(hex.slice(0, 2), 16) || 0;
    const cg = parseInt(hex.slice(2, 4), 16) || 0;
    const cb = parseInt(hex.slice(4, 6), 16) || 0;
    for (let i = 0; i < w * h; i += 1) {
      const a = target.img.data[i * 4 + 3];
      sil.data[i * 4] = cr;
      sil.data[i * 4 + 1] = cg;
      sil.data[i * 4 + 2] = cb;
      sil.data[i * 4 + 3] = a;
    }
    let shadow = blur && blur > 0 ? gaussianBlur(sil, blur) : sil;
    if (spread && spread > 0) {
      // 用模糊 + 阈值近似膨胀，让影子更厚一点
      shadow = gaussianBlur(shadow, spread);
      for (let i = 0; i < w * h; i += 1) {
        const a = shadow.data[i * 4 + 3];
        shadow.data[i * 4 + 3] = Math.min(255, a * 1.35);
      }
    }
    const layers = entry.doc.layers.slice();
    layers.splice(idx, 0, {
      name: `${target.name} 投影`,
      img: shadow,
      x: target.x + (dx ?? 0),
      y: target.y + (dy ?? 18),
      blend: blend && BLEND_MODES[blend] ? blend : "multiply",
      opacity: opacity ?? 0.45,
      visible: true,
    });
    entry.doc = { ...entry.doc, layers };
    return ok({ ok: true, docId, ...summarizeDoc(entry.doc) });
  }),
);

server.registerTool(
  "strata_doc_preview",
  {
    title: "预览图层文档",
    description: "把文档压平并缩到指定边长，回传 base64 PNG（不落盘）。",
    inputSchema: {
      docId: z.string(),
      maxSide: z.number().int().min(32).max(2048).optional().describe("默认 480"),
    },
  },
  guard(async ({ docId, maxSide }) => {
    const entry = sessionDoc(docId);
    const flat = flatten(entry.doc);
    const small = resize(flat, maxSide ?? 480);
    return ok({
      docId,
      width: small.width,
      height: small.height,
      base64: encodeImagePng(small).toString("base64"),
    });
  }),
);

server.registerTool(
  "strata_doc_export",
  {
    title: "导出图层文档",
    description: "把文档压平后写成 PNG / JPEG（扩展名决定格式，quality 管 JPEG 质量）。",
    inputSchema: {
      docId: z.string(),
      path: z.string().describe("导出文件绝对路径"),
      quality: z.number().min(1).max(100).optional(),
      maxSide: z.number().int().optional().describe("导出前等比缩小"),
    },
  },
  guard(async ({ docId, path, quality, maxSide }) => {
    const entry = sessionDoc(docId);
    let flat = flatten(entry.doc);
    if (maxSide) flat = resize(flat, maxSide);
    const ext = extOf(path);
    if (!EXPORT_EXTS.includes(ext)) {
      throw new ToolError(`导出扩展名必须是 ${EXPORT_EXTS.join(" / ")}（收到 .${ext || "无"}）`);
    }
    const abs = resolveImagePath(path, false);
    const bytes = ext === "png" ? encodeImagePng(flat) : encodeImageJpeg(flat, quality ?? 92);
    writeFileSync(abs, bytes);
    return ok({
      ok: true,
      docId,
      path: abs,
      format: ext,
      bytes: bytes.length,
      width: flat.width,
      height: flat.height,
      layers: entry.doc.layers.length,
    });
  }),
);

/**
 * 把文档单层烘焙成「全画幅 surface」的 base64 PNG。
 * 文档图层用 (x,y) 偏移定位，而 .strata 的像素层 surface 是整画布尺寸，
 * 所以这里按偏移把图层像素贴进一张透明全画幅缓冲再编码。
 */
function encodeDocLayerSurface(W, H, layer) {
  const buf = new Uint8ClampedArray(W * H * 4);
  const { img, x: ox = 0, y: oy = 0 } = layer;
  const sw = img.width;
  const sh = img.height;
  for (let sy = 0; sy < sh; sy += 1) {
    const dy = oy + sy;
    if (dy < 0 || dy >= H) continue;
    for (let sx = 0; sx < sw; sx += 1) {
      const dx = ox + sx;
      if (dx < 0 || dx >= W) continue;
      const si = (sy * sw + sx) * 4;
      const di = (dy * W + dx) * 4;
      buf[di] = img.data[si];
      buf[di + 1] = img.data[si + 1];
      buf[di + 2] = img.data[si + 2];
      buf[di + 3] = img.data[si + 3];
    }
  }
  return encodeImagePng({ width: W, height: H, data: buf }).toString("base64");
}

server.registerTool(
  "strata_doc_save",
  {
    title: "保存图层文档为 .strata 工程",
    description:
      "把当前分层文档存成可编辑的 .strata 工程文件：每层作为独立像素层保存，" +
      "保留不透明度（0–100）与混合模式，图层按自身坐标烘焙进全画幅 surface。" +
      "可用 Strata 打开后继续编辑（移动 / 调色 / 撤销等）。" +
      "path 可省略 .strata 扩展名，会自动补。",
    inputSchema: {
      docId: z.string(),
      path: z.string().describe("保存的 .strata 绝对路径（扩展名可省略，自动补 .strata）"),
      name: z.string().optional().describe("工程名（省略=文档默认名）"),
    },
  },
  guard(async ({ docId, path, name }) => {
    const entry = sessionDoc(docId);
    const doc = entry.doc;
    const { width: W, height: H } = doc;
    const layers = doc.layers.map((layer, li) => ({
      name: layer.name && layer.name.length ? layer.name : `图层 ${li + 1}`,
      visible: layer.visible !== false,
      opacity: Math.round((typeof layer.opacity === "number" ? layer.opacity : 1) * 100),
      blend: BLEND_IDS.includes(layer.blend) ? layer.blend : "normal",
      kind: "pixel",
      surface: encodeDocLayerSurface(W, H, layer),
    }));
    const manifest = {
      name: name && name.length ? name : "Strata 文档",
      width: W,
      height: H,
      active: layers.length - 1,
      layers,
    };
    const built = buildProjectFile(manifest);
    if (!built.ok) {
      throw new ToolError("工程规范化失败：" + built.errors.join("；"));
    }
    const out = writeProjectFile(path, built.file);
    return ok({
      ok: true,
      docId,
      path: out.abs,
      bytes: out.bytes,
      layers: layers.length,
      width: W,
      height: H,
    });
  }),
);

/* ------------------------------------------------ 相册套件工具（Mark 5） */

server.registerTool(
  "strata_doc_add_path",
  {
    title: "加矢量路径层（手绘挂钩 / 链子 / 任意图形）",
    description:
      "用绘图指令序列画一个图形层：M 落笔、L 直线、C 三次贝塞尔、Q 二次贝塞尔、" +
      "A 椭圆弧（rx/ry/rot/large/sweep/x/y）、Z 闭合。stroke/strokeWidth/dash=[on,off]/fill。" +
      "路径坐标就是文档坐标（x/y 再整体平移）。挂钩、链子、花边、任何插画元素都靠它。",
    inputSchema: {
      docId: z.string(),
      commands: z
        .array(
          z.object({ op: z.enum(["M", "L", "C", "Q", "A", "Z"]) }).passthrough(),
        )
        .min(1)
        .describe("绘图指令序列"),
      x: z.number().optional().describe("整层平移 x，默认 0"),
      y: z.number().optional().describe("整层平移 y，默认 0"),
      stroke: z.string().optional(),
      strokeWidth: z.number().optional().describe("默认 6"),
      dash: z.array(z.number()).optional(),
      fill: z.string().optional().describe("填充色；省略=只描边"),
      blend: z.string().optional(),
      opacity: z.number().min(0).max(1).optional(),
      name: z.string().optional(),
    },
  },
  guard(async (args) => {
    const entry = sessionDoc(args.docId);
    const img = renderPath({
      commands: args.commands,
      stroke: args.stroke ?? "#ffffff",
      strokeWidth: args.strokeWidth ?? 6,
      dash: args.dash ?? null,
      fill: args.fill ?? null,
    });
    entry.doc = addLayer(entry.doc, img, {
      // renderPath 会裁到路径包围盒；originX/Y 是「路径原点在图层内的位置」，
      // 用 x + originX 定位就能让路径坐标直接当文档坐标用。
      x: Math.round((args.x ?? 0) + (img.originX ?? 0)),
      y: Math.round((args.y ?? 0) + (img.originY ?? 0)),
      blend: args.blend,
      opacity: args.opacity,
      name: args.name ?? `路径 ${img.width}×${img.height}`,
    });
    return ok({ ok: true, docId: args.docId, pathSize: `${img.width}×${img.height}`, ...summarizeDoc(entry.doc) });
  }),
);

server.registerTool(
  "strata_doc_transform_layer",
  {
    title: "变换图层（放大缩小 / 旋转 / 关节枢轴）",
    description:
      "对文档里的某一层做等比/非等比缩放和旋转。pivot 是关节（枢轴）的图层局部坐标 —— " +
      "比如挂在链子上的照片，关节就是顶部挂环：旋转缩放都绕它，照片像真的挂在钉子上。" +
      "变换后关节点的文档位置保持不动。",
    inputSchema: {
      docId: z.string(),
      layer: z.union([z.number().int(), z.string()]).describe("图层序号或名字"),
      scaleX: z.number().min(0.05).max(20).optional().describe("默认 1"),
      scaleY: z.number().min(0.05).max(20).optional().describe("默认 = scaleX"),
      angle: z.number().min(-360).max(360).optional().describe("旋转角度（度，顺时针），默认 0"),
      pivot: z
        .object({ x: z.number(), y: z.number() })
        .optional()
        .describe("关节的图层局部坐标；省略 = 图层中心"),
    },
  },
  guard(async ({ docId, layer, scaleX, scaleY, angle, pivot }) => {
    const entry = sessionDoc(docId);
    const idx = layerIndex(entry.doc, layer);
    if (idx < 0) throw new ToolError(`找不到图层：${layer}`);
    const target = entry.doc.layers[idx];
    const sx = scaleX ?? 1;
    const sy = scaleY ?? sx;
    const deg = angle ?? 0;
    let img = target.img;
    if (sx !== 1 || sy !== 1) {
      img = bilinearResize(img, Math.max(1, Math.round(img.width * sx)), Math.max(1, Math.round(img.height * sy)));
    }
    if (deg !== 0) img = rotateImage(img, deg);
    // 关节点的文档位置在变换前后保持不动
    const px = pivot ? pivot.x : target.img.width / 2;
    const py = pivot ? pivot.y : target.img.height / 2;
    // 缩放后的关节（图层局部坐标）
    const spx = px * sx;
    const spy = py * sy;
    // 旋转：目标 = 新中心 + R(-θ)·(源 - 源中心)
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // 真实几何：旋转前图层内容中心 = 缩放图中心；旋转扩边后中心不变
    const scaledW = target.img.width * sx;
    const scaledH = target.img.height * sy;
    const cxS = scaledW / 2;
    const cyS = scaledH / 2;
    const rvx = spx - cxS;
    const rvy = spy - cyS;
    const rotX = rvx * cos - rvy * sin;
    const rotY = rvx * sin + rvy * cos;
    const newCx = img.width / 2;
    const newCy = img.height / 2;
    const pivotNewX = newCx + rotX;
    const pivotNewY = newCy + rotY;
    const docPivotX = target.x + px;
    const docPivotY = target.y + py;
    const newX = Math.round(docPivotX - pivotNewX);
    const newY = Math.round(docPivotY - pivotNewY);
    const layers = entry.doc.layers.slice();
    layers[idx] = { ...layers[idx], img, x: newX, y: newY };
    entry.doc = { ...entry.doc, layers };
    return ok({
      ok: true,
      docId,
      layer: idx,
      name: target.name,
      newSize: `${img.width}×${img.height}`,
      at: [newX, newY],
      pivotDoc: [Math.round(docPivotX), Math.round(docPivotY)],
      ...summarizeDoc(entry.doc),
    });
  }),
);

server.registerTool(
  "strata_doc_add_contour",
  {
    title: "加贴边虚线轮廓（描着图层剪影走）",
    description:
      "从某一图层的 alpha 提取最大外轮廓（marching squares），沿弧长画虚线，" +
      "自动对齐到该图层的位置 —— 虚线紧贴着主体边缘，不是独立方框。" +
      "dashOn/dashOff 是实/空段长度（像素），strokeWidth 是线宽。",
    inputSchema: {
      docId: z.string(),
      layer: z.union([z.number().int(), z.string()]).describe("要描轮廓的图层"),
      stroke: z.string().optional().describe("默认 #ffffff"),
      strokeWidth: z.number().min(1).max(40).optional().describe("默认 3"),
      dashOn: z.number().min(2).max(400).optional().describe("实线段长，默认 18"),
      dashOff: z.number().min(1).max(400).optional().describe("空白段长，默认 12"),
      threshold: z.number().min(1).max(250).optional().describe("alpha 阈值，默认 30"),
      name: z.string().optional(),
    },
  },
  guard(async ({ docId, layer, stroke, strokeWidth, dashOn, dashOff, threshold, name }) => {
    const entry = sessionDoc(docId);
    const idx = layerIndex(entry.doc, layer);
    if (idx < 0) throw new ToolError(`找不到图层：${layer}`);
    const target = entry.doc.layers[idx];
    const ring = outerContour(target.img, threshold ?? 30);
    if (ring.length < 4) throw new ToolError("该图层没有可描的轮廓（alpha 可能全空或全实）");
    const sw = strokeWidth ?? 3;
    const dash = strokeRingDashed(ring, {
      stroke: hexToRgbArr(stroke ?? "#ffffff"),
      strokeWidth: sw,
      dashOn: dashOn ?? 18,
      dashOff: dashOff ?? 12,
    });
    // dash 图左上角相对图层左上角的偏移：ring bbox 最小值 - pad
    const pad = sw + 2;
    let minX = Infinity;
    let minY = Infinity;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
    }
    entry.doc = addLayer(entry.doc, dash, {
      x: Math.round(target.x + minX - pad),
      y: Math.round(target.y + minY - pad),
      name: name ?? `${target.name} 虚线轮廓`,
    });
    return ok({
      ok: true,
      docId,
      contourPoints: ring.length,
      dashSize: `${dash.width}×${dash.height}`,
      ...summarizeDoc(entry.doc),
    });
  }),
);

/** #rrggbb → [r,g,b]（contour 工具内部用）。 */
function hexToRgbArr(color) {
  const hex = String(color ?? "#ffffff").replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

server.registerTool(
  "strata_doc_layer_effect",
  {
    title: "图层质感效果（胶封 / 高光）",
    description:
      "给某一层加材质效果。effect=gloss：胶封质感 —— 边缘暗环（rim）+ 左上定向反光" +
      "（sheen）+ 对比微调，让照片像被树脂封起来。rim/sheen/strength 都可调。",
    inputSchema: {
      docId: z.string(),
      layer: z.union([z.number().int(), z.string()]),
      effect: z.enum(["gloss"]).describe("效果类型"),
      rim: z.number().min(0).max(2).optional().describe("边缘暗环强度，默认 0.55"),
      sheen: z.number().min(0).max(2).optional().describe("定向反光强度，默认 0.4"),
      strength: z.number().min(0).max(2).optional().describe("整体强度，默认 1"),
    },
  },
  guard(async ({ docId, layer, effect, rim, sheen, strength }) => {
    const entry = sessionDoc(docId);
    const idx = layerIndex(entry.doc, layer);
    if (idx < 0) throw new ToolError(`找不到图层：${layer}`);
    const target = entry.doc.layers[idx];
    if (effect !== "gloss") throw new ToolError(`未知效果：${effect}`);
    const img = glossLayer(target.img, { rim, sheen, strength });
    entry.doc = replaceLayer(entry.doc, idx, img);
    return ok({ ok: true, docId, layer: idx, effect, ...summarizeDoc(entry.doc) });
  }),
);

server.registerTool(
  "strata_doc_add_glow",
  {
    title: "加光晕层（给整个画面打光）",
    description:
      "在文档任意高度加一团径向光晕（透明底，独立图层）：cx/cy 圆心（文档坐标）、" +
      "radius 半径、color 颜色、strength 强度、falloff 衰减。混合模式建议 screen（提亮）" +
      "或 overlay。全局打光就是放大半径、降低强度；局部聚光就缩小半径。",
    inputSchema: {
      docId: z.string(),
      cx: z.number().describe("圆心 x（文档坐标）"),
      cy: z.number().describe("圆心 y（文档坐标）"),
      radius: z.number().min(8).describe("半径"),
      color: z.string().optional().describe("默认 #ffe0a0 暖金"),
      strength: z.number().min(0).max(1).optional().describe("默认 0.5"),
      falloff: z.number().min(0.5).max(6).optional().describe("默认 2"),
      blend: z.string().optional().describe("默认 screen"),
      opacity: z.number().min(0).max(1).optional(),
      name: z.string().optional(),
    },
  },
  guard(async (args) => {
    const entry = sessionDoc(args.docId);
    const { width: w, height: h } = entry.doc;
    const img = renderRadialGlow({
      width: w,
      height: h,
      cx: args.cx,
      cy: args.cy,
      radius: args.radius,
      color: args.color ?? "#ffe0a0",
      strength: args.strength ?? 0.5,
      falloff: args.falloff ?? 2,
    });
    entry.doc = addLayer(entry.doc, img, {
      x: 0,
      y: 0,
      blend: args.blend ?? "screen",
      opacity: args.opacity,
      name: args.name ?? `光晕 (${Math.round(args.cx)},${Math.round(args.cy)})`,
    });
    return ok({ ok: true, docId: args.docId, ...summarizeDoc(entry.doc) });
  }),
);

server.registerTool(
  "strata_doc_add_glass",
  {
    title: "加玻璃膜（明玻璃质感覆盖层）",
    description:
      "在文档最上面盖一层玻璃膜：极淡冷色底 + 斜向白色反光带 + 四边厚度高光。" +
      "strength 控制整体强度（0.1 轻、0.3 重），streaks 反光带条数，tint 玻璃色。" +
      "这就是「照片外面那块玻璃」。",
    inputSchema: {
      docId: z.string(),
      tint: z.string().optional().describe("玻璃色，默认 #dceef8 冷白"),
      strength: z.number().min(0).max(1).optional().describe("默认 0.22"),
      streaks: z.number().int().min(0).max(5).optional().describe("反光带条数，默认 3"),
      blend: z.string().optional().describe("默认 screen"),
      opacity: z.number().min(0).max(1).optional(),
      name: z.string().optional(),
    },
  },
  guard(async (args) => {
    const entry = sessionDoc(args.docId);
    const { width: w, height: h } = entry.doc;
    const img = renderGlass({
      width: w,
      height: h,
      tint: args.tint ?? "#dceef8",
      strength: args.strength ?? 0.22,
      streaks: args.streaks ?? 3,
    });
    entry.doc = addLayer(entry.doc, img, {
      x: 0,
      y: 0,
      blend: args.blend ?? "screen",
      opacity: args.opacity,
      name: args.name ?? "玻璃膜",
    });
    return ok({ ok: true, docId: args.docId, ...summarizeDoc(entry.doc) });
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
