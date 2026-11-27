/**
 * WebGPU 合成端到端验证（零依赖，Node 22 + Edge headless + CDP）。
 *
 * 这里不是 mock：浏览器里真实 requestAdapter / requestDevice / createShaderModule /
 * createComputePipeline / dispatchWorkgroups / mapAsync，再用独立的 CPU 参考实现
 * 对拍 0..27 全部 shader id 的每一个像素。拿不到适配器时明确打印 SKIP 并以 0 退出，
 * 绝不把 mock 当 e2e，也不让没有 GPU 的机器把 CI 弄红。
 *
 * 运行：npm run test:e2e:gpu
 * 关闭：STRATA_GPU_E2E=off npm run test:e2e:gpu
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WGSL = readFileSync(join(ROOT, "shaders/compose.wgsl"), "utf8");
const MODES = Array.from({ length: 28 }, (_, i) => i);
const W = 16;
const H = 16;

/** 逐组尝试：不同 Edge / GPU 驱动组合可用的 WebGPU 后端并不一样。 */
const PROFILES = [
  {
    name: "vulkan-swiftshader",
    flags: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,UseSkiaRenderer",
      "--use-angle=swiftshader",
      "--use-vulkan=swiftshader",
      "--disable-vulkan-surface",
      "--ignore-gpu-blocklist",
    ],
  },
  {
    name: "unsafe-only",
    flags: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
  },
  {
    name: "angle-swiftshader",
    flags: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader",
    ],
  },
];

let edge = null;
let server = null;
let userDataDir = null;
let finished = false;

function cleanup() {
  try { edge?.kill(); } catch { /* 已退出 */ }
  try { server?.close(); } catch { /* 已关闭 */ }
  try {
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  } catch { /* 临时目录可能已被系统清理 */ }
}
process.on("exit", cleanup);

function done(code) {
  if (finished) return;
  finished = true;
  const dir = userDataDir;
  try { edge?.kill(); } catch { /* 已退出 */ }
  try { server?.close(); } catch { /* 已关闭 */ }
  // Edge 退出会稍晚释放 profile 文件；直接 process.exit 会留下临时目录。
  const finish = (attempt) => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 下一轮再试 */ }
      if (existsSync(dir) && attempt < 10) {
        setTimeout(() => finish(attempt + 1), 200);
        return;
      }
    }
    process.exit(code);
  };
  setTimeout(() => finish(0), 300);
}

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  done(0);
}

function fail(reason) {
  console.error(`FAIL: ${reason}`);
  done(1);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  const candidates = [
    process.env.EDGE_EXE,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.id) return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else slot.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP 连接失败：${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 180000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* 已关闭 */ }
  }
}

async function waitForPageTarget(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* Edge 还没起来 */ }
    await delay(100);
  }
  throw new Error("等待 Edge 页面目标超时");
}

/**
 * 在浏览器里执行的真 GPU 对拍。为了保持零依赖，这里把 CPU 参考实现也写在同一函数内，
 * 与 shaders/compose.wgsl 的公式逐条同源；任何一路结果不一致都会返回 mismatch。
 */
