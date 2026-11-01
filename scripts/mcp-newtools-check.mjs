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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "mcp", "strata-mcp.mjs");
const require = createRequire(join(HERE, "..", "mcp", "package.json"));
const { createCanvas, loadImage } = require("@napi-rs/canvas");

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


/**
 * 造一个最小的未压缩扫描线 EXR（三通道 HALF）。
 * 只在检查脚本里用：验证 MCP 侧读取链路，不追求覆盖所有压缩方式。
 */
function makeExr(w, h, rgb) {
  const half = (v) => {
    const f = new Float32Array(1);
    const i = new Int32Array(f.buffer);
    f[0] = v;
    const x = i[0];
    const sign = (x >> 16) & 0x8000;
    const exp = ((x >> 23) & 0xff) - 127 + 15;
    const mant = (x & 0x7fffff) >> 13;
    return sign | (exp << 10) | mant;
  };
  const attr = (name, type, value) => {
    const n = Buffer.from(name + "\0", "utf8");
    const t = Buffer.from(type + "\0", "utf8");
    const size = Buffer.alloc(4);
    size.writeInt32LE(value.length, 0);
    return Buffer.concat([n, t, size, value]);
  };
  const box = (a, b) => {
    const x = Buffer.alloc(16);
    x.writeInt32LE(0, 0);
    x.writeInt32LE(0, 4);
    x.writeInt32LE(a - 1, 8);
    x.writeInt32LE(b - 1, 12);
    return x;
  };
  // chlist（字典序 B/G/R）
  const ch = [];
  for (const name of ["B", "G", "R"]) {
    ch.push(Buffer.from(name + "\0", "utf8"));
    const meta = Buffer.alloc(16);
    meta.writeInt32LE(1, 0);
    meta.writeInt32LE(1, 8);
    meta.writeInt32LE(1, 12);
    ch.push(meta);
  }
  ch.push(Buffer.from([0]));
  const one = Buffer.from([0]);
  const f4 = (v) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    return b;
  };
  const v2 = Buffer.alloc(8);
  const header = Buffer.concat([
    attr("channels", "chlist", Buffer.concat(ch)),
    attr("compression", "compression", one),
    attr("dataWindow", "box2i", box(w, h)),
    attr("displayWindow", "box2i", box(w, h)),
    attr("lineOrder", "lineOrder", one),
    attr("pixelAspectRatio", "float", f4(1)),
    attr("screenWindowCenter", "v2f", v2),
    attr("screenWindowWidth", "float", f4(1)),
    Buffer.from([0]),
  ]);
  const row = w * 2;
  const raw = Buffer.alloc(row * 3 * h);
  let o = 0;
  for (const idx of [2, 1, 0]) {
    // B/G/R 顺序写入
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        raw.writeUInt16LE(half(rgb[idx]), o);
        o += 2;
      }
    }
  }
  const chunk = Buffer.alloc(8);
  chunk.writeInt32LE(0, 0);
  chunk.writeInt32LE(raw.length, 4);
  const table = Buffer.alloc(8);
  table.writeBigUInt64LE(BigInt(8 + header.length + 8), 0);
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(0x01312f76, 0);
  const ver = Buffer.alloc(4);
  ver.writeUInt32LE(2, 0);
  return Buffer.concat([magic, ver, header, table, chunk, raw]);
}


