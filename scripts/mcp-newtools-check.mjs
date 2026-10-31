/**
 * 新增 MCP 工具的冒烟测试（真走 MCP 协议，不 import 任何 lib）。
 *
 * 覆盖这一轮补齐的能力：
 *   strata_filter_image（通用：任意已注册滤镜）
 *   strata_color_mode / strata_content_aware_scale /
 *   strata_mesh_warp / strata_smart_select / strata_color_profile
 *
 * 用法：node scripts/mcp-newtools-check.mjs
 * 它会自己在系统临时目录造一张测试图，跑完删掉，不碰用户文件。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "mcp", "strata-mcp.mjs");
const require = createRequire(join(HERE, "..", "mcp", "package.json"));
const { createCanvas } = require("@napi-rs/canvas");

/* ------------------------------------------------------------ MCP 客户端 */

class McpClient {
  constructor() {
    this.proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    this.id = 0;
    this.pending = new Map();
    this.timers = new Map();
    this.buffer = "";
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            const t = this.timers.get(msg.id);
            if (t) {
              clearTimeout(t);
              this.timers.delete(msg.id);
            }
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    });
    this.proc.stderr.on("data", () => {});
  }

  request(method, params) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      // 定时器必须存下来并在回包时清掉，否则它会把事件循环拖住 120 秒，
      // 脚本跑完不退出（踩过一次）。
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`请求超时：${method}`));
        }
      }, 120000);
      this.timers.set(id, timer);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "strata-newtools-check", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async call(name, args) {
    const res = await this.request("tools/call", { name, arguments: args ?? {} });
    const text = res.content?.[0]?.text ?? "{}";
    return { parsed: JSON.parse(text), isError: Boolean(res.isError) };
  }

  close() {
    try {
      this.proc.kill();
    } catch {
      /* 已退出 */
    }
  }
}

/* ------------------------------------------------------------------ 主流程 */

const dir = mkdtempSync(join(tmpdir(), "strata-mcp-check-"));
const imgPath = join(dir, "sample.png");
const sheetPath = join(dir, "sheet.png");

// 造一张「上蓝天空 + 中间白墙 + 下蓝地面 + 一块红主体」的图，
// 让 sky / subject / colorRange 都有可命中的内容。
{
  const w = 240;
  const h = 160;
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, h / 3);
  g.addColorStop(0, "#4a90d9");
  g.addColorStop(1, "#8fc0ea");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h / 3);
  ctx.fillStyle = "#efefef";
  ctx.fillRect(0, h / 3, w, h / 3);
  ctx.fillStyle = "#3a6bb0";
  ctx.fillRect(0, (h * 2) / 3, w, h / 3);
  ctx.fillStyle = "#d9382b";
  ctx.fillRect(90, 60, 60, 45);
  writeFileSync(imgPath, c.toBuffer("image/png"));

// 白底上摆两块「照片」，用来测裁正照片的切分
{
  const w = 300;
  const h = 200;
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#2b6cb0";
  ctx.fillRect(20, 30, 100, 120);
  ctx.fillStyle = "#c05621";
  ctx.fillRect(160, 50, 110, 90);
  writeFileSync(sheetPath, c.toBuffer("image/png"));
}
}

const client = new McpClient();
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, msg: e instanceof Error ? e.message : String(e) });
  }
};

