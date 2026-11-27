/**
 * WebGPU 设备探测与后端缓存。
 *
 * 本模块刻意不引用任何 WebGPU 全局类型（GPUDevice / GPUBuffer …）：项目未安装
 * @webgpu/types，且 lib.dom.d.ts 不声明 WebGPU，严格模式下直接写这些名字会 tsc 报错。
 * 这里用一组「最小结构类型」描述我们真正用到的 API；运行时从 navigator.gpu 拿到的
 * 是浏览器原生对象，结构天然吻合。既不改 tsconfig、也不新增 .d.ts / 依赖，模块自洽。
 */

import { COMPOSE_WGSL } from "./compose.wgsl.ts";

/* ------------------------------------------------------------------ 最小 WebGPU 结构类型 */

export interface GpuBuffer {
  destroy(): void;
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
}
export interface GpuTextureView {}
export interface GpuTexture {
  createView(): GpuTextureView;
  destroy(): void;
}
export interface GpuCompilationMessage {
  type: string;
  message: string;
  lineNum?: number;
}
export interface GpuShaderModule {
  getCompilationInfo?(): Promise<{ messages: GpuCompilationMessage[] }>;
}
export interface GpuBindGroupLayout {}
export interface GpuPipelineLayout {}
export interface GpuBindGroup {}
export interface GpuComputePipeline {
  getBindGroupLayout(index: number): GpuBindGroupLayout;
}
export interface GpuCommandBuffer {}
export interface GpuComputePassEncoder {
  setPipeline(pipeline: GpuComputePipeline): void;
  setBindGroup(index: number, bindGroup: GpuBindGroup): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}
