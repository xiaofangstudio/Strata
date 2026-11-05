# shaders/ — WebGPU 合成着色器

本目录存放 Strata 的 WebGPU（`navigator.gpu`）WGSL 源码，由 `src/engine/gpu/` 下的 TS 代码驱动。
**「拼合图像」已接入 GPU**（`gpuBridge.ts` → `layer.flattenImage`），其余链路仍走 Canvas2D；
WebGPU 不可用 / 文档不满足条件时静默回退 CPU。调色台与滤镜的实时预览暂未 GPU 化 ——
`composeDoc` 是同步每帧调用，而 GPU 读回是异步的，硬接会掉帧，属于后续工作。

## 文件

| 文件 | 作用 |
|---|---|
| `compose.wgsl` | 图层合成 compute 管线（可读副本）。 |
| `src/engine/gpu/compose.wgsl.ts` | 同一份 WGSL 的 TS 模板字符串常量 `COMPOSE_WGSL`（运行时实际使用）。 |
| `src/engine/gpu/device.ts` | `detectWebGpu()` 异步探测 + `GpuBackend`（缓存 device / pipeline）。 |
| `src/engine/gpu/compose.ts` | `gpuFlatten()` 多层合成入口 + `GpuLayerInput`。 |
| `src/engine/gpu/blendIds.ts` | `blendToShaderId()` 纯映射 + `SUPPORTED_GPU_BLENDS`（**全部 27 种**）。 |
| `adjust.wgsl` | 调整算子 compute 管线（可读副本）：brightness / contrast / exposure / saturation / hue / temperature / gamma / levels。 |
| `src/engine/gpu/adjust.wgsl.ts` | 同一份 WGSL 的 TS 模板字符串常量 `ADJUST_WGSL`，供后续接线使用。 |

## 编译 / 导入方式（已选定：WGSL 内联为 TS 字符串常量）

**不采用** Vite 的 `import code from './compose.wgsl?raw'`：`?raw` 需要给 `*.wgsl`
补一个模块声明（`declare module '*.wgsl?raw'` 或改 `vite-env.d.ts`），那会动到
tsconfig / 声明文件，与「只新建文件、不改现有配置」的约束冲突，且 vitest 的 node
环境也不认 `?raw`。

**采用**：把 WGSL 源码作为 TS 导出的模板字符串常量，放在
`src/engine/gpu/compose.wgsl.ts`，`device.ts` 直接
`import { COMPOSE_WGSL } from "./compose.wgsl.ts"` 喂给
`device.createShaderModule({ code: COMPOSE_WGSL })`。零模块声明、严格模式下
`tsc --noEmit` 直接通过。

> `shaders/compose.wgsl` 与 `compose.wgsl.ts` 里的字符串是**同一份文本**：前者便于阅读 /
> 用 naga、tint 等工具离线校验，后者是运行时真身。改一处必须同步另一处（建议在
> `compose.wgsl.ts` 改完再覆盖回 `compose.wgsl`）。

管线类型：**compute**（`@compute @workgroup_size(8,8)`，入口 `cs_main`），不是 fragment pass。
每层一次 dispatch，累加结果放在 `array<u32>` 的 storage buffer（打包 RGBA8），
输入层用 `rgba8unorm` 纹理 + `textureLoad` 读取，最后 `copyBufferToBuffer` 到
MAP_READ 缓冲读回。bindings：`0=Params(uniform)` / `1=accum(storage rw)` /
`2=layerTex(texture_2d<f32>)` / `3=Diag(storage rw)`。

## 混合模式支持范围

`Params`：`blendMode: u32`、`opacity: f32`、`width: u32`、`height: u32`（16 字节 uniform）。

**27 种全部正确实现**（编号沿用 ArtCraft PhotoCraft gpu crate 的 mode 常量，语义与 CPU 合成一致）。
早期版本只做了 11 种、其余 16 种 `default → normal` 静默给错结果，本轮已补齐：

