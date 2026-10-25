/**
 * MCP 合成工作流：拆猫 → 留背景 → 换猫 → 分区调色 → 自然光 → 背景光效。
 *
 * 与 mcp-client-demo.mjs 同一套客户端（stdio JSON-RPC），不 import 任何 lib，
 * 走的路径和外部 AI 客户端完全一致，跑通即证明整条链路对外可用。
 *
 * 流程（摄影逻辑顺序）：
 *   1. 打开灰猫（1000046）→ 拆走主体、留背景、洞自动填补 → 背景板
 *   2. 背景板先打光：主体身后的暖金光斑 + 右上冷色辅光（光在猫后面，猫保持锐利）
 *   3. 打开橙白小猫（2000949）→ 抠出主体
 *   4. 合成：小猫贴到背景板 + 接触阴影「钉」在画面里
 *   5. 分区调色：暗部冷、中间调微暖、高光提亮的哑光胶片感 + 白平衡 + 自然饱和度
 *   6. 自然光：左上暖光束斜打进来 + 轻微曝光提升
 *   7. 暗角聚焦 → 导出
 *
 * 用法：node scripts/mcp-composite-demo.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "mcp", "strata-mcp.mjs");

const WALLPAPER = "C:\\Users\\ASUS\\Pictures\\壁纸";
const BG_SOURCE = `${WALLPAPER}\\1000046.jpg`; // 灰猫：负责出背景板（奶油墙 + 深色衣）
const CAT_SOURCE = `${WALLPAPER}\\325376.jpg`; // 橘白小猫：负责上台（浅灰虚化地面，好抠）
const OUT_DIR = "C:\\Users\\ASUS\\Desktop\\StrataMCP猫图合成";

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
      clientInfo: { name: "strata-composite-client", version: "1.0.0" },
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

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = new McpClient();
  const step = (label, fn) => async () => {
    process.stdout.write(`\n── ${label}\n`);
    return fn();
  };

  try {
    const init = await client.initialize();
    console.log(`已连上 ${init.serverInfo?.name} v${init.serverInfo?.version}`);

    /* 1. 背景板：拆走灰猫，留背景，洞填平 */
    const opened = await client.call("strata_open_image", { path: BG_SOURCE });
    const bgId = opened.parsed.sessionId;
    console.log(`灰猫 ${opened.parsed.width}×${opened.parsed.height} 已入会话`);

    const plateRes = await client.call("strata_cutout", {
      sessionId: bgId,
      mode: "background",
      tolerance: 18,
      feather: 3,
      edgeGate: 20,
      sides: "tlr",
      inpaint: true,
    });
    if (plateRes.isError) throw new Error(`背景板失败：${plateRes.parsed.error}`);
    const plateId = plateRes.parsed.sessionId;
    console.log(`背景板就绪（洞已填补）`);

    // 中间产物落盘一张，方便人工检查抠图质量
    await client.call("strata_export_image", {
      sessionId: plateId,
      path: join(OUT_DIR, "step1-背景板.png"),
    });

    /* 2. 背景光效（此时打，光就在猫后面） */
    const glowRes = await client.call("strata_light", {
      sessionId: plateId,
      effects: [
        // 暖金主光斑：在小猫将要站的位置身后
        { type: "glow", cx: 1000, cy: 560, radius: 780, color: [255, 214, 150], strength: 0.5, falloff: 2.3 },
        // 右上冷色辅光：加一层冷暖对比，画面不闷
        { type: "glow", cx: 1680, cy: 160, radius: 420, color: [150, 190, 255], strength: 0.28, falloff: 2 },
      ],
    });
    if (glowRes.isError) throw new Error(`背景光失败：${glowRes.parsed.error}`);
    console.log("背景光斑已打（暖金主光 + 冷色辅光）");

    /* 3. 橙白小猫抠图 */
    const catOpened = await client.call("strata_open_image", { path: CAT_SOURCE });
    const catId = catOpened.parsed.sessionId;
    const catRes = await client.call("strata_cutout", {
      sessionId: catId,
      mode: "subject",
      tolerance: 18,
      feather: 2,
      edgeGate: 18,
    });
    if (catRes.isError) throw new Error(`小猫抠图失败：${catRes.parsed.error}`);
    const subjectId = catRes.parsed.sessionId;
    const kw = catRes.parsed.width;
    const kh = catRes.parsed.height;
    console.log(`小猫已抠出：${kw}×${kh}`);

    /* 4. 合成 + 接触阴影 */
    // 小猫等比放到 1150px 宽，底边贴住画面下沿，水平居中偏左一点
    const targetW = 1550;
    const targetH = Math.round((kh * targetW) / kw);
    const px = Math.round(960 - targetW / 2);
    // 底边正好落在画布下沿：抠图留下的硬切边被画框盖住，看不出是贴上去的
    const py = 1080 - targetH;
    const compRes = await client.call("strata_composite", {
      sessionId: plateId,
      overlay: { sessionId: subjectId },
      x: px,
      y: py,
      overlayWidth: targetW,
      opacity: 1,
    });
    if (compRes.isError) throw new Error(`合成失败：${compRes.parsed.error}`);
    let cur = compRes.parsed.sessionId;
    console.log(`小猫已上板（落点 ${px},${py}，${targetW}×${targetH}）`);

    const shadowRes = await client.call("strata_light", {
      sessionId: cur,
      effects: [
        { type: "shadow", cx: 980, cy: 1062, rx: 560, ry: 40, opacity: 0.34, blur: 26 },
      ],
    });
    if (shadowRes.isError) throw new Error(`接触阴影失败：${shadowRes.parsed.error}`);
    cur = shadowRes.parsed.sessionId;
    console.log("接触阴影已压上（猫落地了）");

    /* 5. 分区调色：哑光胶片感的分区间接定调 */
    const gradeRes = await client.call("strata_adjust_image", {
      sessionId: cur,
      ops: [
        // 暗部加青蓝、高光加暖 —— 经典的分区定调
        { type: "colorBalance", shadows: [-10, 2, 12], midtones: [4, 0, -4], highlights: [8, 2, -10] },
        // 白平衡整体偏一点点暖，室内灯光味
        { type: "whiteBalance", temp: 6, tint: -2 },
        // S 曲线：暗部再压一点、亮部再抬一点（复合通道）
        {
          type: "curves",
          points: [
            { x: 0, y: 6 },
            { x: 64, y: 58 },
            { x: 190, y: 200 },
            { x: 255, y: 250 },
          ],
        },
        // 色彩收敛靠自然饱和度，不出塑料感
        { type: "vibrance", amount: 32 },
        { type: "saturation", amount: 8 },
      ],
    });
    if (gradeRes.isError) throw new Error(`分区调色失败：${gradeRes.parsed.error}`);
    cur = gradeRes.parsed.sessionId;
    console.log(`分区调色完成：${gradeRes.parsed.applied.join(" → ")}`);

    /* 6. 自然光：左上暖光束 + 轻微曝光提升 */
    const lightRes = await client.call("strata_light", {
      sessionId: cur,
      effects: [
        { type: "beam", side: "top", extent: 0.8, color: [255, 222, 178], strength: 0.3, falloff: 1.7 },
        { type: "beam", side: "left", extent: 0.55, color: [255, 226, 190], strength: 0.18, falloff: 1.5 },
      ],
    });
    if (lightRes.isError) throw new Error(`自然光失败：${lightRes.parsed.error}`);
    cur = lightRes.parsed.sessionId;
    const expRes = await client.call("strata_adjust_image", {
      sessionId: cur,
      ops: [{ type: "exposure", ev: 0.18, offset: 0.008, gamma: 1 }],
    });
    if (expRes.isError) throw new Error(`曝光失败：${expRes.parsed.error}`);
    cur = expRes.parsed.sessionId;
    console.log("自然光已打（顶部暖光束 + 左侧补光 + 微曝光）");

    /* 7. 暗角聚焦 + 导出 */
    const vigRes = await client.call("strata_light", {
      sessionId: cur,
      effects: [{ type: "vignette", strength: 0.32, extent: 0.72 }],
    });
    if (vigRes.isError) throw new Error(`暗角失败：${vigRes.parsed.error}`);
    cur = vigRes.parsed.sessionId;

    const target = join(OUT_DIR, "成品-换猫调色打光.jpg");
    const exportRes = await client.call("strata_export_image", {
      sessionId: cur,
      path: target,
      quality: 93,
    });
    if (exportRes.isError) throw new Error(`导出失败：${exportRes.parsed.error}`);
    console.log(
      `\n✓ 成品已导出：${target}（${exportRes.parsed.width}×${exportRes.parsed.height}，${(exportRes.parsed.bytes / 1024).toFixed(0)} KB）`,
    );
    console.log(`中间产物与成品都在：${OUT_DIR}`);
  } finally {
    client.close();
  }
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