async function browserGpuCheck(wgsl, w, h, modes) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const EDGE = 1e-4;

  const colorDodge = (cb, cs) => {
    if (cb <= EDGE) return 0;
    if (cs >= 1) return 1;
    return Math.min(cb / (1 - cs), 1);
  };
  const colorBurn = (cb, cs) => {
    if (cb >= 1) return 1;
    if (cs <= 0) return 0;
    return 1 - Math.min((1 - cb) / cs, 1);
  };
  const vividBurn = (cb, cs) => (cs <= 0 ? 0 : 1 - Math.min((1 - cb) / cs, 1));
  const vividDodge = (cb, cs) => (cs >= 1 ? 1 : Math.min(cb / (1 - cs), 1));
  const hardLight = (cb, cs) => {
    if (cs <= 0.5) return cb * 2 * cs;
    const s = 2 * cs - 1;
    return cb + s - cb * s;
  };
  const softLight = (cb, cs) => {
    if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
    let d = Math.sqrt(Math.max(cb, 0));
    if (cb <= 0.25) d = ((16 * cb - 12) * cb + 4) * cb;
    return cb + (2 * cs - 1) * (d - cb);
  };
  const vividLight = (cb, cs) => (cs <= 0.5 ? vividBurn(cb, 2 * cs) : vividDodge(cb, 2 * cs - 1));
  const pinLight = (cb, cs) => (cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1));
  const divide = (cb, cs) => (cs <= 0 ? 1 : clamp(cb / cs, 0, 1));

  function blendChannel(mode, cb, cs) {
    switch (mode) {
      case 0: case 1: return cs;
      case 3: return Math.min(cb, cs);
      case 4: return cb * cs;
      case 5: return colorBurn(cb, cs);
      case 6: return clamp(cb + cs - 1, 0, 1);
      case 8: return Math.max(cb, cs);
      case 9: return cb + cs - cb * cs;
      case 10: return colorDodge(cb, cs);
      case 11: return clamp(cb + cs, 0, 1);
      case 13: return hardLight(cs, cb);
      case 14: return softLight(cb, cs);
      case 15: return hardLight(cb, cs);
      case 16: return vividLight(cb, cs);
      case 17: return clamp(cb + 2 * cs - 1, 0, 1);
      case 18: return pinLight(cb, cs);
      case 19: return cb + cs >= 1 ? 1 : 0;
      case 20: return Math.abs(cb - cs);
      case 21: return cb + cs - 2 * cb * cs;
      case 22: return clamp(cb - cs, 0, 1);
      case 23: return divide(cb, cs);
      default: return cs;
    }
  }

  const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const sat = (c) => Math.max(...c) - Math.min(...c);
  function clipColor(c) {
    const l = lum(c);
    const n = Math.min(...c);
    const x = Math.max(...c);
    let out = [...c];
    if (n < 0) out = out.map((v) => l + (v - l) * l / (l - n));
    if (x > 1) out = out.map((v) => l + (v - l) * (1 - l) / (x - l));
    return out.map((v) => clamp(v, 0, 1));
  }
  const setLum = (c, l) => clipColor(c.map((v) => v + l - lum(c)));
  function setSat(c, s) {
    const mx = Math.max(...c);
    const mn = Math.min(...c);
    if (mx <= mn) return [0, 0, 0];
    const mid = c[0] + c[1] + c[2] - mx - mn;
    const midOut = (mid - mn) * s / (mx - mn);
    return c.map((v) => (v <= mn ? 0 : v >= mx ? s : midOut));
  }
  function blendHsl(mode, cb, cs) {
    if (mode === 24) return setLum(setSat(cs, sat(cb)), lum(cb));
    if (mode === 25) return setLum(setSat(cb, sat(cs)), lum(cb));
    if (mode === 26) return setLum(cs, lum(cb));
    if (mode === 27) return setLum(cb, lum(cs));
    return cs;
  }
  function blendRgb(mode, cb, cs) {
    if (mode === 7) return lum(cb) <= lum(cs) ? cb : cs;
    if (mode === 12) return lum(cb) >= lum(cs) ? cb : cs;
    if (mode >= 24 && mode <= 27) return blendHsl(mode, cb, cs);
    return [0, 1, 2].map((i) => blendChannel(mode, cb[i], cs[i]));
  }
  function dissolveHash(x, y) {
    const n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
    const m = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
    return (((m ^ (m >>> 16)) >>> 8) & 0xffff) / 65536;
  }
  function composite(mode, b, s, opacity, x, y) {
    const ab = b[3];
    const as_ = s[3] * clamp(opacity, 0, 1);
    if (as_ <= 0) return b;
    if (mode === 2) {
      // WGSL 的溶解阈值是图层不透明度；被保留的像素按「源 alpha=1」正常合成。
      const aMul = clamp(opacity, 0, 1);
      if (s[3] * aMul <= 0 || dissolveHash(x, y) >= aMul) return b;
      return composite(1, b, [s[0], s[1], s[2], 1], 1, x, y);
    }
    const bl = blendRgb(mode, b.slice(0, 3), s.slice(0, 3));
    const ao = as_ + ab * (1 - as_);
    if (ao <= 0) return [0, 0, 0, 0];
    const rgb = [0, 1, 2].map((i) =>
      ((1 - as_) * ab * b[i] + (1 - ab) * as_ * s[i] + as_ * ab * bl[i]) / ao,
    );
    return [...rgb, ao];
  }

  const unpack = (bytes, i) => {
    const o = i * 4;
    return [bytes[o] / 255, bytes[o + 1] / 255, bytes[o + 2] / 255, bytes[o + 3] / 255];
  };
  const pack = (c) => c.map((v) => clamp(Math.floor(clamp(v, 0, 1) * 255 + 0.5), 0, 255));

  function cpuApply(backdrop, source, mode, opacity) {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        const q = pack(composite(mode, unpack(backdrop, i), unpack(source, i), opacity, x, y));
        out.set(q, i * 4);
      }
    }
    return out;
  }

  if (!navigator.gpu) return { status: "no-webgpu" };
  let adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    try { adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }); } catch { /* 老浏览器不支持 */ }
  }
  if (!adapter) return { status: "no-adapter" };

  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: wgsl });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error").map((m) => `${m.lineNum}: ${m.message}`);
  if (errors.length) return { status: "compile-error", errors };
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "cs_main" },
  });
  const layout = pipeline.getBindGroupLayout(0);

  const pixelBytes = w * h * 4;
  const backdrop = new Uint8Array(pixelBytes);
  const source = new Uint8Array(pixelBytes);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      backdrop[o] = (30 + x * 7) % 256;
      backdrop[o + 1] = (70 + y * 5) % 256;
      backdrop[o + 2] = (120 + ((x + y) * 3) % 100) % 256;
      backdrop[o + 3] = 200 + ((x * y) % 56);
      source[o] = (x * 31 + 17) % 256;
      source[o + 1] = (y * 47 + 31) % 256;
      source[o + 2] = ((x + y) * 23 + 11) % 256;
      source[o + 3] = 64 + ((x * 13 + y * 7) % 160);
    }
  }
  const cpuBase = cpuApply(new Uint8Array(pixelBytes), backdrop, 1, 1);

  async function gpuApply(mode) {
    const accum = device.createBuffer({ size: pixelBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const diag = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const tex = device.createTexture({
      size: { width: w, height: h },
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    const staging = device.createBuffer({ size: pixelBytes + 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    let scope = false;
    try {
      device.pushErrorScope("validation");
      scope = true;
      const bind = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: accum } },
          { binding: 2, resource: tex.createView() },
          { binding: 3, resource: { buffer: diag } },
        ],
      });
      const ub = new ArrayBuffer(16);
      const dv = new DataView(ub);
      const runLayer = (pixels, blendMode, opacity) => {
        dv.setUint32(0, blendMode, true);
        dv.setFloat32(4, opacity, true);
        dv.setUint32(8, w, true);
        dv.setUint32(12, h, true);
        device.queue.writeBuffer(uniform, 0, ub);
        device.queue.writeTexture(
          { texture: tex },
          pixels,
          { bytesPerRow: w * 4, rowsPerImage: h },
          { width: w, height: h, depthOrArrayLayers: 1 },
        );
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        pass.end();
        device.queue.submit([encoder.finish()]);
      };
      runLayer(backdrop, 1, 1);
      runLayer(source, mode, 1);

      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(accum, 0, staging, 0, pixelBytes);
      encoder.copyBufferToBuffer(diag, 0, staging, pixelBytes, 4);
      device.queue.submit([encoder.finish()]);

      await staging.mapAsync(GPUMapMode.READ);
      const copy = new Uint8Array(staging.getMappedRange().slice(0));
      staging.unmap();
      const err = await device.popErrorScope();
      scope = false;
      if (err) throw new Error(err.message);
      const fallback = new DataView(copy.buffer, copy.byteOffset + pixelBytes, 4).getUint32(0, true);
      return { pixels: copy.slice(0, pixelBytes), fallback: fallback >>> 0 };
    } finally {
      if (scope) { try { device.popErrorScope(); } catch { /* 忽略 */ } }
      try { accum.destroy(); } catch { /* 忽略 */ }
      try { uniform.destroy(); } catch { /* 忽略 */ }
      try { diag.destroy(); } catch { /* 忽略 */ }
      try { tex.destroy(); } catch { /* 忽略 */ }
      try { staging.destroy(); } catch { /* 忽略 */ }
    }
  }

  let maxDiff = 0;
  for (const mode of modes) {
    const gpu = await gpuApply(mode);
    if (gpu.fallback !== 0) {
      return { status: "mismatch", mode, reason: `fallbackMask=${gpu.fallback}` };
    }
    const cpu = cpuApply(cpuBase, source, mode, 1);
    for (let i = 0; i < pixelBytes; i += 1) {
      const diff = Math.abs(gpu.pixels[i] - cpu[i]);
      if (diff > maxDiff) maxDiff = diff;
      if (diff > 1) {
        return { status: "mismatch", mode, byte: i, gpu: gpu.pixels[i], cpu: cpu[i], reason: "像素差异超过 1" };
      }
    }
  }

  let label = "webgpu";
  try { label = adapter.info?.description || adapter.info?.vendor || label; } catch { /* 老浏览器无 info */ }
  return { status: "pass", modes: modes.length, maxDiff, adapter: label, size: `${w}x${h}` };
}