| 分组 | 模式 | 说明 |
|---|---|---|
| 分离式 | normal / darken / multiply / color-burn / linear-burn / lighten / screen / color-dodge / linear-dodge / overlay / soft-light / hard-light / vivid-light / linear-light / pin-light / hard-mix / difference / exclusion / subtract / divide | 逐通道 W3C / Porter-Duff 公式，`soft-light` 用含 `D(Cb)` 分段的 W3C 精确式 |
| 非分离式 | darker-color / lighter-color / hue / saturation / color / luminosity | 按 W3C `SetLum` / `SetSat` / `ClipColor` 整像素实现 |
| 特殊 | dissolve | 按确定性哈希逐像素二选一，对齐 CPU 的 dither 分支 |

`Diag.fallbackBits` 现在**只在越界 id 兜底时置位**（正常 27 种不会再触发降级）。
`SUPPORTED_GPU_BLENDS` 与 WGSL 的 switch 分支一一对应，两份 WGSL（`.wgsl` 与 `.ts` 字符串）
由测试断言逐字一致。CPU 侧公式基准在 `src/engine/blend.ts` 的 `SOFT_BLENDS` 与 W3C 规范。

## CPU / GPU 双路径一致性策略

1. **同一套输入语义**：两条路径都吃 straight-alpha 的 RGBA8，按「数组顺序 = 底→顶」
   逐层合成，每层套用 `opacity` 与同一混合公式。
2. **同一套公式**：WGSL 的 `composite()` 是 W3C / Porter-Duff 规范式，
   `blend_*` 数值语义对齐 `src/engine/blend.ts` 与 PhotoCraft 的 CPU 参考；GPU 只是把
   公式搬进着色器。
3. **同为 8 位量化**：累加缓冲每层都 `pack` 回 RGBA8（round-half-up），与 Canvas2D
   的 8 位后备存储一致，避免「GPU 全程浮点、CPU 全程 8 位」造成的偏差累积。
4. **容差对拍（已落地）**：`tests/unit/gpu-blend.test.ts` 用纯 TS 复刻 WGSL 公式作 GPU 参考，
   与 CPU 参考（W3C + 真实 `SOFT_BLENDS`）对拍 **27 种模式 × 15 组像素样本 × 5 档不透明度**，
   容差 ≤ 1/255，并含「用 normal 冒充缺失模式必须被抓到」的负向对照与两份 WGSL 一致性断言。
   `tests/unit/gpu-adjust.test.ts` 另测 adjust.wgsl 的 8 个算子（中性恒等 / 参数生效 / 无 NaN / alpha 保留）。
   注：项目约定单测不碰真实浏览器 API，所以没有 `createShaderModule` 编译验证；
   上线前建议再跑一次 naga / tint 离线校验。
5. **失败即回退**：`gpuFlatten()` 任一步失败（无 WebGPU、设备丢失、上传 / 读回异常、
   尺寸非法、像素长度不足）都返回 `null`；调用方 `if (gpu === null) 用 Canvas2D`。
   探测全程异步、绝不抛异常、绝不阻塞 UI。

接线示例（**「拼合图像」已按此接入**，见 `src/engine/gpuBridge.ts` 与 `EditorShell.tsx` 的 `layer.flattenImage`）：

```ts
const gpu = await gpuFlatten(layers, width, height);
const image = gpu ?? cpuFlattenCanvas2D(layers, width, height);
```

`GpuLayerInput`：`pixels: Uint8Array | Uint8ClampedArray`（长度 = w·h·4）、
`opacity: number`（0–1；Strata 图层是 0–100，接线时请 /100）、
`blend: string`（kebab-case BlendId）、`visible: boolean`。

## 明确不引 Rust 侧 wgpu

- 走的是 **WebView2 / Chromium 原生的 `navigator.gpu`（WebGPU）**，纯 TS + WGSL。
- **不引入 wgpu、不加任何 Rust crate、不在 `src-tauri/` 侧建 GPU 管线**；
  纹理不跨 WebView 边界回传，避免「Rust 渲染 → 序列化像素 → 前端」的巨大开销。
- 与 PhotoCraft 的关系**仅**是借鉴其 `compose.wgsl` 的逐像素混合数值语义
  （来源：ArtCraft PhotoCraft gpu crate，MIT/Apache-2.0 双授权），不含任何 Rust 代码。
