/**
 * MCP 插画排版工作流（甲方口吻的需求：
 * 「随便挑个猫，图层拆开，各个地方分别调色，打光影，加文字做插画，
 *   突出阴影感，猫周围来个虚线框」）。
 *
 * 全程 stdio MCP 协议驱动，图层结构（自下而上）：
 *   1. 背景渐变
 *   2. 背景光晕（screen，椭圆高斯）
 *   3. 猫 · 投影（multiply，由剪影模糊生成）
 *   4. 猫 · 身体（抠图，冷调 + 底部压暗出体积）
 *   5. 猫 · 脸部（单独裁出来的一层，暖调 + 提饱和，眼睛高光）
 *   6. 猫 · 眼睛高光（小椭圆 screen）
 *   7. 虚线框（猫周围）
 *   8. 标题 / 副标题 / 页脚文字
 *
 * 用法：node scripts/mcp-illustration-demo.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "mcp", "strata-mcp.mjs");

const CAT = "C:\\Users\\ASUS\\Pictures\\壁纸\\325376.jpg"; // 橘白小猫（对比够，好抠）
const OUT_DIR = "C:\\Users\\ASUS\\Desktop\\StrataMCP插画";

const W = 1080;
const H = 1350;

class McpClient {
  constructor() {
    this.proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    this.id = 0;
    this.pending = new Map();
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
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    });
    this.proc.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));
  }

  request(method, params) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`请求超时：${method}`));
        }
      }, 300000);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "strata-illustration-client", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    return res;
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

/** 调用并把错误抛出来，避免静默失败。 */
async function call(client, name, args, label) {
  const { parsed, isError } = await client.call(name, args);
  if (isError) throw new Error(`${label ?? name} 失败：${parsed.error}`);
  return parsed;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = new McpClient();

  try {
    const init = await client.initialize();
    console.log(`已连上 ${init.serverInfo?.name} v${init.serverInfo?.version}`);

    /* ---------- 1. 抠猫 ---------- */
    const opened = await call(client, "strata_open_image", { path: CAT }, "打开图");
    const imgId = opened.sessionId;
    console.log(`猫图 ${opened.width}×${opened.height} 已入会话`);

    const cut = await call(
      client,
      "strata_cutout",
      { sessionId: imgId, mode: "subject", tolerance: 18, feather: 2, edgeGate: 18 },
      "抠猫",
    );
    const catId = cut.sessionId;
    console.log(`猫主体 ${cut.width}×${cut.height} 已抠出`);

    /* ---------- 2. 建文档 + 背景 ---------- */
    const doc = await call(
      client,
      "strata_doc_new",
      { width: W, height: H, background: [246, 238, 228] },
      "建文档",
    );
    const docId = doc.docId;

    // 背景渐变层（替换掉纯色底）：用渐变盖住整幅
    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "gradient",
        x: 0,
        y: 0,
        width: W,
        height: H,
        angle: 115,
        stops: [
          { at: 0, color: "#fff6ea" },
          { at: 0.52, color: "#f6e3d2" },
          { at: 1, color: "#e3c3ae" },
        ],
        name: "背景渐变",
      },
      "背景渐变",
    );

    // 背景光晕：椭圆填充 + 大模糊 + screen，让猫身后亮起来
    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "ellipse",
        x: 40,
        y: 210,
        width: 1000,
        height: 1000,
        fill: "#ffd7a2",
        blur: 120,
        blend: "screen",
        opacity: 0.75,
        name: "背景光晕",
      },
      "背景光晕",
    );

    /* ---------- 3. 猫身（先加，投影会自动插到它下面） ---------- */
    const catW = 760;
    const catH = Math.round((cut.height * catW) / cut.width);
    const catX = Math.round((W - catW) / 2);
    const catY = 470;

    await call(
      client,
      "strata_doc_add_image",
      {
        docId,
        source: { sessionId: catId },
        x: catX,
        y: catY,
        width: catW,
        name: "猫 · 身体",
      },
      "加猫身",
    );

    // 投影：向下偏移、模糊、暖黑、正片叠底 —— 把猫「钉」在画面上
    await call(
      client,
      "strata_doc_drop_shadow",
      {
        docId,
        layer: "猫 · 身体",
        dx: 6,
        dy: 30,
        blur: 30,
        opacity: 0.4,
        color: "#5a3626",
        blend: "multiply",
        spread: 6,
      },
      "猫投影",
    );

    // 接触阴影：贴地那一圈更浓一点，影子才不像「飘着」
    await call(
      client,
      "strata_doc_drop_shadow",
      {
        docId,
        layer: "猫 · 身体",
        dx: 0,
        dy: 10,
        blur: 12,
        opacity: 0.3,
        color: "#4a2a1c",
        blend: "multiply",
      },
      "接触阴影",
    );

    /* ---------- 4. 猫身分区调色：底部压暗出体积，整体偏冷 ---------- */
    await call(
      client,
      "strata_doc_adjust_layer",
      {
        docId,
        layer: "猫 · 身体",
        ops: [
          { type: "colorBalance", shadows: [-8, 0, 10], midtones: [0, 0, 0], highlights: [4, 0, -4] },
          { type: "saturation", amount: 6 },
        ],
        region: {
          type: "rect",
          x: catX - 20,
          y: catY + catH * 0.55,
          width: catW + 40,
          height: catH * 0.5,
          feather: 90,
        },
      },
      "猫身暗部",
    );

    /* ---------- 5. 拆出「脸」单独一层，单独调色 ---------- */
    // 脸在抠出的图里的位置（目测头部占左上约 58% 宽、62% 高）
    const faceCrop = {
      x: Math.round(cut.width * 0.02),
      y: Math.round(cut.height * 0.02),
      width: Math.round(cut.width * 0.58),
      height: Math.round(cut.height * 0.62),
    };
    const scale = catW / cut.width;
    await call(
      client,
      "strata_doc_add_image",
      {
        docId,
        source: { sessionId: catId },
        crop: faceCrop,
        x: Math.round(catX + faceCrop.x * scale),
        y: Math.round(catY + faceCrop.y * scale),
        width: Math.round(faceCrop.width * scale),
        name: "猫 · 脸部",
      },
      "拆脸层",
    );

    // 脸部：暖调 + 提饱和 + 提亮，和身体的冷调形成分离
    await call(
      client,
      "strata_doc_adjust_layer",
      {
        docId,
        layer: "猫 · 脸部",
        ops: [
          { type: "colorBalance", shadows: [10, 2, -6], midtones: [8, 0, -8], highlights: [10, 0, -10] },
          { type: "vibrance", amount: 26 },
          { type: "curves", points: [{ x: 0, y: 0 }, { x: 70, y: 82 }, { x: 190, y: 200 }, { x: 255, y: 255 }] },
        ],
        // 只给脸「中间」上暖调，靠大羽化把差异淡到层边之前 —— 否则矩形层的边会露出直棱
        region: {
          type: "ellipse",
          cx: Math.round(catX + faceCrop.x * scale + faceCrop.width * scale * 0.42),
          cy: Math.round(catY + faceCrop.y * scale + faceCrop.height * scale * 0.5),
          rx: Math.round(faceCrop.width * scale * 0.46),
          ry: Math.round(faceCrop.height * scale * 0.46),
          feather: 130,
        },
      },
      "脸部调色",
    );

    /* ---------- 6. 眼睛高光（插画感的点） ---------- */
    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "ellipse",
        x: Math.round(catX + catW * 0.17),
        y: Math.round(catY + catH * 0.2),
        width: 54,
        height: 54,
        fill: "#fff3d0",
        blur: 12,
        blend: "screen",
        opacity: 0.9,
        name: "眼睛高光",
      },
      "眼睛高光",
    );

    /* ---------- 7. 猫周围的虚线框 ---------- */
    const framePad = 46;
    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "rect",
        x: catX - framePad,
        y: catY - framePad,
        width: catW + framePad * 2,
        height: catH + framePad * 2,
        stroke: "#fffaf0",
        strokeWidth: 4,
        dash: [18, 14],
        radius: 28,
        opacity: 0.85,
        name: "虚线框",
      },
      "虚线框",
    );

    // 顶部暖光：从画面顶端斜下来的柔光，给标题压出层次
    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "ellipse",
        x: 120,
        y: -160,
        width: W - 240,
        height: 620,
        fill: "#fff2dc",
        blur: 150,
        blend: "screen",
        opacity: 0.55,
        name: "顶部暖光",
      },
      "顶部暖光",
    );

    // 海报外框：细实线，收边用
    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "rect",
        x: 40,
        y: 40,
        width: W - 80,
        height: H - 80,
        stroke: "#ffffff",
        strokeWidth: 2,
        opacity: 0.55,
        name: "外框",
      },
      "外框",
    );

    /* ---------- 8. 文字 ---------- */
    await call(
      client,
      "strata_doc_add_text",
      {
        docId,
        text: "橘 猫",
        x: 92,
        y: 96,
        size: 112,
        weight: 900,
        color: "#ffffff",
        letterSpacing: 14,
        shadow: { color: "#8a5a3a", blur: 18, x: 0, y: 8, alpha: 0.55 },
        name: "标题",
      },
      "标题",
    );

    await call(
      client,
      "strata_doc_add_text",
      {
        docId,
        text: "ORANGE  KITTEN",
        x: 100,
        y: 258,
        size: 28,
        weight: 700,
        color: "#a4714f",
        letterSpacing: 12,
        opacity: 1,
        name: "英文副题",
      },
      "英文副题",
    );

    // 页脚：三行小字，讲这版做了什么（甲方最爱看）
    await call(
      client,
      "strata_doc_add_text",
      {
        docId,
        text: "图层拆分 · 分区调色 · 光影塑造",
        x: 92,
        y: H - 150,
        size: 30,
        weight: 600,
        color: "#fffaf2",
        letterSpacing: 4,
        shadow: { color: "#7a4a2e", blur: 10, x: 0, y: 4, alpha: 0.45 },
        name: "页脚",
      },
      "页脚",
    );

    await call(
      client,
      "strata_doc_add_text",
      {
        docId,
        text: "STRATA · MCP 插画排版",
        x: 92,
        y: H - 96,
        size: 22,
        weight: 500,
        color: "#fff3e4",
        letterSpacing: 6,
        opacity: 0.75,
        name: "署名",
      },
      "署名",
    );

    /* ---------- 9. 预览 + 导出 ---------- */
    const preview = await call(client, "strata_doc_preview", { docId, maxSide: 520 }, "预览");
    console.log(`预览 ${preview.width}×${preview.height}（base64 ${preview.base64.length} 字符）`);

    const exported = await call(
      client,
      "strata_doc_export",
      { docId, path: join(OUT_DIR, "插画-橘猫.png") },
      "导出",
    );
    console.log(
      `\n✓ 导出：${exported.path}（${exported.width}×${exported.height}，${exported.layers} 层，${(exported.bytes / 1024).toFixed(0)} KB）`,
    );
  } finally {
    client.close();
  }
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