function stopBrowser() {
  try { edge?.kill(); } catch { /* 已退出 */ }
  edge = null;
  try { if (userDataDir) rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  userDataDir = null;
}

async function launchProfile(profile, pagePort, edgePath) {
  userDataDir = mkdtempSync(join(tmpdir(), "strata-gpu-e2e-"));
  edge = spawn(edgePath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    ...profile.flags,
    `http://127.0.0.1:${pagePort}/`,
  ], { stdio: "ignore" });

  let debugPort = 0;
  const portFile = join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 150; i += 1) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, "utf8").split("\n")[0]?.trim();
      if (first && Number.isFinite(Number(first))) { debugPort = Number(first); break; }
    }
    await delay(100);
  }
  if (!debugPort) throw new Error(`${profile.name}：调试端口没有就绪`);

  const targetUrl = await waitForPageTarget(debugPort);
  const cdp = await Cdp.connect(targetUrl);
  await cdp.send("Page.enable");
  for (let i = 0; i < 100; i += 1) {
    const ready = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (ready.result?.value === "complete") break;
    await delay(100);
  }
  return cdp;
}

async function probeAdapter(cdp) {
  const expression = `(async () => {
    if (!navigator.gpu) return "no-webgpu";
    let adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      try { adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }); } catch {}
    }
    return adapter ? "adapter" : "no-adapter";
  })()`;
  const evaluated = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) return `error: ${evaluated.exceptionDetails.text ?? "unknown"}`;
  return String(evaluated.result?.value ?? "no-result");
}

