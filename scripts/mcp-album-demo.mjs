/**
 * MCP 相册工作流（Mark 5）：
 * 「把猫做成相册一样的挂钩链子 —— 自己画挂钩、充分用图层、放大缩小关节、
 *   每只猫单独裁剪调色打光、整体打光、胶封质感、玻璃膜、贴边细虚线框、阴影」。
 *
 * 全程 stdio MCP 协议驱动。图层结构（自下而上）：
 *   1. 墙面渐变 + 木挂杆（带投影）
 *   2. 三个手绘矢量挂钩（双描边出金属感）
 *   3. 三条矢量链子（椭圆环沿悬链线排布）
 *   4. 每只猫一组：背后光晕 → 猫层（单独调色）→ 关节旋转缩放 → 投影 → 胶封 → 贴边虚线
 *   5. 挂环（压在猫顶上，链子穿过去）
 *   6. 全局光晕 ×3
 *   7. 文字（标题 / 英文副题 / 页脚）
 *   8. 玻璃膜（最上面）
 *
 * 用法：node scripts/mcp-album-demo.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "mcp", "strata-mcp.mjs");
const WALLPAPER = "C:\\Users\\ASUS\\Pictures\\壁纸";
const OUT_DIR = "C:\\Users\\ASUS\\Desktop\\StrataMCP相册";

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
      clientInfo: { name: "strata-album-client", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    return res;
  }

  async call(name, args) {
    const res = await this.request("tools/call", { name, arguments: args ?? {} });
    const text = res.content?.[0]?.text ?? "{}";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`工具 ${name} 返回非 JSON：${text.slice(0, 300)}`);
    }
    return { parsed, isError: Boolean(res.isError) };
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

/* ---------------------------------------------------------- 矢量元素构造 */

/** 单只挂钩：安装板 + J 形钩身。返回 path 指令（局部坐标，(0,0)=板中心顶）。 */
function hookCommands() {
  return [
    // 安装板
    { op: "M", x: -30, y: 0 },
    { op: "L", x: 30, y: 0 },
    { op: "L", x: 30, y: 16 },
    { op: "L", x: -30, y: 16 },
    { op: "Z" },
    // 钩身：脖子向下，再向左卷一个 J
    { op: "M", x: 0, y: 14 },
    { op: "L", x: 0, y: 46 },
    { op: "C", x1: 0, y1: 72, x2: -40, y2: 74, x: -40, y: 50 },
    { op: "C", x1: -40, y1: 38, x2: -30, y2: 32, x: -20, y: 34 },
  ];
}

