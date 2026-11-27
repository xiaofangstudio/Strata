import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetGpuBackend } from "../../src/engine/gpu/compose";
import { gpuFlattenDetailed } from "../../src/engine/gpu/compose";
import { GPU_BUFFER_USAGE, GPU_TEXTURE_USAGE } from "../../src/engine/gpu/device";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");

interface Harness {
  bindEntries: any[] | null;
  uniformWrites: Uint8Array[];
  textureWrites: number;
  dispatches: Array<[number, number]>;
  popResults: unknown[];
  setPixel: (rgba: [number, number, number, number], diag?: number) => void;
}

function installDevice(options: { diag?: number } = {}): Harness {
  let diag = options.diag ?? 0;
  let pixel: [number, number, number, number] = [10, 20, 30, 255];
  const h: Harness = {
    bindEntries: null,
    uniformWrites: [],
    textureWrites: 0,
    dispatches: [],
    popResults: [null, null],
    setPixel: (rgba, nextDiag = 0) => {
      pixel = rgba;
      diag = nextDiag;
    },
  };
  let stagingRange: ArrayBuffer | null = null;

  const makeBuffer = (desc: { size: number; usage: number }) => {
    let mapped: ArrayBuffer | null = null;
    return {
      size: desc.size,
      usage: desc.usage,
      destroy() {},
      async mapAsync() {
        mapped = new ArrayBuffer(desc.size);
        if (desc.usage & GPU_BUFFER_USAGE.MAP_READ) {
          const b = new Uint8Array(mapped);
          b.set(pixel, 0);
          new DataView(mapped).setUint32(desc.size - 4, diag >>> 0, true);
          stagingRange = mapped;
        }
      },
      getMappedRange() {
        return mapped ?? new ArrayBuffer(desc.size);
      },
      unmap() {},
    };
  };

  const device = {
    limits: {
      maxTextureDimension2D: 8192,
      maxStorageBufferBindingSize: 268435456,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    lost: new Promise(() => undefined),
    pushErrorScope() {},
    popErrorScope: async () => h.popResults.shift() ?? null,
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: makeBuffer,
    createTexture: (desc: { size: { width: number; height: number }; usage: number }) => ({
      size: desc.size,
      usage: desc.usage,
      createView: () => ({ kind: "view" }),
      destroy() {},
    }),
    createBindGroup: (desc: { entries: any[] }) => {
      h.bindEntries = desc.entries;
      return {};
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups: (x: number, y: number) => h.dispatches.push([x, y]),
        end() {},
      }),
      copyBufferToBuffer() {},
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(_buffer: unknown, _offset: number, data: ArrayBufferView | ArrayBuffer) {
        h.uniformWrites.push(new Uint8Array(data as ArrayBuffer).slice());
      },
      writeTexture(
        _destination: unknown,
        _data: ArrayBufferView | ArrayBuffer,
        layout: { bytesPerRow: number; rowsPerImage?: number },
        size: { width: number; height: number },
      ) {
        expect(layout.bytesPerRow).toBe(size.width * 4);
        expect(layout.rowsPerImage).toBe(size.height);
        h.textureWrites += 1;
      },
      submit() {},
    },
    destroy() {},
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } },
  });
  Object.defineProperty(globalThis, "ImageData", {
    configurable: true,
    value: class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  });
  void stagingRange;
  return h;
}

const layer = (visible: boolean, opacity = 1, blend = "normal", size = 16 * 9) => {
  const pixels = new Uint8Array(size * 4);
  for (let i = 0; i < size; i += 1) pixels.set([200, 100, 50, 255], i * 4);
  return { pixels, visible, opacity, blend };
};

describe("GPU 合成接线（mock device）", () => {
  beforeEach(() => resetGpuBackend());
  afterEach(() => {
    resetGpuBackend();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (originalImageData) Object.defineProperty(globalThis, "ImageData", originalImageData);
    else Reflect.deleteProperty(globalThis, "ImageData");
  });

  it("绑定组、uniform 字节、纹理上传与 dispatch 次数都与可见层一一对应", async () => {
    const h = installDevice();
    const report = await gpuFlattenDetailed([layer(true), layer(false), layer(true, 0.5, "multiply")], 16, 9);

    expect(report.image).not.toBeNull();
    expect(report.fallbackMask).toBe(0);
    expect(h.textureWrites).toBe(2);
    expect(h.dispatches).toEqual([
      [2, 2],
      [2, 2],
    ]);
    expect(h.bindEntries?.map((e) => e.binding)).toEqual([0, 1, 2, 3]);
    expect(h.bindEntries?.[2].resource).toMatchObject({ kind: "view" });
    expect(h.uniformWrites).toHaveLength(2);
    expect(Array.from(h.uniformWrites[0])).toEqual([1, 0, 0, 0, 0, 0, 0x80, 0x3f, 16, 0, 0, 0, 9, 0, 0, 0]);
    expect(Array.from(h.uniformWrites[1])).toEqual([4, 0, 0, 0, 0, 0, 0, 0x3f, 16, 0, 0, 0, 9, 0, 0, 0]);
  });

  it("诊断位掩码非 0 时整次拒绝，不把降级结果当成功", async () => {
    installDevice({ diag: 1 << 4 });
    const report = await gpuFlattenDetailed([layer(true)], 8, 8);
    expect(report.image).toBeNull();
    expect(report.fallbackMask).toBe(1 << 4);
    expect(report.fallbackBlendIds).toEqual([4]);
  });

  it("有内容却读回全透明视为管线没跑，拒绝返回空图", async () => {
    const h = installDevice();
    h.setPixel([0, 0, 0, 0]);
    expect(await gpuFlattenDetailed([layer(true)], 8, 8)).toMatchObject({
      image: null,
      fallbackMask: 0,
    });
  });

  it("validation error scope 报错时回退，不返回可疑图像", async () => {
    const h = installDevice();
    h.popResults = [null, { message: "dispatch validation failed" }];
    const report = await gpuFlattenDetailed([layer(true)], 8, 8);
    expect(report.image).toBeNull();
  });

  it("像素不足的层直接整次拒绝，不会读越界内存", async () => {
    installDevice();
    const bad = { ...layer(true), pixels: new Uint8Array(4 - 1) };
    const report = await gpuFlattenDetailed([bad], 8, 8);
    expect(report.image).toBeNull();
  });
});