async function main() {
  if (String(process.env.STRATA_GPU_E2E ?? "").toLowerCase() === "off") {
    skip("STRATA_GPU_E2E=off");
  }
  const edgePath = findEdge();
  if (!edgePath) skip("未找到 Microsoft Edge，无法进行真实 WebGPU 端到端验证");

  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><head><meta charset='utf-8'><title>Strata GPU E2E</title></head><body>gpu-e2e</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const pagePort = server.address().port;

  let cdp = null;
  let profileName = "";
  let lastProbe = "";
  let lastError = null;
  for (const profile of PROFILES) {
    try {
      cdp = await launchProfile(profile, pagePort, edgePath);
      lastProbe = await probeAdapter(cdp);
      if (lastProbe === "adapter") {
        profileName = profile.name;
        break;
      }
      cdp.close();
      cdp = null;
      stopBrowser();
    } catch (e) {
      lastError = e;
      try { cdp?.close(); } catch { /* 忽略 */ }
      cdp = null;
      stopBrowser();
    }
  }
  if (!cdp) {
    skip(`所有启动组合都拿不到 WebGPU 适配器（最后状态：${lastProbe || lastError?.message || "unknown"}）`);
  }

  try {
    const expression = `(${browserGpuCheck.toString()})(${JSON.stringify(WGSL)}, ${W}, ${H}, ${JSON.stringify(MODES)})`;
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 180000,
    });
    if (evaluated.exceptionDetails) {
      fail(`页面抛出异常：${evaluated.exceptionDetails.text ?? JSON.stringify(evaluated.exceptionDetails)}`);
    }
    const report = evaluated.result?.value;
    if (!report) fail("页面没有返回结果");
    if (report.status === "no-webgpu" || report.status === "no-adapter") {
      skip(`当前 Edge 环境拿不到 WebGPU 适配器（${report.status}）`);
    }
    if (report.status === "compile-error") {
      fail(`WGSL 真编译失败：${report.errors.join(" | ")}`);
    }
    if (report.status !== "pass") {
      fail(`CPU/GPU 对拍失败：${JSON.stringify(report)}`);
    }
    console.log(JSON.stringify({ status: "PASS", profile: profileName, ...report }));
    done(0);
  } finally {
    cdp.close();
  }
}

const guard = setTimeout(() => fail("端到端验证总超时"), 200000);
guard.unref?.();
main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