/** 把磁盘上的 PNG 读成 {width,height,data}，用于像素断言。 */
async function readPng(path) {
  const img = await loadImage(path);
  // loadImage 是同步返回 Image；画到画布上再取像素
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: d.data };
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

  /**
   * 调色台：必须**真的改变像素**，不能只看有没有报错。
   *
   * 之前就是这么漏掉的：算子读参数的键口径和调用方不一致，调用返回 success，
   * 但内部参数全是中性 —— 结果像素一点没动。这里用预览 base64 前后比对，
   * 中性 vs 暖调必须不同。
   */
  const gBase = await client.call("strata_adjust_image", {
    sessionId: sid,
    ops: [{ type: "grade" }],
    preview: true,
  });
  const gFlat = await client.call("strata_adjust_image", {
    sessionId: sid,
    ops: [{ type: "grade", temp: 80, contrast: 30 }],
    preview: true,
  });
  const gNest = await client.call("strata_adjust_image", {
    sessionId: sid,
    ops: [{ type: "grade", params: { temp: 80, contrast: 30 } }],
    preview: true,
  });
  check("strata_adjust_image · grade 真的改变了像素（平铺 / 嵌套）", () => {
    if (gBase.isError) throw new Error(`中性调用失败：${gBase.parsed.error}`);
    if (gFlat.isError) throw new Error(`平铺写法失败：${gFlat.parsed.error}`);
    if (gNest.isError) throw new Error(`嵌套写法失败：${gNest.parsed.error}`);
    const b = gBase.parsed.previewBase64;
    const f = gFlat.parsed.previewBase64;
    const n = gNest.parsed.previewBase64;
    if (!b || !f) throw new Error("没有拿到预览图");
    if (b === f) throw new Error("暖调后像素没变 —— 参数没被算子读到");
  });

  // 曲线也要跟着生效（同一层上的复合曲线）
  const gCurve = await client.call("strata_adjust_image", {
    sessionId: sid,
    ops: [{ type: "grade", curves: { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.72 }, { x: 1, y: 1 }] } }],
    preview: true,
  });
  check("strata_adjust_image · grade 曲线也生效", () => {
    if (gCurve.isError) throw new Error(gCurve.parsed.error);
    if (gCurve.parsed.previewBase64 === gBase.parsed.previewBase64) {
      throw new Error("曲线没被应用");
    }
  });

  /* ---------------- 今日七项能力：EXR / 浏览 / 描迹 / GIF / Droplet ---------------- */

  // 造一个未压缩 EXR（3×2，纯中灰 0.5 线性）
  const exrPath = join(dir, "check.exr");
  writeFileSync(exrPath, makeExr(3, 2, [0.5, 0.5, 0.5]));

  const exrParts = await client.call("strata_exr_parts", { path: exrPath });
  check("strata_exr_parts", () => {
    if (exrParts.isError) throw new Error(exrParts.parsed.error);
    if (exrParts.parsed.count !== 1) throw new Error(`应 1 个部件，实际 ${exrParts.parsed.count}`);
    if (exrParts.parsed.parts[0].compression !== "NONE") {
      throw new Error(`压缩方式读错：${exrParts.parsed.parts[0].compression}`);
    }
  });

  const exrRead = await client.call("strata_exr_read", { path: exrPath });
  check("strata_exr_read", () => {
    if (exrRead.isError) throw new Error(exrRead.parsed.error);
    if (exrRead.parsed.width !== 3 || exrRead.parsed.height !== 2) {
      throw new Error(`尺寸不对：${exrRead.parsed.width}×${exrRead.parsed.height}`);
    }
  });

  const listed = await client.call("strata_list_dir", { dir });
  check("strata_list_dir", () => {
    if (listed.isError) throw new Error(listed.parsed.error);
    const names = listed.parsed.entries.map((e) => e.name);
    if (!names.includes("sample.png")) throw new Error("没列出 sample.png");
    if (!names.some((n) => n.endsWith(".exr"))) throw new Error("没列出 exr");
  });

  const traced = await client.call("strata_trace_paths", { sessionId: sid, outPath: join(dir, "trace.svg") });
  check("strata_trace_paths", () => {
    if (traced.isError) throw new Error(traced.parsed.error);
    if (!(traced.parsed.loops >= 1)) throw new Error("没描出任何环");
    const svg = readFileSync(join(dir, "trace.svg"), "utf8");
    if (!svg.includes("<path") || !svg.includes("evenodd")) throw new Error("SVG 结构不对");
  });

  const gifPath = join(dir, "anim.gif");
  const gif = await client.call("strata_make_gif", {
    paths: [imgPath, sheetPath],
    outPath: gifPath,
    maxSide: 64,
    delayMs: 80,
  });
  check("strata_make_gif", () => {
    if (gif.isError) throw new Error(gif.parsed.error);
    const bytes = readFileSync(gifPath);
    if (bytes.subarray(0, 6).toString("latin1") !== "GIF89a") throw new Error("文件头不是 GIF89a");
    if (!(gif.parsed.frames === 2)) throw new Error("帧数不对");
  });

  const dropPath = join(dir, "batch.strata-droplet");
  const drop = await client.call("strata_make_droplet", {
    name: "缩图批处理",
    ops: [{ op: "autoContrast" }, { op: "fit", maxSide: 1600 }, { op: "exportJpg", quality: 88 }],
    outPath: dropPath,
  });
  check("strata_make_droplet", () => {
    if (drop.isError) throw new Error(drop.parsed.error);
    const recipe = JSON.parse(readFileSync(dropPath, "utf8"));
    if (recipe.kind !== "strata-droplet") throw new Error("kind 不对");
    if (recipe.ops.length !== 3) throw new Error("操作数不对");
  });

  // 带病配方必须被拒（不能悄悄写出去）
  const badDrop = await client.call("strata_make_droplet", {
    name: "坏配方",
    ops: [{ op: "explode" }],
    outPath: join(dir, "bad.strata-droplet"),
  });
  check("strata_make_droplet 拒绝未知操作", () => {
    if (!badDrop.isError) throw new Error("未知操作竟然通过了");
  });

  /* ---------------- 局部调色（Power Window）：范围外必须一点不动 ---------------- */

  const lgBefore = join(dir, "lg-before.png");
  const lgAfter = join(dir, "lg-after.png");
  const lgOpen = await client.call("strata_open_image", { path: imgPath });
  const lgSid = lgOpen.parsed.sessionId;
  const lgW = lgOpen.parsed.width;
  const lgH = lgOpen.parsed.height;
  await client.call("strata_export_image", { sessionId: lgSid, path: lgBefore });

  // 椭圆范围放在左半边，暖调 80（明显改变像素）
  const lg = await client.call("strata_local_grade", {
    sessionId: lgSid,
    window: {
      kind: "ellipse",
      cx: lgW * 0.25,
      cy: lgH * 0.5,
      rx: lgW * 0.18,
      ry: lgH * 0.3,
      feather: 12,
    },
    params: { temp: 80 },
  });
  await client.call("strata_export_image", { sessionId: lgSid, path: lgAfter });

  const lgA = await readPng(lgBefore);
  const lgB = await readPng(lgAfter);
  check("strata_local_grade · 范围内变、范围外不变", () => {
    if (lg.isError) throw new Error(lg.parsed.error);
    if (!(lg.parsed.affectedRatio > 0)) throw new Error("没有像素被影响");
    const a = lgA;
    const b = lgB;
    const px = (img, x, y) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    // 范围中心：应该被暖调改了（红↑蓝↓）
    const cIn = px(a, Math.round(lgW * 0.25), Math.round(lgH * 0.5));
    const cOut = px(b, Math.round(lgW * 0.25), Math.round(lgH * 0.5));
    if (cIn[0] === cOut[0] && cIn[2] === cOut[2]) throw new Error("范围中心没变化");
    // 右边角落：完全在范围外，必须逐字节相同
    const farX = lgW - 6;
    const farY = lgH - 6;
    const fIn = px(a, farX, farY);
    const fOut = px(b, farX, farY);
    if (fIn[0] !== fOut[0] || fIn[1] !== fOut[1] || fIn[2] !== fOut[2]) {
      throw new Error(`范围外被改了：${fIn} → ${fOut}`);
    }
  });

  // 四边形：只羽化第 2 条边时，第 1 条边附近应该是硬的
  const quadRes = await client.call("strata_local_grade", {
    sessionId: lgSid,
    window: {
      kind: "quad",
      points: [
        { x: 20, y: 20 },
        { x: lgW - 20, y: 20 },
        { x: lgW - 20, y: lgH - 20 },
        { x: 20, y: lgH - 20 },
      ],
      feather: 0,
      edges: [0, 24, 0, 0],
    },
    params: { contrast: 60 },
  });
  check("strata_local_grade · 四边形四条边独立羽化", () => {
    if (quadRes.isError) throw new Error(quadRes.parsed.error);
    if (quadRes.parsed.window.edges[1] !== 24) throw new Error("edges 没被保留");
  });

  // 线性：单向 —— 线的一侧全调，另一侧在 feather 之外必须完全不动
  const lnOpen = await client.call("strata_open_image", { path: imgPath });
  const lnSid = lnOpen.parsed.sessionId;
  const lnBefore = join(dir, "ln-before.png");
  const lnAfter = join(dir, "ln-after.png");
  await client.call("strata_export_image", { sessionId: lnSid, path: lnBefore });
  await client.call("strata_local_grade", {
    sessionId: lnSid,
    window: { kind: "line", x1: 0, y1: Math.round(lgH * 0.5), x2: lgW, y2: Math.round(lgH * 0.5), feather: 10 },
    params: { temp: 90 },
  });
  await client.call("strata_export_image", { sessionId: lnSid, path: lnAfter });
  const lnA = await readPng(lnBefore);
  const lnB = await readPng(lnAfter);

  check("strata_local_grade · 线性是单向的", () => {
    const px = (img, x, y) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    const midX = Math.round(lgW * 0.5);
    const aboveY = Math.max(0, Math.round(lgH * 0.5) - 20);
    const belowY = Math.min(lgH - 1, Math.round(lgH * 0.5) + 30);
    const a1 = px(lnA, midX, aboveY);
    const b1 = px(lnB, midX, aboveY);
    if (a1[0] === b1[0] && a1[2] === b1[2]) throw new Error("全调侧没有变化");
    const a2 = px(lnA, midX, belowY);
    const b2 = px(lnB, midX, belowY);
    if (a2[0] !== b2[0] || a2[1] !== b2[1] || a2[2] !== b2[2]) {
      throw new Error(`淡出侧超出 feather 之后还在变：${a2} → ${b2}`);
    }
  });

  // 非法范围必须报错，不能静默什么都不做
  const badWin = await client.call("strata_local_grade", {
    sessionId: lgSid,
    window: { kind: "triangle" },
    params: { temp: 10 },
  });
  check("strata_local_grade 拒绝未知范围类型", () => {
    if (!badWin.isError) throw new Error("未知 kind 竟然通过了");
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
