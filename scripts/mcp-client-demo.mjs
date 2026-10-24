/**
 * MCP 客户端示例：真正以 MCP 协议（stdio JSON-RPC）驱动 strata-mcp，
 * 从壁纸文件夹挑几张猫图，做「通道剥离」与「饱和度增强」两类调色，
 * 结果输出到桌面。
 *
 * 这个脚本刻意**不直接 import 任何 lib/** —— 它跟外部 AI 客户端（Claude Desktop
 * 等）走完全相同的路径：起 stdio 子进程 → initialize → tools/list → tools/call。
 * 所以跑通它，就等于证明这个 MCP 服务器对外部客户端是可用的。
 *
 * 用法：node scripts/mcp-client-demo.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "mcp", "strata-mcp.mjs");

const WALLPAPER = "C:\\Users\\ASUS\\Pictures\\壁纸";
const OUT_DIR = "C:\\Users\\ASUS\\Desktop\\StrataMCP猫图调色";

/* ------------------------------------------------------------ MCP 会话 */

class McpClient {
  constructor() {
    this.proc = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.id = 0;
    this.pending = new Map();
    this.buffer = "";
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      // 一条一条地切：stdio 上一行一个 JSON-RPC 消息
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
          /* 非 JSON 行（比如服务器的 stderr 混入）直接忽略 */
        }
      }
    });
    this.proc.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));
  }

  request(method, params) {
    this.id += 1;
    const id = this.id;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(body + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`请求超时：${method}`));
        }
      }, 60000);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "strata-demo-client", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    return res;
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return res.tools ?? [];
  }

  /** 调工具并把 result.content[0].text 里的 JSON 解析出来。 */
  async call(name, args) {
    const res = await this.request("tools/call", { name, arguments: args ?? {} });
    const text = res.content?.[0]?.text ?? "{}";
    return { parsed: JSON.parse(text), isError: Boolean(res.isError) };
  }

  close() {
    try {
      this.proc.kill();
    } catch {
      /* 已经退出就算了 */
    }
  }
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 三类「剥离颜色通道」+ 一类「饱和度增强」。
 * 通道混合器的权重语义见 mcp/lib/imageOps.mjs —— 输出通道由输入通道加权合成，
 * 所以「只剩红」就是让绿蓝输出通道的权重全为 0。
 */
const RECIPES = [
  {
    key: "只留红",
    suffix: "-只留红",
    ops: [{ type: "channelMixer", red: { r: 100, g: 0, b: 0 }, green: {}, blue: {} }],
  },
  {
    key: "只留黄",
    suffix: "-只留黄RG",
    // 黄 = 红 + 绿：蓝输出通道权重全零即可
    ops: [
      {
        type: "channelMixer",
        red: { r: 100, g: 0, b: 0 },
        green: { r: 0, g: 100, b: 0 },
        blue: {},
      },
    ],
  },
  {
    key: "只留绿",
    suffix: "-只留绿",
    ops: [{ type: "channelMixer", red: {}, green: { r: 0, g: 100, b: 0 }, blue: {} }],
  },
  {
    key: "饱和度增强",
    suffix: "-饱和度增强",
    ops: [
      { type: "saturation", amount: 55 },
      { type: "vibrance", amount: 40 },
      { type: "brightnessContrast", brightness: 4, contrast: 12 },
    ],
  },
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = new McpClient();

  try {
    const init = await client.initialize();
    console.log(`已连上服务器：${init.serverInfo?.name} v${init.serverInfo?.version}`);

    const tools = await client.listTools();
    console.log(`可用工具 ${tools.length} 个：${tools.map((t) => t.name).join(", ")}`);

    const picks = ["1000046.jpg", "1000591.jpg", "2000976.jpg"];

    for (const file of picks) {
      const source = `${WALLPAPER}\\${file}`;
      console.log(`\n── 处理 ${file}`);

      for (const recipe of RECIPES) {
        const target = join(OUT_DIR, file.replace(/\.jpg$/i, "") + recipe.suffix + ".jpg");
        const { parsed, isError } = await client.call("strata_edit_image", {
          source,
          target,
          ops: recipe.ops,
          quality: 92,
        });
        if (isError) {
          console.log(`  ✗ ${recipe.key}：${parsed.error}`);
          continue;
        }
        console.log(
          `  ✓ ${recipe.key} → ${target.split("\\").pop()}（${parsed.width}×${parsed.height}，${(parsed.bytes / 1024).toFixed(0)} KB）`,
        );
      }
    }

    // 顺便验证一下「会话」路径（打开→多次调整→导出），证明两条都能走通
    console.log("\n── 会话模式验证");
    const opened = await client.call("strata_open_image", {
      path: `${WALLPAPER}\\1000046.jpg`,
      maxSide: 1200,
    });
    const sessionId = opened.parsed.sessionId;
    console.log(`  会话 ${sessionId}：${opened.parsed.width}×${opened.parsed.height}`);

    await client.call("strata_adjust_image", {
      sessionId,
      ops: [
        { type: "levels", shadowIn: 12, highlightIn: 236, gamma: 1.15 },
        { type: "whiteBalance", temp: 8, tint: -3 },
        { type: "saturation", amount: 40 },
      ],
    });
    await client.call("strata_filter_image", {
      sessionId,
      filter: "unsharpMask",
      radius: 1.6,
      amount: 85,
      threshold: 3,
    });
    const exported = await client.call("strata_export_image", {
      sessionId,
      path: join(OUT_DIR, "1000046-会话模式-胶片味.jpg"),
      quality: 92,
    });
    console.log(`  ✓ 导出 ${exported.parsed.width}×${exported.parsed.height} → ${(exported.parsed.bytes / 1024).toFixed(0)} KB`);

    console.log(`\n全部完成，输出目录：${OUT_DIR}`);
  } finally {
    client.close();
  }
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
