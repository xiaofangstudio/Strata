# 新版 PhotoCraft 算法功能与 Strata 移植改造手册

> 2026-11-15 立项调研。用户原话：
> 「重点是新版的 PhotoCraft 还加了很多算法功能，这个你也能发现，不是 AI 就是算法功能，
> 我们也需要适当加入一些。麻烦你现在先去理一下它的算法功能以及都是怎么实现的，
> 可以照搬一些代码，以及我们到底需要改哪些东西所有的，然后下回你就直接照着那个改，
> 不需要边改边查了，先把一次性要查的所有的全都查完。」
>
> **本文档只做调研和执行手册，本轮不改任何业务源码、不编译、不提交。**
>
> 参考源码：`D:\20533\deskbox\fangwork\Strata\PhotoCraft\`
> 参数窗口化姊妹文档：`docs/参数窗口化改造清单与PhotoCraft差距-2026-11-15.md`

---

## 0. 下回拿到任务后先看这一页

读完本文后，**不需要再重新搜 PhotoCraft**。按顺序执行即可：

1. 先看第 2 节「快照完整性」——本地快照缺模块，别照着不存在的文件改。
2. 再看第 4 节「算法总表」确定要改哪一类。
3. 照第 5 节「重点算法移植配方」逐个写纯函数。
4. 照第 6 节「Strata 全量改动清单」接线、加测试。
5. 照第 8 节「验收命令」收尾，最后按用户口径替换根目录 `Strata.exe`。

**一句话结论**：新版 PhotoCraft 的“AI 感”功能基本都是**经典计算机视觉 / 计算摄影算法**，
不是深度学习模型。真正值得我们补的是「硬算法」：guided filter、图割选区、matting、
Poisson、金字塔融合、PatchMatch 补全、ARAP、Lab 量化、HDR/RAW/堆栈。
大量 stylize / blur / distort 滤镜我们已经有观感等价实现，**不要重复移植**。

---

## 1. PhotoCraft 算法体系在哪、怎么组织

### 1.1 crate 版图

| 位置 | 作用 | 对 Strata 的态度 |
|---|---|---|
| `PhotoCraft/crates/algo/src/` | 纯 CPU 图像处理算法主仓库：选区、形变、融合、调色、降噪、特效、量化、HDR 等 | **主要移植来源** |
| `PhotoCraft/crates/engine/` | 命令注册、文档/图层模型、参数规格、命令→algo 调度 | 只参考接口思想，不整包搬 |
| `PhotoCraft/crates/raw/` | RAW 解码/显影；Bilinear / MHC / AHD demosaic，ProPhoto tone pipeline | 与 Strata `strata_raw` 同源，**不整体替换** |
| `PhotoCraft/crates/cms` → `craft-cms` | 新版 ICC 色彩管理已外置成 git 依赖 | Strata `strata_cms` 是旧 `photocraft-cms` 完整副本并已接线，**不替换** |
| `PhotoCraft/crates/gpu/` | wgpu 加速层 | Strata 走 WebGPU bridge + WGSL，**只参考公式，不搬架构** |

### 1.2 `crates/algo` 的统一契约

`PhotoCraft/crates/algo/src/lib.rs`（1790 行）是调度中枢：

```rust
pub fn kernel(params: &FilterParams, src: &Image, out: Rect, ctx: &Ctx) -> Vec<f32>
pub fn apply(
    surface: &Surface,
    params: &FilterParams,
    area: Rect,
    bounds: Rect,
    selection: Option<&Surface>,
) -> Surface
```

要点：

- `FilterParams` 是整套滤镜/调整的参数契约。
- 算法内部统一吃 **0..=1 归一化 f32**、行优先、交错的像素缓冲；
  `ch` 支持任意通道数，`Rect` 表示输出 tile，selection 是可选蒙版。
- 很多算法有 `reach()`：声明输出 tile 外还要读多少像素，用于分块计算。
- 原生侧用 `rayon` 并行行/通道；wasm 侧单线程。我们移植时**先写串行纯函数**，
  真的慢了再上 Web Worker，不要在 UI 线程直接跑 24MP 全分辨率。
- `Cargo.toml` 依赖 `photocraft-geom / photocraft-color / photocraft-raster / serde / rustfft`，
  native 额外 `rayon`。这些 Rust 类型在 Strata 里都要换成 TS 结构（见 6.1）。

---

## 2. 快照完整性：这一步务必先看

本地 `PhotoCraft/` 是用 `raw.githubusercontent.com` 抓下来的源码快照，**没有 `.git` 历史**。
当前实测：

- `crates/algo/src` 实际存在 **64 个 `.rs` 文件 / 38,274 行**；
- `lib.rs` 声明 **80 个顶层模块**；
- 其中 **24 个顶层模块文件缺失**；
- 现有文件里还有 **74 个 `mod xxx;` 子模块声明指向缺失文件**；
- 所以这份快照**不能直接 `cargo build`**，只能当算法参考。

### 2.1 缺失的顶层模块

```text
art_history, average, channel_noise, color_to_alpha, convolution, coverage,
cutout, dff, direct, faces, histogram, lens_flare, lens_flare_data,
magnetic, nonlocal, par, rank, redeye, relight, remove, separable,
shape_blur, square_dilate, vectorscope
```

### 2.2 重点算法里缺的子模块

| 父文件 | 缺失子模块 | 影响 |
|---|---|---|
| `segment/` | **整个 `segment/mod.rs` 缺失**，`maxflow.rs` 缺 `push_relabel.rs` | GrabCut / Quick / Subject / Sky / Focus 不能整包照抄，需要补源或自己写 mod 聚合 |
| `inpaint.rs` | `proximity_integral / common / solver / sources / synthesis` | `complete()` 主流程缺 5 个实现文件；只能先照头部算法描述自研，或补源 |
| `camera_raw.rs` | `local_tone / per_pixel / spatial / whites_blacks` | RAW 九阶段里的局部 tone / 空间处理段缺文件；`curve_lut` 与 `develop` 主函数可读 |
| `matting.rs` | `brush / morphology` | `guided_filter_color/refine_buffer` 主体可读；边缘笔刷与形态学需补源或本地实现 |
| `quantize.rs` | `nearest` | 最近色查找加速结构缺失；算法主体可读，先用暴力查找替代 |
| `panorama.rs` | `blend` | 融合权重段缺失；`ransac_motion`、配准部分可读 |
| `selection.rs` | `combine_mask / distance / inverse / lasso / marquee / morphology` | 基础选区算子拆分文件缺失；主文件可读 |
| `blur.rs` | `motion_fft / motion_bench / motion_tests` | 运动模糊 FFT 分支缺源；现有盒式/高斯可照抄 |
| `tone.rs` | `shadows_highlights / auto_levels / checked_hdr` | 局部色调/自动色阶拆分文件缺失；主表逻辑可读 |

### 2.3 补源方案（只在需要逐行照搬时做）

按 `docs/参数窗口化改造清单与PhotoCraft差距-2026-11-15.md` 里记的网络经验：
`git clone` / codeload / API tarball 在本机被限速或 502，
**只有 `raw.githubusercontent.com/storytold/photocraft/main/<path>` 稳定**。

补源顺序建议：

1. 先从 GitHub 目录页 HTML 正则抓 `"path":"..."`，拿到准确新路径；
2. 只补本节 2.2 里真正要照搬的父模块子目录，不必全仓重抓；
3. 旧版副本在
   `D:\20533\deskbox\fangwork\_回收_Strata参考软件_20261031\reference\artcraft-photocraft\`，
   可作算法思路参考，但路径结构与新版不同；
4. 若后续网络恢复，再做完整 `git clone --depth 1` 覆盖 `PhotoCraft/`，**不删现有目录内容以外的数据**。

---

## 3. 全部算法模块清单（按实际存在的 64 个文件）

> 状态口径：
> - **已有等价**：Strata 已有观感等价实现，不移植；
> - **退化实现**：菜单有功能，但算法是简化版，值得升级；
> - **缺失**：Strata 基本没有，需要新增；
> - **地基/支撑**：不是独立功能，是算法基础设施。

### 3.1 选区 / 抠图 / 蒙版

| PhotoCraft 文件 | 行数 | 实现要点 | Strata 现状 | 决策 |
|---|---:|---|---|---|
| `segment/maxflow.rs` | 469 | Boykov–Kolmogorov + FIFO push-relabel 混合最大流；`Graph` 用残差容量、搜索树、orphan adoption | `core/smartSelect.ts` 是颜色/BFS 启发式，无图割 | **P1 新增**；`push_relabel.rs` 缺失需补源 |
| `segment/gmm.rs` | 254 | 全协方差 3×3 GMM；k-means++ 播种 + Lloyd + EM；`Gmm::fit/refit` | 无 | **P1 新增** |
| `segment/grabcut.rs` | 322 | GrabCut：trimap、5 分量 GMM、γ=50 对比敏感平滑项、迭代 min-cut | `select.subject` 是边框颜色启发式 | **P1 新增** |
| `segment/slic.rs` | 174 | SLIC 超像素：Lab+xy 的局部 k-means，2S×2S 搜索窗，连通性修正 | 无 | **P1 新增**，也是 subject/sky 的底座 |
| `segment/quick.rs` | 366 | Quick Selection：种子增长 + 图割 | 有 `growHit` BFS 颜色扩散 | **P1 升级** |
| `segment/subject.rs` | 686 | SLIC + 显著性 + Otsu + 两轮 GrabCut + 全分辨率 recut；**经典算法，不是 AI** | `subjectHit` 边框背景中位数 | **P2 升级** |
| `segment/sky.rs` | 465 | 天空概率模型 + 图割/连通约束 | `skyHit` 蓝色 HSV + 上缘连通 | **P2 升级** |
| `segment/focus.rs` | 86 | 焦区域判定 | `focusHit` 3×3 拉普拉斯能量 | **P0 小升级**，可复用现成阈值 UI |
| `matting.rs` | 1538 | guided filter 软边、smart radius、Smooth/Feather/Contrast/Shift Edge、颜色去污染 | `RefineEdgeDialog` 111 行偏薄 | **P1 重点移植**；缺 `brush/morphology` |
| `selection.rs` | 1216 | 矩形/椭圆/套索/魔棒/组合/反选/距离变换/羽化；分文件实现 | `core/selection.ts` 基础齐全 | 只补 **距离变换 / 抗锯齿** 思路，不整体搬 |
| `selection_blur.rs` | 850 | 选区边缘特殊模糊与边界处理 | 无等价 | **P3 可选** |

### 3.2 修复 / 融合 / 几何形变

| PhotoCraft 文件 | 行数 | 实现要点 | Strata 现状 | 决策 |
|---|---:|---|---|---|
| `poisson.rs` | 328 | 梯度域 Poisson 克隆；SOR + cascadic multigrid 求膜插值 | 无真正 Poisson | **P0 新增** |
| `inpaint.rs` | 426 | Wexler EM + PatchMatch + 多尺度 + onion peel + 细长洞处理 + 膜兜底 | `engine/inpaint.ts`：扩散打底 + PatchMatch + SAT，已经有骨架 | **P1 升级**，不重写 |
| `content_aware.rs` | 726 | 自动 Healing 源偏移、Image Melding 颜色 gain/bias、纹理合成 | 无自动源匹配 | **P2 新增/接线** |
| `pyramid.rs` | 885 | 5-tap 高斯/拉普拉斯金字塔，`blend()`，`fuse_stack()` 焦堆栈融合 | `core/stackOps.ts` 有自动混合/堆栈，但非金字塔 | **P1 重点升级** |
| `puppet.rs` | 1515 | ARAP 网格、`build_mesh`、`puppet_warp`、三角网格 warp | `engine/meshWarp.ts` 是 Schaefer MLS | **P2 新增 ARAP 模式**，不替换 MLS |
| `perspective.rs` | 322 | 多平面透视变形 | `engine/warp.ts` + 透视菜单有部分 | **P2 升级** |
| `warp.rs` | 1279 | 通用 warp 网格/插值 | `engine/warp.ts`、`transform.ts` | 按需参考，不整包搬 |
| `liquify.rs` | 1209 | 液化笔刷场、重建、冻结区 | `engine/liquify.ts` + `LiquifyDialog` | 已有等价，只吸收笔刷细节 |
| `vanishing.rs` | 713 | 消失点网格与透视校正 | `filter.vanishingPoint` 已有入口 | **P3 升级** |
| `wideangle.rs` | 784 | 广角畸变校正、瓦片处理 | `engine/filters/lens.ts` 有部分镜头滤镜 | **P2 升级 lensCorrection** |
| `lens.rs` | 573 | Brown–Conrady 镜头畸变模型、相机参数 | 同上 | **P2 升级 lensCorrection** |
| `panorama.rs` | 1006 | 全景配准与柱面/球面投影，`ransac_motion`；缺 `blend` | `autoAlignLayers` 较简单 | **P3 新增** |
| `features.rs` | 767 | Harris 角点 + steered BRIEF + Hamming + RANSAC + DLT | `homography-and-smart.test.ts` 有部分基础 | **P2/P3 新增** |
| `transform.rs` | 631 | 单应性/仿射与几何变换 | `core/transform.ts` 覆盖常规变换 | 只参考单应性细节 |
| `resample.rs` | 708 | 高质量重采样 | `engine/raster.ts`、`seamCarve` | 已有够用，按需参考 |
| `scancrop.rs` | 299 | 内容感知裁剪/扫描裁剪 | 无 | **P3 可选** |
| `seam.rs` | 751 | 接缝雕刻 | `core/seamCarve.ts` 已完整实现 | **不移植** |

### 3.3 调色 / 降噪 / 相机 / 计算摄影

| PhotoCraft 文件 | 行数 | 实现要点 | Strata 现状 | 决策 |
|---|---:|---|---|---|
| `denoise.rs` | 307 | Reduce Noise = guided filter 亮度平滑 + 色度引导 + JPEG 8×8 去块 + USM 细节 | `kernels.reduceNoise` 是 median 混合简化版 | **P0 重点替换内核** |
| `camera_raw.rs` | 1458 | Camera Raw 九阶段：白平衡、去雾、局部 tone、clarity/texture、曲线、8 色 mixer、color grading、detail、暗角/颗粒 | `AdjustDialog` 只是参数集合；`strata_raw` 负责 RAW 解码 | **P2 增量补段落**，不换 RAW 解码 |
| `hdr.rs` | 541 | MTB 对齐 + Debevec response curve + ghost removal + merge | 无真正 HDR 合并 | **P3 新增** |
| `tone.rs` | 385 | 色调响应表/自动色阶/高光阴影拆分 | `engine/grading.ts`、`adjustPixels.ts` 已有 | 按需补表，不重写 |
| `retouch.rs` | 355 | 磨皮/锐化保护细节 | `engine/retouch.ts` 存在 | 按需吸收 |
| `stack.rs` | 267 | 堆栈统计模式 | `core/stackOps.ts` 已有部分 | **P2 补齐熵/偏度/峰度等真统计** |
| `quantize.rs` | 856 | exact/system/web/uniform/perceptual/selective/adaptive 调色板；Lab median-cut + k-means；Floyd–Steinberg / Bayer / noise dither | `core/colorMode.ts` 有 median-cut 简化版 | **P1 升级** |

### 3.4 特效 / 渲染 / 像素化（多数不要移植）

| PhotoCraft 文件 | 行数 | 实现要点 | Strata 现状 | 决策 |
|---|---:|---|---|---|
| `artistic.rs` | 264 | 艺术效果目录数据 | `FilterFxDialog` + 73 滤镜 | 不移植 |
| `artistic_fx.rs` | 1672 | 艺术滤镜集合 | `kernels.ts` 已有大量等价 | 不移植 |
| `blur.rs` / `blur2.rs` | 845 / 486 | 可变半径、运动、形状模糊；部分 FFT | `kernels.ts` + `filters/gallery.ts::iterativeVariableBlur` | 已有地基，按需补细节 |
| `distort.rs` / `distort2.rs` | 211 / 130 | 波浪/旋转/扭曲 | `kernels.ts` twirl/wave/ripple/pinch | 不移植 |
| `erase.rs` | 175 | 擦除类工具算法 | `engine/paint.ts` | 按需参考 |
| `exif.rs` | 42 | EXIF 方向/信息 | 打开管线已有处理 | 不移植 |
| `fxutil.rs` | 469 | 像素格式、盒式/高斯模糊工具 | `kernels.ts` 已导出等价原语 | 不移植，参考公式即可 |
| `gallery.rs` | 403 | Field/Iris/Spin/Tilt-Shift 参数与预览计划 | `iterativeVariableBlur` 已有 | P1 窗口化时复用，不改算法 |
| `noise.rs` | 281 | 噪声生成 | `kernels.addNoise/grain` | 不移植 |
| `oil.rs` / `pixelate.rs` | 273 / 385 | 油画/像素化 | `kernels.oilPaint/mosaic/crystallize/pointillize` | 不移植 |
| `other.rs` / `other2.rs` | 266 / 314 | 零散特效 | 73 滤镜覆盖 | 不移植 |
| `paint.rs` | 614 | 画笔/渐变/图案绘制 | `engine/paint.ts` | 按需参考 |
| `render.rs` / `render2.rs` | 336 / 1597 | 光晕/火焰/树/画框/光照等 | `filters/renderFx.ts`、`filters/lens.ts` | 不移植 |
| `stylize.rs` / `stylize2.rs` | 201 / 422 | 风格化 | `kernels.ts` 已覆盖 | 不移植 |
| `trap.rs` | 262 | 图案叠加 | 已有等价 | 不移植 |
| `video.rs` | 249 | 视频帧效果/去隔行 | `kernels.deInterlace` + GIF 导出 | 不移植 |

### 3.5 基础设施 / 数据支撑

| 文件 | 行数 | 用途 |
|---|---:|---|
| `lib.rs` | 1790 | 调度、FilterParams、kernel/apply、模块声明 |
| `image.rs` | 201 | `Image` / `Edge` 抽象 |
| `params_ext.rs` | 289 | 参数扩展与规格化 |
| `photo_util.rs` | 455 | `par_map/par_rows` 等并行辅助 |
| `tests.rs` | 716 | 全算法测试集合 |
| `segment/tests.rs` | 1355 | 图割/选区测试集合 |

### 3.6 RAW / CMS / GPU（不在 algo crate，但属于“算法功能”）

| 方向 | PhotoCraft 做法 | Strata 现状 | 结论 |
|---|---|---|---|
| RAW | `crates/raw`：Bilinear / MHC / AHD demosaic，ProPhoto tone pipeline | `src-tauri/src/strata_raw/` 同源移植 | **不替换**，只做增量 diff |
| CMS | 新版外置 `craft-cms` git 依赖 | `src-tauri/src/strata_cms/` 旧版完整副本 + 真 ICC 已接线 | **不替换** |
| GPU | `crates/gpu` wgpu | `engine/gpuBridge.ts` + `src/engine/gpu/*` + WGSL | 只参考公式；CPU 算法先保证真值 |

---

## 4. 优先级总表（下回按这个排活）

| 优先级 | 功能 | 源模块 | 难度 | 价值 | 本轮结论 |
|---|---|---|---|---|---|
| **P0-A** | Reduce Noise 真 guided filter | `denoise.rs` | 低 | 高 | 先替换 `kernels.reduceNoise`，补单测 |
| **P0-B** | Poisson 无缝克隆 / 修复画笔 | `poisson.rs` | 低 | 高 | 纯函数最容易照搬，先做 |
| **P0-C** | Focus Area 升级 | `segment/focus.rs` | 低 | 中 | 复用现有 `focusHit` 入口 |
| **P1-A** | Select and Mask / matting | `matting.rs` | 中 | 高 | guided filter + Shift Edge + decontaminate |
| **P1-B** | GrabCut / 图割选区 | `maxflow.rs`+`gmm.rs`+`grabcut.rs` | 中高 | 高 | 先做矩形对象选择，再做 Quick/Subject |
| **P1-C** | 金字塔自动混合 / 焦堆栈 | `pyramid.rs` | 中 | 高 | 一次升级 Auto-Blend + Stack |
| **P1-D** | 索引色质量升级 | `quantize.rs` | 中 | 高 | Lab perceptual/selective + dither |
| **P1-E** | 内容识别填充增强 | `inpaint.rs` | 中 | 高 | 现有 PatchMatch 骨架上补多尺度/细长洞/Image Melding |
| **P2-A** | SLIC + Subject / Sky | `slic.rs`/`subject.rs`/`sky.rs` | 中高 | 高 | 图割之后做，依赖关系明确 |
| **P2-B** | ARAP Puppet 模式 | `puppet.rs` | 高 | 中 | MLS 保留，新增模式，不替换 |
| **P2-C** | 镜头校正 / 广角 | `lens.rs`/`wideangle.rs` | 中 | 中 | 补真实畸变模型 |
| **P2-D** | Camera Raw 段落增强 | `camera_raw.rs` | 中高 | 高 | 只搬纯函数段落，不换 RAW 管线 |
| **P2-E** | 真统计堆栈模式 | `stack.rs` | 低 | 中 | 补齐菜单已有但粗糙的模式 |
| **P3-A** | HDR 合并 | `hdr.rs` | 高 | 中 | 需要多文档 UI 与对齐 |
| **P3-B** | 全景拼接 | `features.rs`/`panorama.rs` | 高 | 中 | 缺 `blend`，依赖 P2-A 的特征基础 |
| **P3-C** | 消失点 / 扫描裁剪 / 示波器 | `vanishing.rs`/`scancrop.rs`/缺 `histogram`/`vectorscope` | 高 | 低中 | 最后做，且要先补源 |

---

## 5. 重点算法移植配方（照着写即可）

### 5.0 通用 Rust → TypeScript 数据映射

| Rust | Strata TS |
|---|---|
| `Vec<f32>` 0..=1 交错缓冲 | `Float32Array`，长度 `w*h*ch` |
| `Vec<[f32;4]>` / RGBA | `Float32Array` 或 `RgbaBuffer`（`Uint8ClampedArray`），函数入口统一转换 |
| `Rect{x0,y0,x1,y1}` | `{x,y,w,h}` 或 `{x0,y0,x1,y1}`，**新算法建议统一 `x,y,w,h`** |
| `mask: &[bool]` | `Uint8Array`（0/1） |
| `serde` 参数结构 | TS `interface` + `DEFAULT_*` 常量 |
| `rayon` 并行 | 先串行；重算法用 Web Worker + 分块；不要阻塞 UI |
| `Interrupt` 取消 | `AbortSignal` 或 `{ cancelled: () => boolean }` |
| `photocraft_color::ColorMode` | 复用 `src/core/colorMode.ts` 的 `toLab/toCmyk/splitChannels` |
| `Image/Surface` | `src/engine/raster.ts::Raster` 或新建 `{ width, height, data: Float32Array, ch }` |

**铁律**：新算法内核只吃数组和数字，不碰 DOM/canvas。canvas 落版放到 `core` 或组件层。
项目约定：vitest 不碰真实浏览器 API。

---

### 5.1 P0-A：Reduce Noise → guided filter

**源**：`PhotoCraft/crates/algo/src/denoise.rs`

关键函数：

```rust
fn guide_moments(g, w, h, r)                 // denoise.rs:32
fn guided_luma(g, w, h, r, eps)              // denoise.rs:42
fn guided_chroma(g, planes, w, h, r, eps, amount) // denoise.rs:59
pub(crate) fn reduce_noise(src, out, ctx, spec) // denoise.rs:84
```

原理：

1. RGB → YCbCr/Lab/灰度；JPEG 模式先对 8×8 网格线做 3×3 平滑去块。
2. 亮度用 **self-guided filter**：`mean/variance` → `a = cov/(var+eps)`，`b = mean - a*mean`，
   再 box blur `a,b`，输出 `a*guide+b`。半径与 `strength` 相关，最大 5。
3. 色度用清理后的亮度做 guide，半径最大 9，颜色边缘被保留。
4. `Preserve Details` 降低 eps；`Sharpen Details` 对亮度做 USM。

**目标文件**：新建 `src/engine/algos/guidedFilter.ts`，改 `src/engine/filters/kernels.ts::reduceNoise`。

TS 接口建议：

```ts
export interface DenoiseSpec {
  strength: number;  // 0..10
  preserve: number;  // 0..100
  color: number;     // 0..100
  sharpen: number;   // 0..100
  jpeg: boolean;
}
export function reduceNoiseGuided(src: RgbaBuffer, spec: DenoiseSpec): RgbaBuffer;
```

可复用：`kernels.boxBlurPass / gaussianBlur / unsharpMask / premultiply / unpremultiplyInto`。

验收：

- 纯色图 + 椒盐噪声：噪声明显下降，边缘像素偏移小于普通 median；
- 高对比棋盘：黑白边界不能被抹成灰；
- `strength=0/color=0/sharpen=0/jpeg=false` 必须原样返回；
- `tests/unit/filter-truth.test.ts` 73 滤镜继续全真。

---

### 5.2 P0-B：Poisson 无缝克隆 / 修复画笔

**源**：`PhotoCraft/crates/algo/src/poisson.rs`

关键函数：

```rust
pub fn solve_membrane(w, h, unknown, v)        // poisson.rs:31
pub fn seamless_clone(w, h, ch, src, dst, mask) // poisson.rs:218
pub fn membrane_fill(w, h, ch, img, hole)       // poisson.rs:230
```

原理（Pérez et al. SIGGRAPH 2003）：

- 目标：在 mask 内最小化 `|∇f - ∇src|²`，边界用 dst。
- 令 `f = src + h`，`h` 是边界差值的调和插值（解 `Δh=0`）。
- `solve_membrane` 用 **cascadic multigrid + SOR**：粗网格求解后双线性插值回细网格，
  再少量 SOR 扫；`TOL=2e-5`，细层 30 次、ω=1.7，最粗层 2000 次、ω=1.85。
- 每通道独立求解；mask 边缘留 1 px 未选区可得到完整 Dirichlet 条件。

**目标文件**：新建 `src/engine/algos/poisson.ts`；接到 `edit.contentAwareFill` 的“修复画笔”模式和
未来 Healing Brush 工具。

TS 接口：

```ts
export function solveMembrane(w: number, h: number, unknown: Uint8Array, v: Float32Array): void;
export function seamlessClone(
  w: number, h: number, ch: number,
  src: Float32Array, dst: Float32Array, mask: Uint8Array,
): Float32Array;
export function membraneFill(w: number, h: number, ch: number, img: Float32Array, hole: Uint8Array): Float32Array;
```

注意：

- `unknown[i]` 为 1 表示待求；`v` 进入时已知像素已写入边界值。
- 先做 1× 分辨率纯函数；大笔刷再考虑粗网格。
- 不需要补缺失模块，这个文件自包含。

验收：

- 灰底上贴纹理块：块内纹理来自 src，边缘颜色/亮度渐变到 dst；
- 纯色 src + 纯色 dst：结果边界平滑，无黑边；
- `mask` 全 0 时结果逐字节等于 dst。

---

### 5.3 P1-A：Select and Mask / matting

**源**：`PhotoCraft/crates/algo/src/matting.rs`

关键函数与参数：

```rust
pub struct RefineParams { radius, smart_radius, smooth, feather, contrast, shift_edge } // :27
pub fn guided_filter_gray(...)  // :125
pub fn guided_filter_color(guide, p, r, eps) // :146
pub fn gaussian_blur(src, w, h, sigma) // :192
pub fn edge_width(img, r) // :284
pub fn refine_buffer(img, m, w, h, p) // :303
```

Shift Edge 是曲线而非线性：

```rust
fn shift_odds(&self) -> f32 { 49f32.powf(shift_edge / 100.0) } // :67
// odds = a/(1-a) 乘以该系数；-100% → 半覆盖降到 2%，+100% → 98%
```

实现顺序：

1. radius > 0 且给了图像：把 mask 二值化，找边界带；
2. 有 smart radius 时用 `edge_width` 自适应带宽；
3. 彩色引导的 guided filter 生成软边 α；
4. Smooth（σ = smooth/100*4）、Feather（σ = feather/2）；
5. Contrast；
6. Shift Edge 按 odds 曲线；
7. 颜色去污染： fringe 用附近完全选中像素的 normalized-convolution 平均替换，按 amount 与透明度混合。

**目标文件**：新建 `src/engine/algos/matting.ts`，改 `src/ui/components/RefineEdgeDialog.tsx`
与 `select.selectAndMask` 接线。

注意：`brush/morphology` 子模块缺失，但 `guided_filter_* / gaussian_blur / running_extreme`
主体都在文件里，足够先实现核心流程；morph 先用 `kernels.maximum/minimum` 近似。

验收：毛发/半透明边缘抠图有软边；`shift_edge=0` 不改变完全 0/1 像素；
`radius=0` 不应读图像。

---

### 5.4 P1-B：图割智能选区（GrabCut / maxflow / GMM / SLIC）

**源**：

- `segment/maxflow.rs:35` `Graph`，`:52` impl；BK + push-relabel；
- `segment/gmm.rs:55` `Gmm`，`:99` `fit`，全 3×3 协方差 + k-means++ + EM；
- `segment/grabcut.rs:36` `grabcut`，γ=50、K=5、最多 40000 采样；
- `segment/slic.rs:37` `slic`，`Superpixels` 结构；
- `segment/quick.rs` Quick Selection；
- `segment/subject.rs:53` `select_subject`。

实现顺序（不要一上来做 Subject）：

1. `src/engine/algos/maxflow.ts`：先写 BK 图结构（node/arc/residual/parent/orphan），
   再写 push-relabel。先支持 4-neighbor 网格。
2. `src/engine/algos/gmm.ts`：3×3 矩阵求逆、log 概率、k-means++、EM、refit。
3. `src/engine/algos/grabcut.ts`：trimap 常量
   `BG=0/FG=1/PR_BG=2/PR_FG=3`，5 分量 GMM，迭代 data cost + neighbor cost + min-cut。
4. 工作分辨率降到约 110k 像素，输出 mask 再全分辨率 recut 边界。
5. 再接 `object_select`（矩形对象选择）和 Quick Selection。

**目标文件**：`src/engine/algos/{maxflow,gmm,grabcut,slic}.ts`；
改 `src/core/smartSelect.ts`，保留现有 `*Hit` 纯函数作为无图割兜底。

重要：本地快照缺 `segment/mod.rs` 与 `maxflow/push_relabel.rs`，
如果 push-relabel 要逐行照搬，先按 2.3 补源；否则先用 BK 路径覆盖 GrabCut 常见尺寸。

验收：矩形框选主体能分出前景/背景；同样输入固定 seed 结果一致；
全 uniform 图像应返回 None/空选区而不是乱切。

---

### 5.5 P1-C：金字塔自动混合 / 焦堆栈

**源**：`PhotoCraft/crates/algo/src/pyramid.rs`

关键函数：

```rust
pub fn reduce(l, ch)        // :35  5-tap binomial + 降采样
pub fn expand(l, ch, w, h)  // :64  插零 + 同滤波 + 4x 增益
pub fn gaussian(...)        // :99
pub fn laplacian(...)       // :113
pub fn collapse(...)        // :128
pub fn blend(...)           // :149
pub struct StackFusion      // :183
pub fn fuse_stack(...)      // :429
```

原理：Burt & Adelson 拉普拉斯金字塔。每张图拆成带通层 + 低通残差；
权重图做高斯金字塔；每层按权重混合后 collapse。焦堆栈权重来自亮度拉普拉斯能量，
`energy_radius=1, halo=2, guide=2` 为默认，带 halo 控制避免光晕。

**目标文件**：新建 `src/engine/algos/pyramid.ts`；改 `src/core/stackOps.ts`
的 `autoBlendLayers` / `applyStackModeToDoc`；接线 `edit.autoBlendLayers`。

验收：两张焦平面不同的照片自动混合后文字/边缘清晰且无接缝；
纯相同图混合结果等于原图；层级数由 `auto_levels(w,h)` 决定，短边 ≤8 停止。

---

### 5.6 P1-E：内容识别填充增强（升级，不重写）

**源**：`PhotoCraft/crates/algo/src/inpaint.rs`

关键结构：

```rust
pub struct CompleteParams { patch_radius, em_iters, min_em_iters, pm_iters, refine_extent, adapt, seed } // :76
pub fn complete(w,h,ch,img,hole,p) // :102
pub fn best_offset(...)  // 自动 Healing 源
pub fn synthesize(...)   // 纹理合成
```

Strata 已有：`src/engine/inpaint.ts` 的扩散打底 + PatchMatch + SAT + 投票，
思路与 PhotoCraft 一致，别推倒。缺的是：

1. 多尺度金字塔（先粗后细，细层只 refine 匹配场）；
2. onion peel（从洞边缘向内逐环填，粗层不用膜打底）；
3. 细长洞按“厚度”而不是包围盒决定金字塔层数；
4. Image Melding：源 patch 允许 gain/bias 颜色适应；
5. `best_offset` 自动给修复画笔找源点。

注意 `inpaint.rs` 缺 5 个子源文件；可以先照文件头算法描述实现升级，
如果要逐行对照，按 2.3 补源。

验收：细长划痕填充后不留原物体轮廓；大洞结果有连续纹理而非平涂；
固定 seed 结果稳定。

---

### 5.7 P1-D：索引色质量升级

**源**：`PhotoCraft/crates/algo/src/quantize.rs`

关键 API：

```rust
pub enum PaletteKind { Exact, SystemMac, SystemWindows, Web, Uniform, Perceptual, Selective, Adaptive } // :17
pub enum Dither { None, Diffusion, Pattern, Noise } // :57
pub fn build_palette(px, kind, colors, forced) // :391
pub fn quantize(px, w, pal, dither, amount, transparent) // :481
```

Strata 现状：`core/colorMode.ts::medianCutPalette / toIndexed / applyPalette`。
升级点：

- `Perceptual = Lab median cut + k-means`；
- `Selective = Perceptual + web-safe 吸附`；
- `Adaptive = RGB 频率加权 median cut`；
- forced 色（黑白/原色/Web）；
- Floyd–Steinberg / Bayer / noise 抖动；
- 透明索引单独指定。

验收：渐变图 256 色无大面积色带；web-safe 色板恰好 216 色；
`image.mode.indexedColor` 参数面板能选 palette/dither/colors。

---

### 5.8 P2-A：ARAP 木偶变形（新增模式）

**源**：`PhotoCraft/crates/algo/src/puppet.rs`

```rust
pub enum PuppetDensity      // :54
pub struct PuppetWarp       // :103
pub fn build_mesh(src, bounds, density, expansion) // :614
pub fn puppet_warp(src, bounds, w, interp)         // :1116
pub fn puppet_warp_with_mask(...)                  // :1167
```

Strata 已有 `engine/meshWarp.ts::mlsWarp`（Schaefer MLS），
对小规模钉点效果够用。**不要替换**，新增 `mode: "mls" | "arap"`：

- MLS：保留现状；
- ARAP：三角形网格 + 每个三角形旋转最小化的稀疏线性求解；适合大形变保持面积。
- 先用固定迭代的 Gauss–Seidel / SOR 解，不要引入重型线性代数库。

验收：同一套钉点下，ARAP 比 MLS 更少拉伸；纯刚性旋转钉点能保持形状；
取消/确定走现有 `PuppetWarpDialog` 管线。

---

### 5.9 P2-D：Camera Raw 段落增强

**源**：`PhotoCraft/crates/algo/src/camera_raw.rs`

```rust
pub struct CameraRaw  // :113
pub fn curve_lut(pts, n) // :469
pub fn develop(px, w, h, p, float) // :684
```

九阶段：白平衡 → 去雾 → 局部 tone → clarity/texture → tone curve →
8 色带 mixer → color grading → detail → vignette/grain。
本地缺 `local_tone/per_pixel/spatial/whites_blacks` 子模块。

**目标**：不换 `strata_raw` 解码，不换 `strata_cms`。
只把能独立成纯函数的段落补进 `src/engine/adjustPixels.ts` / `src/engine/grading.ts`，
并让 `filter.cameraRaw` 的专用窗口（参数窗口化 P1）复用。

验收：白平衡/曲线/clarity 在 proxy 预览与全分辨率结果方向一致；
输入参数中性时图像不变。

---

### 5.10 P3：HDR / 全景（最后做）

- HDR：`hdr.rs` 的 `response_curve`（Debevec）、`merge`（MTB 对齐 + ghost removal）。
  需要先有多文档选择 UI 与曝光参数输入。
- 全景：`features.rs` Harris + steered BRIEF + RANSAC；
  `panorama.rs` 投影/配准。缺 `panorama/blend`，补源后再逐行照搬。
- 这两项都要求进度/取消/预览，不能同步跑全图。

---

## 6. Strata 全量改动清单

### 6.1 新增纯算法文件（建议目录 `src/engine/algos/`）

| 文件 | 来源 | 优先级 |
|---|---|---|
| `guidedFilter.ts` | `denoise.rs`、`matting.rs` 的 guided filter 段 | P0/P1 |
| `poisson.ts` | `poisson.rs` | P0 |
| `matting.ts` | `matting.rs` | P1 |
| `maxflow.ts` | `segment/maxflow.rs` | P1 |
| `gmm.ts` | `segment/gmm.rs` | P1 |
| `grabcut.ts` | `segment/grabcut.rs` | P1 |
| `slic.ts` | `segment/slic.rs` | P1/P2 |
| `pyramid.ts` | `pyramid.rs` | P1 |
| `quantizeLab.ts` | `quantize.rs` | P1 |
| `patchMatch.ts` | `inpaint.rs` 思路 + 现有 `engine/inpaint.ts` | P1 |
| `arap.ts` | `puppet.rs` | P2 |
| `lensDistortion.ts` | `lens.rs`、`wideangle.rs` | P2 |
| `statsStack.ts` | `stack.rs` | P2 |
| `features.ts` | `features.rs` | P3 |
| `hdr.ts` | `hdr.rs` | P3 |

### 6.2 需要修改的现有文件

| 文件 | 改动 |
|---|---|
| `src/engine/filters/kernels.ts` | `reduceNoise` 改调 guided filter；保留旧实现改名 `reduceNoiseLegacy` 供对照/测试 |
| `src/engine/inpaint.ts` | 接入多尺度/onion peel/gain-bias；保留现有导出签名 |
| `src/engine/meshWarp.ts` | 增加 `mode: "mls" | "arap"` 入口；不改现有 `mlsWarp` 行为 |
| `src/core/smartSelect.ts` | 保留 `*Hit` 纯函数；新增图割/GrabCut 结果包装；失败时回退现有启发式 |
| `src/core/selection.ts` | 接 matting/refine 结果到选区 alpha；不要改已有组合语义 |
| `src/core/colorMode.ts` | `medianCutPalette` 升级为 Lab/Selective/Adaptive；`toIndexed` 接 dither |
| `src/core/stackOps.ts` | 接 `pyramid.fuse_stack`、统计堆栈模式 |
| `src/core/layerOps.ts` | 只在新增“从选区新建图层/修复层”时加包装；**不要改 `activeLayerId` 规则** |
| `src/ui/EditorShell.tsx` | 给 `edit.contentAwareFill`、`select.subject/sky/focusArea/selectAndMask`、`edit.autoBlendLayers`、`image.mode.indexedColor`、`filter.noise.reduceNoise`、`filter.lensCorrection` 接新实现；新命令加 case 时保持 resolve 有返回值，否则菜单置灰 |
| `src/ui/components/RefineEdgeDialog.tsx` | 补 radius/smart radius/smooth/feather/contrast/shift edge/去污染参数 |
| `src/ui/components/ImageOpsDialog.tsx` | 新增/扩展 HDR、镜头校正、索引色、堆栈模式参数面板；无预览的要明确标注 |
| `src/ui/components/PuppetWarpDialog.tsx` | 增加 ARAP 模式选择 |
| `src/ui/components/FilterFxDialog.tsx` | 若 guided filter 拆成独立滤镜 def，自动出现；否则只改 reduceNoise 内核 |
| `src/i18n/*` | 新增参数/模式文案，全部语言同步；顶层分组有契约测试 |
| `src/styles/*.css` | 新组件类名必须带独占前缀（如 `.alg-`、`.ref-`），**禁止裸 `.cp` 这类名字** |

### 6.3 菜单 ID 对照（已在 `menuCatalog.data.ts` 中存在）

```text
edit.contentAwareFill          edit.autoBlendLayers
image.mode.indexedColor        select.focusArea
select.subject                 select.sky
select.selectAndMask           filter.noise.reduceNoise
filter.lensCorrection          filter.vanishingPoint
layer.smartObjects.puppetWarp  layer.smartObjects.perspectiveWarp
layer.smartObjects.stackMode.* （10 项统计模式）
```

新增功能如果菜单目录里本来没有，先加 `menuCatalog.data.ts`，
再到 `EditorShell.tsx` 的 `resolve/menuGroups` 里接上；返回 `undefined` 就是置灰。

### 6.4 UI 窗口策略

本轮先沿用现有 `Modal` / `AdjustDialog` / `FilterFxDialog` / `RefineEdgeDialog`。
等“参数窗口化”那一轮做完 `DraggableModal` 后，再把以下功能迁进可拖窗口：

- Select and Mask（大预览 + 边缘笔刷）；
- Content-Aware Fill（源刷/预览）；
- Camera Raw（7 页签）；
- Filter Gallery（效果堆栈）；
- HDR / Panorama（进度 + 多图预览）。

不要在算法改造轮里同时改 Modal 架构，避免一次引入两类 bug。

### 6.5 测试文件清单

新增：

```text
tests/unit/algos-guided-filter.test.ts
tests/unit/algos-poisson.test.ts
tests/unit/algos-matting.test.ts
tests/unit/algos-maxflow.test.ts
tests/unit/algos-grabcut.test.ts
tests/unit/algos-pyramid.test.ts
tests/unit/algos-quantize.test.ts
tests/unit/algos-stats-stack.test.ts
```

修改：

- `tests/unit/engine-inpaint.test.ts`：多尺度/细长洞回归；
- `tests/unit/smart-select.test.ts`：保留旧纯函数测试，新增图割结果测试；
- `tests/unit/color-mode.test.ts`：新 palette/dither 测试；
- `tests/unit/stack-and-shapes.test.ts`：金字塔/统计堆栈测试；
- `tests/unit/filter-truth.test.ts`：**73 滤镜必须保持 0 假**。

---

## 7. 硬约束（违反过就会出 bug）

1. **不要改 `activeLayerId` 语义**。`spliceAbove` 抢活动层曾导致“历史调色全没了”。
2. 预览走 `EditorShell.previewDoc` 的 ref-only 链：`markInteracting()` + `scheduleRender()`，
   拖动不进 React state；确定才落一条历史。
3. 新算法内核不碰 DOM/canvas，测试才能在 node 里跑。
4. 参数类菜单必须可取消、确定才落库；参数中性时禁用确定。
5. 重算法要有降采样 proxy、进度和取消，禁止 24MP 全分辨率在主线程直接算。
6. CSS 类名必须加独占前缀；`CommandPalette.css` 裸 `.cp` 污染 ColorPicker 的事故不能再犯。
7. 保留移植源码注释/许可证归属——PhotoCraft 代码注释里的 MIT/Apache-2.0 与 LGPL 来源声明不能删。
8. 零假功能：做不到就报错/禁用/明确降级，不能“看起来成功”。
9. RAW/CMS 不整体替换：`strata_raw` 与新版同源，`strata_cms` 已接真 ICC。
10. 本轮参数窗口化与算法改造分开做，避免同时动 Modal 架构和像素内核。

---

## 8. 验收命令与交付口径

每完成一个 P 级批次跑：

```bash
npx tsc --noEmit
npx vitest run
npm run build
```

完整打包：

```bash
npm run tauri:build
```

**用户明确要求**：改完前端不能只给 NSIS 安装包，必须直接替换根目录 `Strata.exe`：

```powershell
Copy-Item -LiteralPath src-tauri/target/release/strata.exe -Destination Strata.exe -Force
```

替换前确认没有进程占用；替换后比对 `dist/assets/index-*.js/css` 与 exe 内嵌资源文件名索引，
确认新前端真的进去了。

---

## 9. 附录：关键源码函数索引

```text
PhotoCraft/crates/algo/src/denoise.rs
  :32  guide_moments
  :42  guided_luma
  :59  guided_chroma
  :84  reduce_noise

PhotoCraft/crates/algo/src/poisson.rs
  :31  solve_membrane
  :103 sor
  :218 seamless_clone
  :230 membrane_fill

PhotoCraft/crates/algo/src/matting.rs
  :27  RefineParams
  :67  shift_odds
  :125 guided_filter_gray
  :146 guided_filter_color
  :192 gaussian_blur
  :284 edge_width
  :303 refine_buffer

PhotoCraft/crates/algo/src/pyramid.rs
  :35  reduce
  :64  expand
  :99  gaussian
  :113 laplacian
  :128 collapse
  :149 blend
  :183 StackFusion
  :429 fuse_stack

PhotoCraft/crates/algo/src/inpaint.rs
  :76  CompleteParams
  :102 complete
  :218 fill_with (content_aware.rs)

PhotoCraft/crates/algo/src/quantize.rs
  :17  PaletteKind
  :57  Dither
  :391 build_palette
  :481 quantize

PhotoCraft/crates/algo/src/camera_raw.rs
  :113 CameraRaw
  :469 curve_lut
  :684 develop

PhotoCraft/crates/algo/src/hdr.rs
  :165 response_curve
  :205 MergeOptions
  :230 merge

PhotoCraft/crates/algo/src/features.rs
  :25  Corner
  :36  Model
  :156 harris
  :437 ransac

PhotoCraft/crates/algo/src/segment/maxflow.rs :35 Graph
PhotoCraft/crates/algo/src/segment/gmm.rs     :55 Gmm / :99 fit
PhotoCraft/crates/algo/src/segment/grabcut.rs :36 grabcut
PhotoCraft/crates/algo/src/segment/slic.rs    :37 slic
PhotoCraft/crates/algo/src/segment/subject.rs :53 select_subject
PhotoCraft/crates/algo/src/puppet.rs          :614 build_mesh / :1116 puppet_warp
```

---

## 10. 本轮结论

- PhotoCraft 的“算法功能”不是神秘 AI，主要是**可解释、可移植的经典算法**。
- Strata 不需要照搬 3.8 万行；大量滤镜已等价。
- 真正要补的是 12 类硬算法，按 P0→P3 顺序推进。
- 本地快照不完整，缺 24 个顶层模块与 74 个子模块声明；
  移植已存在文件时按本文配方写 TS 纯函数，**需要逐行对照缺文件时先补源**。
- RAW/CMS 不替换；参数窗口化另起一轮。
- 本轮没有改业务源码、没有编译、没有提交；下回可直接按第 4/5/6 节执行。
