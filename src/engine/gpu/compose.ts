/**
 * GPU 图层合成入口（独立模块，尚未接线到编辑器）。
 *
 * gpuFlatten 把多层 RGBA8 依次上传为 texture，跑 compose.wgsl 的 compute 管线，
 * 读回 RGBA 组成 ImageData。任何一步失败（无 WebGPU、设备丢失、参数非法、
 * 上传 / 读回异常）都返回 null，调用方据此静默回退现有 Canvas2D 合成路径。
 */

import {
  GPU_BUFFER_USAGE,
  GPU_MAP_MODE,
  GPU_TEXTURE_USAGE,
  GpuBackend,
  type GpuBuffer,
  type GpuTexture,
} from "./device";
import { blendToShaderId } from "./blendIds";

/** 一层待合成的 RGBA8 输入。 */
export interface GpuLayerInput {
  /** 直通 RGBA8 像素，长度必须为 width * height * 4（不足则整次回退）。 */
  pixels: Uint8Array | Uint8ClampedArray;
  /** 不透明度 0–1（Strata 图层的 0–100 请在接线时 /100 后传入）。 */
  opacity: number;
  /** 混合模式，kebab-case 的 Strata BlendId，见 src/core/layer.ts::BLEND_MODES。 */
  blend: string;
  /** 不可见的层会被跳过。 */
  visible: boolean;
}

/** gpuFlattenDetailed 的结果，附带 WGSL 写回的「回退」标注。 */
export interface GpuFlattenReport {
  /** 合成结果；失败为 null。 */
  image: ImageData | null;
  /** 诊断位掩码：bit i 置位表示 shader id i 曾被 WGSL 退化为 normal。 */
  fallbackMask: number;
  /** fallbackMask 解码后的 shader id 列表。 */
  fallbackBlendIds: number[];
}

let cachedBackend: GpuBackend | null = null;

async function getBackend(): Promise<GpuBackend> {
  if (!cachedBackend) cachedBackend = await GpuBackend.create();
  return cachedBackend;
}

function failed(): GpuFlattenReport {
  return { image: null, fallbackMask: 0, fallbackBlendIds: [] };
}

function clamp01(v: number): number {
  const x = Number.isFinite(v) ? v : 1;
  return Math.max(0, Math.min(1, x));
}

/** 把任意 Uint8 视图规整成带正确 byteOffset / byteLength 的 Uint8Array。 */
function toBytes(pixels: Uint8Array | Uint8ClampedArray): Uint8Array {
  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

/** 诊断位掩码 → 触发回退的 shader id 列表。 */
function decodeMask(mask: number): number[] {
  const ids: number[] = [];
  for (let i = 1; i < 32; i += 1) {
    if (((mask >>> i) & 1) === 1) ids.push(i);
  }
  return ids;
}

/**
 * 与 gpuFlatten 相同，但额外返回 WGSL 写回的回退标注（哪些混合模式被降级为 normal）。
 * 主代理接线时若需要知道结果是否因不支持的模式而降级，可用这个变体。
 */
export async function gpuFlattenDetailed(
  layers: GpuLayerInput[],
  width: number,
  height: number,
): Promise<GpuFlattenReport> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return failed();
  }
  const pixelCount = width * height;
  const pixelBytes = pixelCount * 4;
  if (!Number.isSafeInteger(pixelBytes) || pixelBytes <= 0) return failed();

  let backend: GpuBackend;
  try {
    backend = await getBackend();
  } catch {
    return failed();
  }
  const device = backend.device;
  const pipeline = backend.pipeline;
  if (!device || !pipeline) return failed();

  let accum: GpuBuffer | null = null;
  let layerTex: GpuTexture | null = null;
  let uniform: GpuBuffer | null = null;
  let diag: GpuBuffer | null = null;
  let staging: GpuBuffer | null = null;

  try {
    // WebGPU 保证缓冲零初始化 → 累加缓冲起点是透明黑 (0,0,0,0)。
    accum = device.createBuffer({
      size: pixelBytes,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
    });
    uniform = device.createBuffer({
      size: 16,
      usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
    });
    diag = device.createBuffer({
      size: 4,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
    });
    layerTex = device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage: GPU_TEXTURE_USAGE.COPY_DST | GPU_TEXTURE_USAGE.TEXTURE_BINDING,
    });
    staging = device.createBuffer({
      size: pixelBytes + 4,
      usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
    });
    if (!accum || !layerTex || !uniform || !diag || !staging) return failed();

    const layout = pipeline.getBindGroupLayout(0);
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: accum } },
        { binding: 2, resource: layerTex.createView() },
        { binding: 3, resource: { buffer: diag } },
      ],
    });

    const uniformData = new ArrayBuffer(16);
    const uniformView = new DataView(uniformData);
    const bytesPerRow = width * 4;

    for (const layer of layers) {
      if (!layer.visible) continue;
      const bytes = toBytes(layer.pixels);
      if (bytes.byteLength < pixelBytes) return failed(); // 像素数据不足 → 整次回退
      uniformView.setUint32(0, blendToShaderId(layer.blend), true);
      uniformView.setFloat32(4, clamp01(layer.opacity), true);
      uniformView.setUint32(8, width, true);
      uniformView.setUint32(12, height, true);
      device.queue.writeBuffer(uniform, 0, uniformData);
      device.queue.writeTexture(
        { texture: layerTex },
        bytes,
        { bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      // 每层单独一次 submit：保证 writeTexture / writeBuffer 的写入在该层 dispatch 之前可见，
      // 也避免多个 dispatch 共用同一张纹理时都读到最后一次上传的内容。
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    // 回读：累加缓冲 → staging[0, pixelBytes)，诊断缓冲 → staging[pixelBytes, +4)。
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(accum, 0, staging, 0, pixelBytes);
    encoder.copyBufferToBuffer(diag, 0, staging, pixelBytes, 4);
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPU_MAP_MODE.READ);
    let image: ImageData;
    let fallbackMask = 0;
    try {
      const range = staging.getMappedRange();
      const packed = new Uint32Array(range, 0, pixelCount);
      fallbackMask = new Uint32Array(range, pixelBytes, 1)[0] >>> 0;
      const out = new Uint8ClampedArray(pixelBytes);
      for (let i = 0; i < pixelCount; i += 1) {
        const v = packed[i];
        const o = i * 4;
        out[o] = v & 0xff;
        out[o + 1] = (v >>> 8) & 0xff;
        out[o + 2] = (v >>> 16) & 0xff;
        out[o + 3] = (v >>> 24) & 0xff;
      }
      image = new ImageData(out, width, height);
    } finally {
      staging.unmap();
    }

    return { image, fallbackMask, fallbackBlendIds: decodeMask(fallbackMask) };
  } catch {
    return failed();
  } finally {
    // 临时资源无论成败都释放，避免大文档反复 flatten 时泄漏显存。
    try { accum?.destroy(); } catch { /* 已释放 */ }
    try { layerTex?.destroy(); } catch { /* 已释放 */ }
    try { uniform?.destroy(); } catch { /* 已释放 */ }
    try { diag?.destroy(); } catch { /* 已释放 */ }
    try { staging?.destroy(); } catch { /* 未 map 或已释放 */ }
  }
}

/** 多层 GPU 合成；失败返回 null，调用方直接回退 Canvas2D。 */
export async function gpuFlatten(
  layers: GpuLayerInput[],
  width: number,
  height: number,
): Promise<ImageData | null> {
  return (await gpuFlattenDetailed(layers, width, height)).image;
}