/** 链子：从 (x1,y1) 到 (x2,y2) 的椭圆环链。返回 path 指令。 */
function chainCommands(x1, y1, x2, y2, linkLen = 26, rx = 7, ry = 13) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  const n = Math.max(2, Math.round(dist / linkLen));
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const cmds = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i + 0.5) / n;
    const cx = x1 + dx * t;
    const cy = y1 + dy * t;
    const rot = i % 2 === 0 ? ang : ang + 90;
    // canvas 椭圆弧起点 = 圆心 + (rx·cosθ, ry·sinθ)，先 moveTo 断开子路径
    const rad = (rot * Math.PI) / 180;
    const sx = cx + rx * Math.cos(rad);
    const sy = cy + ry * Math.sin(rad);
    cmds.push({ op: "M", x: sx, y: sy });
    cmds.push({ op: "A", rx, ry, rot, x: cx, y: cy });
  }
  return cmds;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = new McpClient();

  try {
    const init = await client.initialize();
    console.log(`已连上 ${init.serverInfo?.name} v${init.serverInfo?.version}`);

    /* ---------- 1. 文档 + 墙面 ---------- */
    const docRes = await call(
      client,
      "strata_doc_new",
      { width: W, height: H, background: [244, 232, 216] },
      "新建文档",
    );
    const docId = docRes.docId;

    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "gradient",
        width: W,
        height: H,
        stops: [
          { at: 0, color: "#f7ecdc" },
          { at: 0.55, color: "#f0dcc4" },
          { at: 1, color: "#e3c9ad" },
        ],
        angle: 90,
        name: "墙面渐变",
      },
      "墙面渐变",
    );

    // 木挂杆 + 投影
    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "rect",
        x: 60,
        y: 66,
        width: W - 120,
        height: 34,
        fill: "#8a5a34",
        radius: 8,
        name: "木挂杆",
      },
      "木挂杆",
    );
    await call(
      client,
      "strata_doc_drop_shadow",
      { docId, layer: "木挂杆", dx: 0, dy: 8, blur: 14, opacity: 0.35, color: "#3a2415" },
      "挂杆投影",
    );
    // 杆身高光
    await call(
      client,
      "strata_doc_add_shape",
      {
        docId,
        shape: "rect",
        x: 66,
        y: 70,
        width: W - 132,
        height: 6,
        fill: "#c89a68",
        radius: 3,
        opacity: 0.8,
        name: "挂杆高光",
      },
      "挂杆高光",
    );

    /* ---------- 2. 三只猫的素材准备（抠图 + 各自调色） ---------- */
    // 每只猫：{ file, cutout 参数, 调色算子, 展示宽, 挂点 x, 顶部 y, 关节角度, 背后光晕 }
    const cats = [
      {
        name: "橘",
        layer: "猫 · 橘",
        file: `${WALLPAPER}\\325376.jpg`,
        cutout: { tolerance: 10, edgeGate: 22, feather: 2 },
        ops: [
          { type: "exposure", ev: 0.18 },
          { type: "colorBalance", shadows: [8, 0, -6], midtones: [14, 4, -10], highlights: [10, 4, -6] },
          { type: "vibrance", amount: 22 },
          { type: "curves", points: [{ x: 0, y: 0 }, { x: 68, y: 80 }, { x: 190, y: 202 }, { x: 255, y: 255 }] },
        ],
        width: 470,
        cx: 250,
        top: 268,
        angle: -4,
        glow: { color: "#ffd9a0", strength: 0.4, radius: 330 },
        contour: "#a0522d",
      },
      {
        name: "雪",
        layer: "猫 · 雪",
        file: `${WALLPAPER}\\316581.jpg`,
        cutout: { tolerance: 18, edgeGate: 20, feather: 2 },
        crop: { x: 20, y: 0, width: 680, height: 950 }, // 裁掉下部没抠净的暗影
        ops: [
          { type: "exposure", ev: 0.3 },
          { type: "whiteBalance", temp: -12, tint: 2 },
          { type: "colorBalance", shadows: [-6, 2, 12], midtones: [-4, 0, 8], highlights: [0, 2, 6] },
          { type: "vibrance", amount: 12 },
        ],
        width: 250,
        cx: 540,
        top: 250,
        angle: 3,
        glow: { color: "#cfe4ff", strength: 0.4, radius: 300 },
        contour: "#4a6a8a",
      },
      {
        name: "斑",
        layer: "猫 · 斑",
        file: `${WALLPAPER}\\322931.jpg`,
        cutout: { tolerance: 18, edgeGate: 20, feather: 2 },
        ops: [
          { type: "exposure", ev: 0.1 },
          { type: "colorBalance", shadows: [-4, 2, 8], midtones: [6, 0, -4], highlights: [4, 0, -2] },
          { type: "vibrance", amount: 16 },
          { type: "curves", points: [{ x: 0, y: 0 }, { x: 72, y: 84 }, { x: 188, y: 200 }, { x: 255, y: 255 }] },
        ],
        width: 340,
        cx: 830,
        top: 278,
        angle: -3,
        glow: { color: "#ffe0b8", strength: 0.36, radius: 320 },
        contour: "#6a4a3a",
      },
    ];

    for (const cat of cats) {
      const opened = await call(
        client,
        "strata_open_image",
        { path: cat.file },
        `打开 ${cat.name}`,
      );
      const cut = await call(
        client,
        "strata_cutout",
        { sessionId: opened.sessionId, mode: "subject", ...cat.cutout },
        `抠图 ${cat.name}`,
      );
      console.log(`  ${cat.name} 抠出 ${cut.width}×${cut.height}`);
      await call(
        client,
        "strata_adjust_image",
        { sessionId: cut.sessionId, ops: cat.ops },
        `调色 ${cat.name}`,
      );
      cat.sessionId = cut.sessionId;
      cat.srcW = cut.width;
      cat.srcH = cut.height;
    }

    /* ---------- 3. 挂钩（手绘矢量，双描边出金属感） ---------- */
    const hookXs = cats.map((c) => c.cx);
    for (const hx of hookXs) {
      const baseY = 84; // 安装板顶
      await call(
        client,
        "strata_doc_add_path",
        {
          docId,
          commands: hookCommands(),
          x: hx,
          y: baseY,
          stroke: "#5c3d22",
          strokeWidth: 11,
          fill: "#4a3320",
          name: `挂钩底 ${hx}`,
        },
        "挂钩底",
      );
      await call(
        client,
        "strata_doc_add_path",
        {
          docId,
          commands: hookCommands(),
          x: hx,
          y: baseY,
          stroke: "#d9b98a",
          strokeWidth: 3.5,
          name: `挂钩高光 ${hx}`,
        },
        "挂钩高光",
      );
    }

    /* ---------- 4. 猫层 + 光晕（先晕后猫，晕在猫后面） ---------- */
    for (const cat of cats) {
      // 背后光晕：把猫从墙上「垫」出来
      await call(
        client,
        "strata_doc_add_glow",
        {
          docId,
          cx: cat.cx,
          cy: cat.top + 180,
          radius: cat.glow.radius,
          color: cat.glow.color,
          strength: cat.glow.strength,
          falloff: 2.2,
          blend: "screen",
          name: `${cat.name} 背光`,
        },
        `${cat.name} 背光`,
      );

      const added = await call(
        client,
        "strata_doc_add_image",
        {
          docId,
          source: { sessionId: cat.sessionId },
          width: cat.width,
          ...(cat.crop ? { crop: cat.crop } : {}),
          x: cat.cx - Math.round(cat.width / 2),
          y: cat.top,
          name: cat.layer,
        },
        `上墙 ${cat.name}`,
      );
      const placed = added.layers.find((l) => l.name === cat.layer);
      console.log(`  ${cat.name} 上墙 ${placed.size} @ ${placed.at}`);

      // 关节变换：绕顶部挂点微转 + 轻微缩放（像真的挂在链子上晃）
      await call(
        client,
        "strata_doc_transform_layer",
        {
          docId,
          layer: cat.layer,
          scaleX: 1.02,
          angle: cat.angle,
          pivot: { x: cat.srcW / 2, y: 0 }, // 关节 = 顶部中点
        },
        `关节 ${cat.name}`,
      );

      // 投影：剪影模糊，暖黑 multiply
      await call(
        client,
        "strata_doc_drop_shadow",
        {
          docId,
          layer: cat.layer,
          dx: 14,
          dy: 26,
          blur: 26,
          opacity: 0.4,
          color: "#2e1a0e",
          blend: "multiply",
        },
        `${cat.name} 投影`,
      );

      // 胶封质感
      await call(
        client,
        "strata_doc_layer_effect",
        { docId, layer: cat.layer, effect: "gloss", rim: 0.5, sheen: 0.42, strength: 1 },
        `${cat.name} 胶封`,
      );

      // 贴边虚线（描着剪影走，不是独立方框）
      await call(
        client,
        "strata_doc_add_contour",
        {
          docId,
          layer: cat.layer,
          stroke: cat.contour,
          strokeWidth: 3.5,
          dashOn: 16,
          dashOff: 11,
          name: `${cat.name} 虚线`,
        },
        `${cat.name} 虚线`,
      );

      // 挂环：压在猫顶，链子从钩子下来穿过它
      await call(
        client,
        "strata_doc_add_path",
        {
          docId,
          commands: [
            { op: "M", x: 8, y: 0 },
            { op: "A", rx: 8, ry: 12, rot: 0, x: 0, y: 0 },
          ],
          x: cat.cx,
          y: cat.top - 4,
          stroke: "#6b4a2f",
          strokeWidth: 5,
          name: `${cat.name} 挂环`,
        },
        `${cat.name} 挂环`,
      );
    }

    /* ---------- 5. 链子（从钩尖到挂环） ---------- */
    for (const cat of cats) {
      const cmds = chainCommands(cat.cx, 158, cat.cx, cat.top - 2, 24, 6, 11);
      await call(
        client,
        "strata_doc_add_path",
        {
          docId,
          commands: cmds,
          stroke: "#7a5230",
          strokeWidth: 4.5,
          name: `链子 ${cat.name}`,
        },
        `链子 ${cat.name}`,
      );
      await call(
        client,
        "strata_doc_add_path",
        {
          docId,
          commands: cmds,
          stroke: "#e2c495",
          strokeWidth: 1.6,
          name: `链子高光 ${cat.name}`,
        },
        `链子高光 ${cat.name}`,
      );
    }

    /* ---------- 6. 全局打光 ---------- */
    await call(
      client,
      "strata_doc_add_glow",
      { docId, cx: 540, cy: 420, radius: 760, color: "#ffe8c8", strength: 0.3, falloff: 2.4, name: "全局暖光" },
      "全局暖光",
    );
    await call(
      client,
      "strata_doc_add_glow",
      { docId, cx: 180, cy: 1020, radius: 480, color: "#b8d8f8", strength: 0.16, falloff: 2.6, blend: "overlay", name: "左下冷补" },
      "左下冷补",
    );
    await call(
      client,
      "strata_doc_add_glow",
      { docId, cx: 920, cy: 240, radius: 400, color: "#ffe2b0", strength: 0.24, falloff: 2.2, name: "右上辅光" },
      "右上辅光",
    );

    /* ---------- 7. 文字 ---------- */
    await call(
      client,
      "strata_doc_add_text",
      {
        docId,
        text: "喵 · 悬挂相馆",
        x: 0,
        y: 1088,
        size: 84,
        weight: 900,
        color: "#4a2e1a",
        letterSpacing: 10,
        align: "left",
        shadow: { color: "#000000", blur: 14, x: 0, y: 6, alpha: 0.3 },
        name: "标题",
      },
      "标题",
    );
    await call(
      client,
      "strata_doc_add_text",
      {
        docId,
        text: "HANGING CAT ALBUM · STRATA",
        x: 4,
        y: 1196,
        size: 28,
        weight: 700,
        color: "#a4714f",
        letterSpacing: 12,
        name: "英文副题",
      },
      "英文副题",
    );
    await call(
      client,
      "strata_doc_add_text",
      {
        docId,
        text: "矢量挂钩 · 关节变换 · 胶封质感 · 玻璃膜 · 贴边虚线",
        x: 4,
        y: 1276,
        size: 22,
        weight: 500,
        color: "#8a6a50",
        letterSpacing: 4,
        name: "页脚",
      },
      "页脚",
    );

    /* ---------- 8. 玻璃膜（最上面） ---------- */
    await call(
      client,
      "strata_doc_add_glass",
      { docId, strength: 0.2, streaks: 3, blend: "screen", opacity: 0.9, name: "玻璃膜" },
      "玻璃膜",
    );

    /* ---------- 9. 导出 ---------- */
    const outPath = `${OUT_DIR}\\相册-悬挂的猫.png`;
    const exported = await call(client, "strata_doc_export", { docId, path: outPath }, "导出");
    console.log(`已导出：${exported.path}（${exported.width}×${exported.height}，${exported.layers} 层）`);

    /* ---------- 10. 存可编辑 .strata 工程（原版工程，可继续编辑/撤销） ---------- */
    const projPath = `${OUT_DIR}\\相册-悬挂的猫.strata`;
    const saved = await call(client, "strata_doc_save", { docId, path: projPath, name: "相册-悬挂的猫" }, "存工程");
    console.log(`已存工程：${saved.path}（${saved.layers} 层，${saved.bytes} 字节）`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