try {
  await client.init();

  const open = await client.call("strata_open_image", { path: imgPath });
  check("strata_open_image", () => {
    if (open.isError) throw new Error(open.parsed.error);
  });
  const sid = open.parsed.sessionId ?? open.parsed.session?.id;
  if (!sid) throw new Error(`没拿到 sessionId：${JSON.stringify(open.parsed)}`);

  // 通用滤镜：模糊画廊（本轮新加）
  const f1 = await client.call("strata_filter_image", {
    sessionId: sid,
    filter: "filter.blurGallery.tiltShift",
    params: { radius: 12, center: 50, keep: 10, feather: 30 },
  });
  check("strata_filter_image · tiltShift", () => {
    if (f1.isError) throw new Error(f1.parsed.error);
    if (f1.parsed.applied !== "filter.blurGallery.tiltShift") throw new Error("applied 不对");
  });

  // 通用滤镜：镜头校正（本轮新加）
  const f2 = await client.call("strata_filter_image", {
    sessionId: sid,
    filter: "filter.lensCorrection",
    params: { distortion: 20, vignette: -30, ca: 2 },
  });
  check("strata_filter_image · lensCorrection", () => {
    if (f2.isError) throw new Error(f2.parsed.error);
  });

  // 老短名仍可用（向后兼容）
  const f3 = await client.call("strata_filter_image", {
    sessionId: sid,
    filter: "gaussianBlur",
    params: { radius: 2 },
  });
  check("strata_filter_image · 老短名 gaussianBlur", () => {
    if (f3.isError) throw new Error(f3.parsed.error);
  });

  // 颜色模式：索引颜色（应返回调色板）
  const m1 = await client.call("strata_color_mode", {
    sessionId: sid,
    mode: "indexed",
    colors: 16,
    dither: true,
  });
  check("strata_color_mode · indexed", () => {
    if (m1.isError) throw new Error(m1.parsed.error);
    if (!Array.isArray(m1.parsed.palette) || m1.parsed.palette.length === 0) {
      throw new Error("没有返回调色板");
    }
  });

  // 颜色模式：CMYK / 位图 / 双色调
  for (const mode of ["cmyk", "bitmap", "duotone", "lab"]) {
    const r = await client.call("strata_color_mode", { sessionId: sid, mode });
    check(`strata_color_mode · ${mode}`, () => {
      if (r.isError) throw new Error(r.parsed.error);
    });
  }

  // 色彩配置文件
  const p1 = await client.call("strata_color_profile", {
    sessionId: sid,
    to: "display-p3",
  });
  check("strata_color_profile · srgb→display-p3", () => {
    if (p1.isError) throw new Error(p1.parsed.error);
    if (p1.parsed.changed !== true) throw new Error("应当发生换算");
  });

  // 选区/几何都换一个**全新会话**：
  // 上面那张图已经过 indexed / bitmap / duotone，天空的蓝色早就不在了，
  // 拿它测 selection 只会证明「工具没问题、数据没了」。
  const fresh = await client.call("strata_open_image", { path: imgPath });
  const sid2 = fresh.parsed.sessionId ?? fresh.parsed.session?.id;
  if (!sid2) throw new Error(`没拿到第二个 sessionId：${JSON.stringify(fresh.parsed)}`);

  // 智能选区：天空
  const s1 = await client.call("strata_smart_select", { sessionId: sid2, kind: "sky" });
  check("strata_smart_select · sky", () => {
    if (s1.isError) throw new Error(s1.parsed.error);
    if (!(s1.parsed.coverage > 0.1)) throw new Error(`天空覆盖率异常：${s1.parsed.coverage}`);
    if (!s1.parsed.maskBase64) throw new Error("没有返回蒙版");
  });

  // 智能选区：主体 / 色彩范围 / 焦点
  const s2 = await client.call("strata_smart_select", { sessionId: sid2, kind: "subject" });
  check("strata_smart_select · subject", () => {
    if (s2.isError) throw new Error(s2.parsed.error);
    if (!(s2.parsed.coverage > 0)) throw new Error("没找到主体");
  });
  const s3 = await client.call("strata_smart_select", {
    sessionId: sid2,
    kind: "colorRange",
    color: "#d9382b",
    tolerance: 40,
  });
  check("strata_smart_select · colorRange", () => {
    if (s3.isError) throw new Error(s3.parsed.error);
    if (!(s3.parsed.coverage > 0)) throw new Error("红色块没被选中");
  });

  // 内容识别缩放：横向缩小
  const c1 = await client.call("strata_content_aware_scale", {
    sessionId: sid,
    width: 200,
    height: 160,
  });
  check("strata_content_aware_scale", () => {
    if (c1.isError) throw new Error(c1.parsed.error);
    if (!c1.parsed.to.startsWith("200×160")) throw new Error(`尺寸不对：${c1.parsed.to}`);
  });

  // 木偶变形
  const w1 = await client.call("strata_mesh_warp", {
    sessionId: sid,
    mode: "similarity",
    pins: [
      { ox: 40, oy: 40, x: 40, y: 40 },
      { ox: 160, oy: 40, x: 175, y: 30 },
      { ox: 100, oy: 120, x: 100, y: 130 },
    ],
  });
  check("strata_mesh_warp · similarity", () => {
    if (w1.isError) throw new Error(w1.parsed.error);
    if (w1.parsed.pins !== 3) throw new Error("钉点数不对");
  });

  // 裁正照片：白底带两块，应该切出 2 张
  const sheet = await client.call("strata_open_image", { path: sheetPath });
  const sheetId = sheet.parsed.sessionId ?? sheet.parsed.session?.id;
  const crop = await client.call("strata_crop_photos", { sessionId: sheetId });
  check("strata_crop_photos", () => {
    if (crop.isError) throw new Error(crop.parsed.error);
    if (crop.parsed.count !== 2) throw new Error(`应切出 2 张，实际 ${crop.parsed.count}`);
    if (crop.parsed.singleBlob) throw new Error("不该判定为单块");
  });

  // 导出 LUT：用亮度算子把一个恒等网格处理一遍
  const lut = await client.call("strata_export_lut", {
    ops: [{ type: "brightnessContrast", brightness: 20 }],
    size: 9,
  });
  check("strata_export_lut", () => {
    if (lut.isError) throw new Error(lut.parsed.error);
    if (!String(lut.parsed.cube ?? "").startsWith("TITLE")) throw new Error("cube 头不对");
    if (!String(lut.parsed.cube).includes("LUT_3D_SIZE 9")) throw new Error("尺寸行缺失");
    const rows = String(lut.parsed.cube)
      .split("\n")
      .filter((l) => /^[0-9.]+ [0-9.]+ [0-9.]+$/.test(l));
    if (rows.length !== 9 ** 3) throw new Error(`条目数应为 729，实际 ${rows.length}`);
  });

  // 文字检查
  const proof = await client.call("strata_proofread", {
    text: "我们我们用Photoshop修图,好吗",
    fix: true,
  });
  check("strata_proofread", () => {
    if (proof.isError) throw new Error(proof.parsed.error);
    if (!(proof.parsed.count > 0)) throw new Error("应该有可报的问题");
    if (!String(proof.parsed.fixed).includes("，")) throw new Error("半角逗号没被修正");
  });

  // 能力清单应能列出全部滤镜与颜色模式
  const caps = await client.call("strata_capabilities", {});
  check("strata_capabilities · imageOps", () => {
    const io = caps.parsed.imageOps;
    if (!io) throw new Error("缺少 imageOps 段");
    if (io.filterCount < 70) throw new Error(`滤镜数量异常：${io.filterCount}`);
    if (!io.colorModes.some((m) => m.id === "indexed")) throw new Error("缺少 colorModes");
    if (!io.colorProfiles.some((p) => p.id === "display-p3")) throw new Error("缺少 colorProfiles");
  });
} finally {
  client.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

const bad = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "  ✓" : "  ✗"} ${r.name}${r.ok ? "" : ` —— ${r.msg}`}\n`);
}
process.stdout.write(`\n结果：${results.length - bad.length} 通过，${bad.length} 失败\n`);
process.exit(bad.length > 0 ? 1 : 0);
void readFileSync;
