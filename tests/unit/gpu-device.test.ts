import { afterEach, describe, expect, it } from "vitest";
import { detectWebGpu, GpuBackend } from "../../src/engine/gpu/device";

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function installGpu(device: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } },
  });
}

function fakeDevice(messages: { type: string; message: string }[] = []): unknown {
  return {
    limits: {
      maxTextureDimension2D: 8192,
      maxStorageBufferBindingSize: 268435456,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    lost: new Promise(() => undefined),
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages }) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({}),
    createTexture: () => ({ createView: () => ({}) }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({}),
    queue: {},
    destroy: () => undefined,
  };
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("WebGPU 设备探测与校验", () => {
  it("没有 navigator.gpu 时返回 null", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    expect(await detectWebGpu()).toBeNull();
  });

  it("编译信息含 error 时不声明可用", async () => {
    installGpu(fakeDevice([{ type: "error", message: "bad wgsl" }]));
    const backend = await GpuBackend.create();
    expect(backend.available).toBe(false);
    expect(backend.reason).toContain("bad wgsl");
  });

  it("管线校验通过后才 declared available", async () => {
    installGpu(fakeDevice());
    const backend = await GpuBackend.create();
    expect(backend.available).toBe(true);
    expect(backend.reason).toBeNull();
    expect(backend.limits?.maxTextureDimension2D).toBe(8192);
  });

  it("error scope 报 validation error 时不声明可用", async () => {
    const device = fakeDevice() as Record<string, unknown>;
    device.popErrorScope = async () => ({ message: "validation" });
    installGpu(device);
    const backend = await GpuBackend.create();
    expect(backend.available).toBe(false);
    expect(backend.reason).toContain("校验失败");
  });
});