export interface GpuCommandEncoder {
  beginComputePass(descriptor?: { label?: string }): GpuComputePassEncoder;
  copyBufferToBuffer(
    source: GpuBuffer,
    sourceOffset: number,
    destination: GpuBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  finish(descriptor?: { label?: string }): GpuCommandBuffer;
}
export interface GpuQueue {
  writeBuffer(
    buffer: GpuBuffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): void;
  writeTexture(
    destination: {
      texture: GpuTexture;
      mipLevel?: number;
      origin?: { x: number; y: number; z: number };
    },
    data: ArrayBufferView | ArrayBuffer,
    dataLayout: { offset?: number; bytesPerRow: number; rowsPerImage?: number },
    size: { width: number; height: number; depthOrArrayLayers?: number },
  ): void;
  submit(commandBuffers: GpuCommandBuffer[]): void;
}
export interface GpuLimits {
  maxTextureDimension2D?: number;
  maxStorageBufferBindingSize?: number;
  maxComputeWorkgroupsPerDimension?: number;
}
export interface GpuDevice {
  readonly limits?: GpuLimits;
  pushErrorScope?(filter: string): void;
  popErrorScope?(): Promise<unknown>;
  createShaderModule(descriptor: { code: string; label?: string }): GpuShaderModule;
  createComputePipeline(descriptor: {
    layout: "auto" | GpuPipelineLayout;
    compute: { module: GpuShaderModule; entryPoint: string };
    label?: string;
  }): GpuComputePipeline;
  createBuffer(descriptor: { size: number; usage: number; label?: string }): GpuBuffer;
  createTexture(descriptor: {
    size: { width: number; height: number; depthOrArrayLayers?: number };
    format: string;
    usage: number;
    label?: string;
  }): GpuTexture;
  createBindGroup(descriptor: {
    layout: GpuBindGroupLayout;
    entries: {
      binding: number;
      resource: { buffer: GpuBuffer; offset?: number; size?: number } | GpuTextureView;
    }[];
    label?: string;
  }): GpuBindGroup;
  createCommandEncoder(descriptor?: { label?: string }): GpuCommandEncoder;
  readonly queue: GpuQueue;
  readonly lost: Promise<{ reason: string; message: string }>;
  destroy(): void;
}
export interface GpuAdapter {
  requestDevice(descriptor?: { label?: string }): Promise<GpuDevice | null>;
}
export interface Gpu {
  requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapter | null>;
}

/* ------------------------------------------------------------------ 使用标志 / 常量 */

export const GPU_BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const;

export const GPU_TEXTURE_USAGE = {
  COPY_DST: 0x0002,
  TEXTURE_BINDING: 0x0004,
} as const;

export const GPU_MAP_MODE = { READ: 0x0001 } as const;

/* ------------------------------------------------------------------ 探测 */

/** 用最小结构视角取出 navigator.gpu；node / 非安全上下文 / 老浏览器一律返回 null。 */
function readGpu(): Gpu | null {
  const holder = globalThis as unknown as { navigator?: { gpu?: Gpu } };
  return holder.navigator?.gpu ?? null;
}

/**
 * 纯异步探测 WebGPU：navigator.gpu → requestAdapter → requestDevice。
 *
 * 契约：绝不抛异常、绝不阻塞 UI（全程 await 原生 Promise）、任何一步失败都返回 null，
 * 交由调用方静默回退 Canvas2D。
 */
export async function detectWebGpu(): Promise<GpuDevice | null> {
  try {
    const gpu = readGpu();
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    return device ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ 后端 */

/**
 * 缓存 device 与 compose 计算管线的后端。
 *
 * 一次进程只探测一次（create() 内 await detectWebGpu）；没有 WebGPU 时
 * available 恒为 false，gpuFlatten 直接返回 null 走 CPU 回退。
 */
export class GpuBackend {
  private _device: GpuDevice | null = null;
  private _pipeline: GpuComputePipeline | null = null;
  private _destroyed = false;
  private _reason: string | null = null;
  private _onLost: (() => void) | null = null;

  /** device 与 pipeline 都就绪、校验通过且未 destroy 时为 true。 */
  get available(): boolean {
    return !this._destroyed && this._device !== null && this._pipeline !== null;
  }

  get device(): GpuDevice | null {
    return this.available ? this._device : null;
  }

  get pipeline(): GpuComputePipeline | null {
    return this.available ? this._pipeline : null;
  }

  get limits(): GpuLimits | null {
    return this.available ? (this._device?.limits ?? null) : null;
  }

  /** 失败原因；成功时为 null。UI 诊断用，不影响静默回退。 */
  get reason(): string | null {
    return this._reason;
  }

  /** 异步工厂：探测设备并编译 compose 管线；失败也返回 available=false 的实例。 */
  static async create(onLost?: () => void): Promise<GpuBackend> {
    const backend = new GpuBackend();
    backend._onLost = onLost ?? null;
    await backend.init();
    return backend;
  }

  private async init(): Promise<boolean> {
    if (this._destroyed) return false;
    try {
      const device = await detectWebGpu();
      if (!device) {
        this._reason = "当前环境没有可用的 WebGPU 设备";
        return false;
      }
      // WebGPU 的 shader / pipeline 错误是异步上报的。不检查就 available=true 的话，
      // dispatch 会静默 no-op，读回的全零缓冲会被误当成一张合法透明图 —— 这是假 GPU。
      device.pushErrorScope?.("validation");
      const module = device.createShaderModule({ code: COMPOSE_WGSL });
      let messages: GpuCompilationMessage[] = [];
      if (module.getCompilationInfo) {
        const info = await module.getCompilationInfo();
        messages = info.messages ?? [];
      }
      const errors = messages.filter((m) => m.type === "error");
      if (errors.length) {
        this._reason = `WebGPU 着色器编译失败：${errors[0].message}`;
        await device.popErrorScope?.().catch(() => undefined);
        return false;
      }
      const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint: "cs_main" },
      });
      const scopeError = await device.popErrorScope?.().catch(() => undefined);
      if (scopeError) {
        this._reason = "WebGPU 合成管线校验失败";
        return false;
      }
      this._device = device;
      this._pipeline = pipeline;
      void device.lost.then(() => {
        if (this._destroyed) return;
        this._destroyed = true;
        this._device = null;
        this._pipeline = null;
        this._reason = "WebGPU 设备已丢失";
        this._onLost?.();
      }).catch(() => undefined);
      return true;
    } catch (e) {
      this._reason = e instanceof Error ? e.message : "WebGPU 初始化失败";
      return false;
    }
  }

  /** 释放 device；之后 available 恒为 false，不可再用。 */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      this._device?.destroy();
    } catch {
      // 设备早已丢失时 destroy 可能抛，吞掉以保证 destroy() 自身绝不抛。
    }
    this._device = null;
    this._pipeline = null;
  }
}
