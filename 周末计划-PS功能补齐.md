# 周末计划 · Strata 对标 Photoshop 27.x 功能补齐

> 对照基准：用户提供的《Adobe Photoshop 完整功能全集（剔除 AI）》15 大类清单。
> 生成日期：2026-10-21
> 本文件 = 周末两天的作战清单。按 P1 → P2 → P3 顺序推进，P1 不行换 P2，P2 不行换 P3。

---

## 0. 判定规则与图例

### 三档优先级（严格按用户规定）

| 档位 | 含义 | 做法 |
| --- | --- | --- |
| **P1** | 最高 | 先去 **PhotoCraft 源码**里找同功能实现，做得好就直接搬 |
| **P2** | 次高 | PhotoCraft 没有 / 做得不行 → 去 GitHub 找**高星、专治该问题、确认开源**的库，直接接进来 |
| **P3** | 兜底 | 前两条都不行 → 自己写，按难度分级；**★★★★★ 或独家功能单列出来交用户决定是否放弃** |

### 现状图例

- ✅ 已上线可用
- 🟡 有内核 / 菜单已挂但没接线 / 只有半套
- ❌ 完全没有
- **不做**（已否决）：明确不实现，不再讨论
- **已保留**：确认要做，但排在试点之后的长线

### ⚠️ 关于「搬 PhotoCraft」的关键前提（必须先看）

1. **PhotoCraft 是 Rust 工程，Strata 是 React + TS + Canvas2D。**
   所以「搬」= **照着 Rust 源码把算法/交互逻辑移植成 TS**，不是 `import` 一个包。Rust 侧可以直接抄的是：卷积核、参数语义、边界处理、数据结构、UI 交互顺序。
2. **PhotoCraft 是 MIT / Apache-2.0 双授权**（仓库根有 `LICENSE-MIT`、`LICENSE-APACHE`），
   移植算法合法，但**必须在文件头保留来源声明**（写清 `Ported from ArtCraft PhotoCraft, MIT/Apache-2.0`）。
3. **用户点名要修的「逆天逻辑」**：PhotoCraft 部分滑块是松手才渲染。
   **硬性验收标准**：本项目所有滑块/数值必须**拖动中实时预览**（`requestAnimationFrame` 或 16ms 节流，禁止 `onPointerUp` 才计算）。
   已有的 `FilterGallery` 就是正确范例（`onPreview` 每帧推预览，不进历史）。
4. **PhotoCraft 源码路径**：`reference/artcraft-photocraft/`（完整 Rust workspace，`crates/` 下 25 个子 crate）。
   下面所有 P1 条目都会给出具体 crate / 文件路径。

### PhotoCraft 各 crate 能力速查（本次勘察结论）

| crate | 内容 | 对 Strata 的价值 |
| --- | --- | --- |
| `crates/psd` | PSD/PSB 读写、图层、路径、切片、图案、滤镜效果、`atn` 动作、`abr` 笔刷、`grd` 渐变、`aco`/`ase` 色板 | **最高**，一整个格式域 |
| `crates/algo` | ~70 个文件：blur / blur2 / sharpen / noise / distort / distort2 / stylize / stylize2 / artistic / artistic_fx / gallery / pixelate / render / render2 / other / other2 / lens / wideangle / liquify / oil / redeye / retouch / inpaint / matting / magnetic / perspective / puppet / vanishing / warp / hdr / panorama / stack / scancrop / selection / selection_blur / shape_blur / quantize / resample / histogram / exif / video | **最高**，滤镜全集 |
| `crates/vector` | shapes / stroke / edit / flatten / map / raster / trace | 矢量路径整套 |
| `crates/text` | layout / warp / scripts / cjk / optical / spell / psd / raster | 排版与文字变形 |
| `crates/cms` | profile / transform / lut3d / gamut / pipeline / proof | 色彩管理、色域警告、软打样 |
| `crates/color` | convert / blend | 颜色模式转换 |
| `crates/raw` | cr2 / cr3 / dng / nef / orf / raf / rw2 / demosaic / develop | 相机 RAW 解码 |
| `crates/heif` | HEIC/HEIF | HEIC 导入 |
| `crates/doc` | mode / blend_if / pattern / slices / video / variables / comps / effects | 位深模式、混合如果、图案、切片、变量组 |
| `crates/engine` | 200+ 个 `*_cmds.rs`，逐条对应 PS 菜单命令 | **命令语义字典**，接菜单时逐条对 |
| `crates/automation` | headless / rpc / bridge / files / workspace | 批处理与脚本宿主 |
| `crates/format` | autosave / manifest / migrate / atomic / zip | 自动保存、版本、工程迁移 |
| `crates/codecs` | web / exif / orientation / resolution / lab | 导出与元数据 |

---

## 1. 总体盘点

### 1.1 Strata 当前家底（已实现）

- **工具 22 个**：移动、矩形/椭圆选框、自由套索、魔棒、矩形/椭圆/直线形状、文字、画笔、橡皮擦、油漆桶、渐变、仿制图章、修复、模糊、锐化、减淡、加深、海绵、吸管、裁剪、抓手、缩放。
- **面板 8 个**：图层、通道（仅查看）、历史、属性、颜色、导航器、直方图、画笔设置。
- **图层**：像素 / 调整 / 组；调整层 **24 种**（bc、levels、curves、exposure、threshold、posterize、channellevels、shadowhighlight、hs、colorbalance、bw、channelmixer、invert、colortemp、photofilter、huesat、blackwhite、vibrance、selectivecolor、colorlookup、equalize、hdtoning、matchcolor、replacecolor、cameraraw）。
- **混合模式 27 种**（PS 全集，含 8 种软混合自实现）。
- **图层样式 6 种**：投影、内阴影、外发光、内发光、描边、颜色叠加。
- **绘制内核**：5 种笔尖（round/pencil/chalk/bristle/spray）、纹理、对称绘画、液化 5 模式、修复/仿制/减淡加深/海绵内核、填充/渐变 5 型。
- **选择**：矩形/椭圆/套索/魔棒、全选/取消/反向/相似、羽化/扩展/收缩/边界/平滑、变换选区。
- **视图**：标尺、参考线（含新式参考线）、网格、像素网格、智能参考线、吸附、全屏。
- **调色**：24 种调整层 + 自动色调/对比度/颜色 + 描边/填充/裁剪/图像大小/画布大小。
- **文件**：PNG/JPG/WebP/TIFF(读)/BMP/GIF 读；PNG 写；自有 `.strata` 工程格式。
- **滤镜**：仅 8 条接线（高斯模糊、动感模糊、锐化、添加杂色、液化、滤镜库、Camera Raw 面板、其余待补）。

### 1.2 整域缺失（周末的主战场，共 10 块）

| # | 整域 | 现状 | 优先级 | 难度 | 备注 |
| --- | --- | --- | --- | --- | --- |
| A | **PSD/PSB 读写** | ❌ | P1 → `crates/psd` / P2 `ag-psd` | ★★★★ | 最高价值，决定能不能进真实工作流 |
| B | **滤镜系统（~85 个）** | ❌ 仅 4 个真滤镜 | P1 → `crates/algo` | ★★★ | 量最大，但每个都独立、可并行 |
| C | **矢量 / 钢笔路径** | ❌ | P1 → `crates/vector` | ★★★★ | 矢量蒙版、路径文字、路径抠图都依赖它 |
| D | **通道存储 / 运算 / 专色** | 🟡 仅查看 | P1 → `engine/channel_cmds.rs` | ★★★ | 选区存通道、通道计算 |
| E | **动作 / 批处理 / 脚本** | ❌ | P1 → `engine/atn_cmds.rs` + `crates/automation` | ★★★★ | 差异化能力 |
| F | **Camera Raw 与相机 RAW 解码** | 🟡 只有面板 | P1 → `crates/raw` | ★★★★ | 专业用户刚需 |
| G | **色彩管理 / 位深 / CMYK·LAB** | ❌ | P1 `crates/cms` → P2 `colorjs.io` | ★★★★★ | **交用户决策** |
| H | **智能对象 / 智能滤镜** | ❌ | P1 `engine/smart_cmds.rs` | ★★★★★ | **交用户决策** |
| I | **文字排版深度 / 文字变形** | 🟡 只有基础 | P1 → `crates/text` | ★★★ | 字符/段落面板 + 变形 |
| J | **自动化导出 / 切片 / 存储为 Web** | ❌ | P1 `engine/slice_cmds.rs` `web_cmds.rs` | ★★★ | 电商/前端场景高频 |

---

## 2. 十五大类逐条缺口表

### 一、文件与项目管理

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 新建：像素/英寸/厘米/毫米/点/派卡/列/百分比 | 🟡 仅像素 + DPI | P3 | `engine/document_preset_cmds.rs` 抄单位换算表 | ★★ |
| 新建：位深度 8/16/32 | ❌ | **不做**（已否决） | `doc/mode.rs` | ★★★★★ |
| 新建：RGB/CMYK/灰度/LAB/索引 | 🟡 仅 RGB / 灰度 | **交决策**（CMYK/LAB） | `color/convert.rs` `cms/transform.rs` | ★★★★★ |
| 打开 PSD / PSB | ❌ | **P1** | `crates/psd/src/file.rs` `layer.rs` `pixels.rs` | ★★★★ |
| 打开 TIFF | ✅ | — | `engine/tiff.ts` | — |
| 打开 RAW（CR2/CR3/NEF/ARW/ORF/RAF/RW2/DNG） | ❌ | **P1** | `crates/raw/src/{cr2,cr3,nef,orf,raf,rw2,dng}.rs` | ★★★★ |
| 打开 PDF | ❌ | **P2** | `pdfjs-dist`（Apache-2.0） | ★★★ |
| 打开 EPS | ❌ | P3（低价值） | — | ★★★★ |
| 打开 SVG | ❌ | **P2** | `paper.js`（MIT）+ 浏览器 `DOMParser` | ★★ |
| 打开 EXR / HDR | ❌ | **P2** | `three`（MIT）里的 `EXRLoader` / `RGBELoader` | ★★★ |
| 置入（Place Embedded / Linked） | ❌ | P3 | `engine/file_cmds.rs` | ★★★ |
| 保存 PSD / PSB | ❌ | **P1** | `crates/psd/src/{file,builder,compression,resources}.rs` | ★★★★ |
| 保存 TIFF | ❌ | **P2** | `utif2`（MIT，支持写） | ★★ |
| 保存 JPEG（质量分级） | ❌ | P3 | `canvas.toBlob("image/jpeg", q)` | ★ |
| 保存 PNG | ✅ | — | `encodePng` | — |
| 保存 WebP | ❌ | P3 | `canvas.toBlob("image/webp")` | ★ |
| 保存 GIF | ❌ | **P2** | `gifenc`（MIT） | ★★ |
| 保存 BMP | ❌ | P3 | 手写 24bit BMP 编码（~80 行） | ★ |
| 保存 PDF | ❌ | **P2** | `pdf-lib`（MIT） | ★★ |
| 保存 EPS / DCS / PICT | ❌ | **不做**（已淘汰格式） | — | — |
| 自动保存 | ❌ | **P1** | `format/autosave.rs` | ★★ |
| 历史记录 | ✅ | — | `core/history.ts` | — |
| 版本历史（存多个快照） | ❌ | P3 | `format/manifest.rs` | ★★★★ |
| 文件信息 / 元数据编辑（XMP/IPTC） | ❌ | **P2** | `exifr`（MIT，读）+ 自写 XMP（★★★） | ★★★ |
| 批处理重命名 / 批量导出 | ❌ | P3 | 依赖 E 域（动作） | ★★ |
| 导入视频帧到图层 | ❌ | P3（低优先） | `engine/video_cmds.rs` | ★★★ |
| 导出图层为文件 | ❌ | P3 | `engine/export_preset_cmds.rs` | ★★ |
| 导出为 Web（优化 / 切片） | ❌ | P3 | `engine/web_cmds.rs` | ★★★ |
| Zoomify 导出 | ❌ | **不做**（Flash 时代遗留） | — | — |
| JSX 脚本 | ❌ | **P3 自研**（已保留） | `automation/headless.rs` | ★★★★★ |
| 动作录制（Actions） | ❌ | **P1** | `engine/atn_cmds.rs` + `psd/atn.rs` | ★★★★ |
| 数据组变量 | ❌ | P3 | `doc/variables.rs` `engine/variables_cmds.rs` | ★★★★ |
| 批处理（Batch） | ❌ | **P1** | `engine/automate_cmds.rs` | ★★★ |
| 联系表 II | ❌ | P3 | `engine/gallery_cmds.rs` | ★★ |
| 裁剪并修齐照片 | ❌ | **P1** | `algo/scancrop.rs` | ★★★ |

---

### 二、界面与工作区

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 工具箱全量 | 🟡 22/34 | 见下各域 | `tools/catalog.ts` 扩 `ToolId` | ★★ |
| 工具预设（保存一套工具参数） | ❌ | P3 | `engine/brush_preset_cmds.rs` | ★★ |
| 工作区自定义保存/加载 | 🟡 4 个内置工作区 | P3 | `engine/prefs.rs` | ★★ |
| 快捷键自定义 | 🟡 有入口 | P3 | `engine/shortcut_sets.rs` | ★★ |
| 菜单自定义 | ❌ | P3 | — | ★★ |
| 面板：图层/通道/历史/属性/颜色/导航/直方图/画笔 | ✅ | — | — | — |
| 面板：动作 | ❌ | **P1** | `engine/atn_cmds.rs` | ★★★ |
| 面板：调整 | ❌ | P3 | — | ★★ |
| 面板：样式 | ❌ | P3 | `engine/layer_style.rs` | ★★ |
| 面板：字符 / 段落 | ❌ | **P1** | `text/layout.rs` `engine/type_cmds.rs` | ★★★ |
| 面板：路径 | ❌ | **P1** | `engine/path_edit_cmds.rs` | ★★★ |
| 面板：色板（潘通 / 肤色 / Web 安全色） | 🟡 内置若干色卡 | **P1** | `psd/aco.rs` `psd/ase.rs` `engine/swatch_cmds.rs` | ★★ |
| 面板：仿制源 | ❌ | P3 | `engine/stamp_cmds.rs` | ★★ |
| 面板：信息（坐标/色值/尺寸） | 🟡 状态栏部分 | P3 | — | ★ |
| 标尺 / 参考线 / 网格 / 智能参考线 | ✅ | — | — | — |
| 注释 | ❌ | P3 | `engine/notes_cmds.rs` | ★★ |
| 测量 / 计数工具 | ❌ | P3 | `engine/sampler_cmds.rs` | ★★ |
| 全屏模式 / Tab 隐藏面板 | ✅ | — | — | — |
| 多窗口视图 | ❌ | P3 | `engine/group_view_cmds.rs` | ★★★★ |
| 缩放 25%–3200% | 🟡 需核对上限 | P3 | — | ★ |
| 旋转画布 | ❌ | **P1** | `engine/vp_cmds.rs` | ★★ |

---

### 三、选择与选区

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 矩形 / 椭圆选框 | ✅ | — | — | — |
| 单行 / 单列选框 | ❌ | P3 | 复用 `rectMask` | ★ |
| 自由套索 | ✅ | — | — | — |
| 多边形套索 | ❌ | P3 | `lassoMask` 加点集即可 | ★★ |
| 磁性套索 | ❌ | **P1** | `algo/magnetic.rs` `engine/magnetic_cmds.rs` | ★★★ |
| 魔棒（容差/连续/消除锯齿） | ✅ | — | — | — |
| 快速选择 | ❌ | **P1** | `algo/selection.rs` | ★★★ |
| 全选 / 取消 / 反向 | ✅ | — | — | — |
| 色彩范围 | ❌ | **P1** | `algo/selection.rs` | ★★★ |
| 变换选区 | ✅ | — | — | — |
| 羽化 / 扩展 / 收缩 / 边界 / 平滑 | ✅ | — | — | — |
| 扩大选取 / 选取相似 | 🟡 有「选取相似」 | P3 | `engine/select_extra_cmds.rs` | ★ |
| 存储 / 载入选区（Alpha 通道） | ❌ | **P1** | `engine/channel_cmds.rs` | ★★★ |
| 选区 ↔ 通道互转 | 🟡 仅单向 | **P1** | 同上 | ★★ |
| 选区运算（加/减/交） | ✅ | — | — | — |
| 快速蒙版模式 | ❌ | **P1** | `engine/mask_view_cmds.rs` | ★★★ |
| 调整边缘（传统 Refine Edge） | 🟡 只有羽化/平滑 | **P1** | `algo/matting.rs` `algo/selection_blur.rs` | ★★★ |
| 通道抠图 | 🟡 有 `channelToSelection` | **P1** | 同上 + 通道存储 | ★★★ |
| 路径抠图 | ❌ | **P1** | `vector/trace.rs` | ★★★★ |
| 魔术橡皮擦 | ❌ | P3 | 复用 `wandMask` | ★★ |
| 背景橡皮擦 | ❌ | **P1** | `algo/erase.rs` `engine/eraser_cmds.rs` | ★★★ |
| 抽出滤镜（旧版） | ❌ | **不做**（PS 已移除） | — | — |
| 智能选择：主体/天空/焦点 | ❌ | **不做**（AI，已剔除） | — | — |

---

### 四、图层系统

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 像素图层 | ✅ | — | — | — |
| 调整图层（PS 19 种） | ✅ 24 种已超 | — | — | — |
| 填充层：纯色 | ✅ | — | — | — |
| 填充层：渐变 / 图案 | ❌ | **P1** | `engine/gradient_fill_cmds.rs` `pattern_fill_cmds.rs` | ★★ |
| 文本图层 | 🟡 创建后栅格化 | **P1** | `doc/text.rs` | ★★★ |
| 形状图层（矩形/椭圆/直线） | ✅ | — | — | — |
| 智能对象 | ❌ | **交决策** | `engine/smart_cmds.rs` | ★★★★★ |
| 视频图层 | ❌ | **不做**（见十三） | — | — |
| 3D 图层 | ❌ | **不做**（PS 26 已移除 3D） | — | — |
| 背景图层 | ❌ | P3 | `engine/background_cmds.rs` | ★ |
| 图层样式：投影/内阴影/外发光/内发光/描边/颜色叠加 | ✅ | — | — | — |
| 图层样式：斜面与浮雕 | ❌ | **P1** | `psd/filter_effects.rs` `engine/layer_style.rs` | ★★★ |
| 图层样式：光泽 | ❌ | **P1** | 同上 | ★★ |
| 图层样式：渐变叠加 | ❌ | **P1** | 同上 | ★★ |
| 图层样式：图案叠加 | ❌ | **P1** | 同上 + `doc/pattern.rs` | ★★ |
| 等高线 / 纹理 / 全局光 / 缩放效果 | ❌ | **P1** | 同上 | ★★★ |
| 混合模式 27 种 | ✅ | — | — | — |
| 混合如果（Blend If） | ❌ | **P1** | `doc/blend_if.rs` | ★★★ |
| 图层新建/复制/删除/合并/盖印/组/链接 | ✅ 大部分 | — | — | — |
| 锁定（透明/像素/位置/全部） | 🟡 需核对 | P3 | `engine/hidden_target.rs` | ★★ |
| 不透明度 / 填充不透明度 | ✅ / ❌ | **P1** | `engine/fx_visibility_cmds.rs` | ★★ |
| 图层过滤（类型/名称/效果/模式） | ❌ | P3 | `engine/layer_list_cmds.rs` | ★★ |
| 智能对象：嵌套/替换/堆栈 | ❌ | **交决策** | `engine/smart_cmds.rs` | ★★★★★ |
| 图层蒙版 | ✅ | — | — | — |
| 矢量蒙版 | ❌ | **P1**（依赖 C 域） | `engine/layer_mask_props_cmds.rs` | ★★★★ |
| 剪贴蒙版 | ✅ | — | — | — |
| 排列 | ✅ | — | — | — |
| 对齐 / 分布 | ❌ | P3 | `engine/align_cmds.rs` | ★★ |
| 基于图层新建文档 | ❌ | P3 | `engine/layer_copy_cmds.rs` | ★ |
| 图层颜色标签 | ❌ | P3 | `engine/layer_label_cmds.rs` | ★ |
| 画面板（Artboard） | ❌ | P3 | `engine/artboard_cmds.rs` | ★★★★ |
| 框架（Frame） | ❌ | P3 | `engine/frame_cmds.rs` | ★★★ |
| 图层复合（Comps） | ❌ | P3 | `doc/comps.rs` `engine/comps_cmds.rs` | ★★★ |

---

### 五、绘画与修饰工具

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 画笔 / 笔刷预设（数百款） | 🟡 5 种笔尖 | **P1** | `psd/abr.rs` `engine/brush_preset_cmds.rs` | ★★★ |
| 笔刷设置：形状动态/散布/纹理/双重画笔/颜色动态/传递/湿边/平滑/杂色 | 🟡 部分 | **P1** | `engine/brush_cmds.rs` | ★★★ |
| 铅笔 | ❌ | P3 | 复用 `Tip = "pencil"` | ★ |
| 颜色替换画笔 | ❌ | **P1** | `algo/retouch.rs` `engine/retouch_cmds.rs` | ★★ |
| 混合器画笔 | ❌ | **P1** | `algo/paint.rs` `engine/paint_cmds.rs` | ★★★★ |
| 橡皮擦 | ✅ | — | — | — |
| 背景橡皮擦 | ❌ | **P1** | `algo/erase.rs` | ★★★ |
| 魔术橡皮擦 | ❌ | P3 | 复用 `wandMask` | ★★ |
| 仿制图章 | ✅ | — | — | — |
| 图案图章 | ❌ | **P1** | `doc/pattern.rs` `engine/stamp_cmds.rs` | ★★ |
| 仿制源面板（多源/位移/缩放旋转） | ❌ | **P1** | 同上 | ★★ |
| 修复画笔 | ✅ | — | — | — |
| 污点修复画笔 | 🟡 与修复同源 | **P1** | `algo/inpaint.rs` | ★★ |
| 修补工具 | ❌ | **P1** | `algo/inpaint.rs` | ★★★ |
| 红眼工具 | ❌ | **P1** | `algo/redeye.rs` `engine/redeye_cmds.rs` | ★★ |
| 历史记录画笔 | ❌ | **交决策** | `engine/history_cmds.rs`（需像素级快照） | ★★★★ |
| 历史记录艺术画笔 | ❌ | **交决策** | 同上 | ★★★★ |
| 模糊 / 锐化 / 涂抹 | ✅ | — | — | — |
| 减淡 / 加深 / 海绵 | ✅ | — | — | — |
| 渐变（5 型） / 油漆桶 | ✅ | — | — | — |
| 液化 | ✅ 5 模式 | P3 补 重建/镜像/湍流 | `algo/liquify.rs` | ★★ |
| 消失点 | ❌ | **P3 自研**（已保留） | `algo/vanishing.rs` | ★★★★★ |
| 透视变形 | ❌ | **P3 自研**（已保留） | `algo/perspective.rs` | ★★★★★ |
| 操控变形 | ❌ | **P3 自研**（已保留） | `algo/puppet.rs` | ★★★★★ |
| 内容识别填充 / 内容感知移动缩放 | — | **不做**（AI，已剔除） | 注意：`engine/inpaint.ts` 已存在，但不在本次新增范围 | — |

---

### 六、颜色与调色

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| RGB / 灰度 | ✅ | — | — | — |
| 位图 / 索引 / 双色调 | ❌ | **交决策** | `doc/mode.rs` | ★★★★ |
| LAB | ❌ | **交决策** | `codecs/lab.rs` `color/convert.rs` | ★★★★ |
| CMYK | ❌ | **交决策** | `cms/transform.rs` `engine/flatten_cmyk_tests.rs` | ★★★★★ |
| 位深 8/16/32 | ❌ | **不做**（已否决） | `doc/mode.rs` | ★★★★★ |
| HDR 色调映射 | ✅ | — | — | — |
| 色阶 / 曲线 / 亮度对比度 / 曝光度 | ✅ | — | — | — |
| 色相饱和度 / 自然饱和度 / 色彩平衡 | ✅ | — | — | — |
| 通道混合器 / 可选颜色 / 替换颜色 / 匹配颜色 | ✅ | — | — | — |
| 渐变映射 / 照片滤镜 / 阴影高光 / HDR 色调 | ✅ | — | — | — |
| 反相 / 色调分离 / 阈值 / 去色 / 黑白 | ✅ | — | — | — |
| 自动色调 / 自动对比度 / 自动颜色 | ✅ | — | — | — |
| 色彩管理：工作空间 / 显示器校样 / 软打样 / 色域警告 | ❌ | **P1 → P2** | `cms/{profile,transform,gamut,pipeline}.rs`；P2 `colorjs.io` + `lcms-wasm` | ★★★★ |
| 吸管工具 | ✅ | — | — | — |
| 颜色取样器（面板 + 多点） | 🟡 浮层已有取样点 | P3 | `engine/sampler_cmds.rs` `sample_cmds.rs` | ★★ |
| 色板：潘通 / 肤色 / Web 安全色 | 🟡 内置少量 | **P1** | `psd/aco.rs` `psd/ase.rs` `engine/swatch_cmds.rs` | ★★ |
| 信息面板数值 | 🟡 状态栏 | P3 | — | ★ |
| Camera Raw 面板深度（白平衡/HSL/细节/镜头校正/校准/预设/批量同步） | 🟡 只有简化版 | **P1** | `algo/camera_raw.rs` `algo/lens.rs` `raw/develop.rs` | ★★★★ |
| 镜头校正（畸变/色差/晕影） | ❌ | **P1** | `algo/lens.rs` `engine/lens_cmds.rs` | ★★★ |
| 自适应广角 | ❌ | **P1** | `algo/wideangle.rs` | ★★★ |

---

### 七、滤镜系统（缺口最大，~85 个）

> 现状：**真正接线只有 4 个**（高斯模糊、动感模糊、锐化、添加杂色）+ 液化 + 滤镜库（其实只是 5 个 effect 族调整）。
> 全部照 `crates/algo` 搬；每个滤镜都是独立函数，可并行、可批量。

| 组 | 已有 | 缺失 | 适配文件 | 优先级 | 难度 |
| --- | --- | --- | --- | --- | --- |
| 模糊 | 高斯 ✅、动感 ✅ | 表面、方框、模糊/进一步模糊、径向、镜头、平均、特殊、形状 | `algo/blur.rs` `algo/blur2.rs` `algo/shape_blur.rs` | **P1** | ★★ |
| 锐化 | 锐化 ✅ | USM 锐化、智能锐化（传统）、进一步锐化 | `algo/sharpen.rs` | **P1** | ★★ |
| 杂色 | 添加杂色 ✅ | 减少杂色、中间值、去斑 | `algo/noise.rs` `algo/denoise.rs` | **P1** | ★★ |
| 扭曲 | 液化 ✅ | 波浪、波纹、极坐标、球面化、置换、旋转扭曲、挤压、切变、水波 | `algo/distort.rs` `algo/distort2.rs` `algo/warp.rs` | **P1** | ★★★ |
| 扭曲·镜头 | — | 镜头校正、自适应广角 | `algo/lens.rs` `algo/wideangle.rs` | **P1** | ★★★ |
| 渲染 | — | 云彩、分层云彩、纤维、镜头光晕、光照效果 | `algo/render.rs` `algo/render2.rs` | **P1** | ★★★ |
| 风格化 | — | 查找边缘、浮雕、等高线、风、扩散、拼贴、曝光过度、照亮边缘、凸出、油画 | `algo/stylize.rs` `algo/stylize2.rs` `algo/oil.rs` | **P1** | ★★★ |
| 素描（14 件） | — | 半调图案、便条纸、粉笔和炭笔、铬黄渐变、绘图涂抹、基底凸现、石膏效果、水彩画纸、撕边、塑料效果、炭笔、图章、网状、影印 | `algo/artistic.rs` `algo/artistic_fx.rs` | **P1** | ★★ |
| 纹理（7 件） | — | 龟裂缝、颗粒、马赛克拼贴、拼缀图、染色玻璃、纹理化、彩色半调 | `algo/artistic_fx.rs` `algo/pixelate.rs` | **P1** | ★★ |
| 像素化（7 件） | — | 彩块化、彩色半调、点状化、晶格化、马赛克、碎片、铜版雕刻 | `algo/pixelate.rs` `algo/quantize.rs` | **P1** | ★ |
| 艺术效果（15 件） | — | 壁画、彩色铅笔、粗糙蜡笔、底纹效果、干画笔、海报边缘、海绵、绘画涂抹、胶片颗粒、木刻、霓虹灯光、水彩、塑料包装、调色刀、涂抹棒 | `algo/artistic.rs` `algo/artistic_fx.rs` | **P1** | ★★ |
| 视频 | — | 逐行（去隔行）、NTSC 颜色 | `algo/video.rs` | P3（低价值） | ★ |
| 其它 | — | 高反差保留、自定义（卷积核矩阵）、最大值/最小值、位移 | `algo/other.rs` `algo/other2.rs` `algo/fxutil.rs` | **P1** | ★★ |
| 滤镜库（分类浏览） | 🟡 只是 5 个调整 | 需要按组分类、缩略预览 | `algo/gallery.rs` `engine/gallery_cmds.rs` | **P1** | ★★★ |
| 智能滤镜（可改参 / 滤镜蒙版 / 混合模式） | ❌ | 整域 | `engine/smart_cmds.rs` | **交决策** | ★★★★★ |
| Digimarc 水印 | ❌ | **不做**（需商业 SDK） | — | — | — |

---

### 八、文字系统

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 点文本 | ✅ | — | — | — |
| 段落文本 / 文本框 | 🟡 自动换行 | **P1** | `text/layout.rs` | ★★ |
| 路径文字 | ❌ | **P1**（依赖 C 域） | `text/layout.rs` | ★★★★ |
| 字符面板（字号/字距/行距/微调/缩放/基线/上下标/大小写/语言） | 🟡 只有字号/字体/对齐 | **P1** | `text/layout.rs` `text/optical.rs` | ★★★ |
| 段落面板（缩进/段前段后/连字/避头尾） | ❌ | **P1** | `text/cjk.rs` `text/layout.rs` | ★★★ |
| 文字变形（15 种） | ❌ | **P1** | `text/warp.rs` | ★★★ |
| 文字栅格化 | ✅ | — | — | — |
| OpenType 特性 | ❌ | **P2** | `harfbuzzjs`（MIT） | ★★★ |
| 可变字体 | ❌ | P3 | `fontkit`（MIT） | ★★★ |
| 字符样式 / 段落样式面板 | ❌ | **P1** | `doc/text_styles.rs` `engine/type_styles_cmds.rs` | ★★★ |
| 文字转换工作路径 / 转为形状 | ❌ | **P1** | `text/psd.rs` `vector/` | ★★★ |
| 拼写检查 | ❌ | P3 | `text/spell.rs` | ★★★ |
| 竖排文字 | ❌ | P3 | `text/vertical_tests.rs` | ★★★ |

---

### 九、路径与矢量（整域缺失）

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 钢笔 / 自由钢笔 / 磁性钢笔 | ❌ | **P1** | `vector/edit.rs` `vector/stroke.rs` `engine/path_edit_cmds.rs` | ★★★★ |
| 弯度钢笔 / 锚点添加删除转换 | ❌ | **P1** | 同上 | ★★★ |
| 路径选择 / 直接选择 | ❌ | **P1** | 同上 | ★★★ |
| 路径运算（合并/减去/相交/排除） | ❌ | **P1** | `vector/shapes.rs` | ★★★★ |
| 路径对齐分布 | ❌ | P3 | `engine/align_cmds.rs` | ★★ |
| 形状工具：圆角矩形 / 多边形 / 自定形状 | 🟡 仅矩形/椭圆/直线 | **P1** | `vector/shapes.rs` | ★★ |
| 形状预设库（数百款） | ❌ | **P1** | `vector/shapes.rs` | ★★ |
| 路径面板 / 存储路径 | ❌ | **P1** | `psd/path.rs` | ★★★ |
| 描边路径 / 填充路径 | ❌ | **P1** | `vector/stroke.rs` `engine/fill_cmds.rs` | ★★ |
| 导出路径到 Illustrator | ❌ | P3 | 写 SVG path（自研 ~100 行） | ★★ |
| SVG 导入导出 | ❌ | **P2** | `paper.js`（MIT） | ★★ |
| 矢量智能对象 | ❌ | **交决策** | — | ★★★★★ |

---

### 十、通道系统

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 颜色通道（RGB/CMYK/LAB） | 🟡 RGB 查看 | **P1**（CMYK/LAB 见六） | `engine/channel_cmds.rs` | ★★★ |
| Alpha 通道（存选区） | ❌ | **P1** | `psd/layer.rs` + `engine/channel_cmds.rs` | ★★★ |
| 专色通道 | ❌ | **交决策** | `engine/multichannel_cmds.rs` | ★★★★ |
| 通道新建/复制/删除 | ❌ | **P1** | `engine/channel_cmds.rs` | ★★ |
| 通道分离 / 合并 | ❌ | **P1** | `engine/channel_cmds.rs` | ★★ |
| 通道运算（相加/相减/交叠） | ❌ | **P1** | `engine/channel_cmds.rs` | ★★★ |
| 图像计算（Calculations / Apply Image） | ❌ | **P1** | `algo/stack.rs` `engine/image_cmds.rs` | ★★★ |
| 通道抠图 | 🟡 半套 | **P1** | 同上 | ★★★ |
| 通道调色（通道色阶） | ✅ | — | — | — |

---

### 十一、自动化与批处理

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 动作录制 / 编辑 / 播放 | ❌ | **P1** | `engine/atn_cmds.rs` `psd/atn.rs` `engine/actions_cmds.rs` | ★★★★ |
| 动作组管理 / 条件动作 / 按钮模式 | ❌ | **P1** | `engine/actions_edit_cmds.rs` | ★★★ |
| 批处理 / 快捷批处理 | ❌ | **P1** | `engine/automate_cmds.rs` `automation/files.rs` | ★★★ |
| 联系表 / PDF 演示文稿 / 图片包 | ❌ | P3 | `engine/gallery_cmds.rs` | ★★ |
| 裁剪并修齐照片 / 镜头校正批处理 | ❌ | **P1** | `algo/scancrop.rs` | ★★★ |
| 脚本（JSX/VBScript/AppleScript） | ❌ | **P3 自研**（已保留） | `automation/{headless,rpc,security}.rs` | ★★★★★ |
| 数据组（变量） | ❌ | P3 | `doc/variables.rs` | ★★★★ |
| 自动对齐 / 自动混合 / 堆栈 | ❌ | P3 | `algo/stack.rs` `algo/panorama.rs` | ★★★★ |

---

### 十二、3D 功能

**结论：不做。**

理由：Photoshop 26（2024）起已从主程序移除 3D 相关功能，27.x 里只剩极少数遗留入口。用户给的清单里 3D 属于历史包袱，投入产出比极低。
（参考实现确有 `engine/{3d}`、`doc/video.rs` 等，但不建议投入。）

---

### 十三、视频时间轴

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 时间轴面板 / 关键帧 / 过渡 | ❌ | P3（本轮不做） | `engine/timeline_cmds.rs` `doc/video.rs` | ★★★★ |
| 帧动画 | ❌ | P3 | 同上 | ★★★ |
| 视频导入导出 / 帧转图层 | ❌ | P3 | `engine/video_cmds.rs` `algo/video.rs` | ★★★★ |

> 备注：真要做，优先用 `mp4-muxer` / `webm-muxer`（MIT）+ `canvas.captureStream()`，不要自己造编码器。

---

### 十四、导出与 Web

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| 导出为 PNG | ✅ | — | — | — |
| 导出为 JPG / WebP / AVIF / GIF | ❌ | P3 | `canvas.toBlob` + `gifenc`（P2） | ★★ |
| 存储为 Web 所用格式（压缩/切片/透明） | ❌ | **P1** | `engine/web_cmds.rs` `codecs/web.rs` | ★★★ |
| 切片工具 / 切片选择工具 | ❌ | **P1** | `engine/slice_cmds.rs` `doc/slices.rs` `psd/slices.rs` | ★★★ |
| 导出图层 / 画板 | ❌ | P3 | `engine/export_preset_cmds.rs` | ★★ |
| 元数据嵌入 | ❌ | P3 | `codecs/exif_color.rs` | ★★★ |
| 导出 PSD / PDF | ❌ | 见一 | — | — |

---

### 十五、Adobe 联动

| 功能 | 现状 | 优先级 | 参考来源 | 难度 |
| --- | --- | --- | --- | --- |
| ↔ Illustrator：PSD/AI 互导、矢量互粘、路径复制 | ❌ | P3（只做 SVG 路径导出） | 自研 SVG 写出 | ★★ |
| ↔ Lightroom：RAW 往返 | ❌ | **不做** | — | — |
| ↔ Premiere / AE：动态链接 | ❌ | **不做** | — | — |
| ↔ Bridge：素材管理 / 批处理 | ❌ | **不做**（无 Bridge 依赖） | — | — |
| ↔ InDesign：置入 PSD 保留图层样式 | ❌ | **不做** | — | — |
| 云文档 / CC 库 | ❌ | **不做**（无云端） | — | — |

---

## 3. P1 打包清单（PhotoCraft 可直接蒸馏，按收益排序）

> 全部来源：`reference/artcraft-photocraft/`，MIT / Apache-2.0。
> **统一硬性要求：实时预览、可撤销、不阻塞主线程（超过 16ms 的滤镜下放 Worker）。**

| 顺序 | 任务包 | 覆盖 PS 条目 | 源码位置 | 预估量级 |
| --- | --- | --- | --- | --- |
| 1 | **滤镜军团（第一批：模糊/锐化/杂色/像素化）** | ~20 个滤镜 | `algo/{blur,blur2,sharpen,noise,pixelate,quantize}.rs` | 一天内可完成，收益最大 |
| 2 | **滤镜军团（第二批：扭曲/风格化/其它）** | ~20 个滤镜 | `algo/{distort,distort2,stylize,stylize2,other,other2,warp}.rs` | 一天 |
| 3 | **滤镜军团（第三批：素描/纹理/艺术效果）** | ~36 个滤镜 | `algo/{artistic,artistic_fx}.rs` | 半天（参数模板化） |
| 4 | **PSD 读写** | 打开/保存 PSD、图层、蒙版、路径、样式、切片 | `crates/psd/**`；可并行验证 `ag-psd`（P2） | 2–3 天 |
| 5 | **通道系统** | Alpha 通道、存/载选区、通道运算、图像计算 | `engine/channel_cmds.rs` `image_cmds.rs` | 1–2 天 |
| 6 | **快速蒙版 + 调整边缘** | 快速蒙版、细化边缘 | `engine/mask_view_cmds.rs` `algo/matting.rs` | 1 天 |
| 7 | **矢量路径（钢笔）** | 钢笔/路径面板/路径运算/矢量蒙版/路径文字/路径抠图 | `crates/vector/**` `engine/path_edit_cmds.rs` | 3–4 天 |
| 8 | **文字深度** | 字符/段落面板、文字变形、字符样式 | `crates/text/**` `doc/text_styles.rs` | 2–3 天 |
| 9 | **图层样式补齐** | 斜面浮雕、光泽、渐变叠加、图案叠加、全局光 | `psd/filter_effects.rs` `engine/layer_style.rs` | 1–2 天 |
| 10 | **填充层 + 图案** | 渐变填充、图案填充、图案库、图案图章 | `engine/{gradient_fill,pattern_fill,pattern}_cmds.rs` | 1 天 |
| 11 | **动作 / 批处理** | 动作录制播放、批处理、联系表 | `engine/atn_cmds.rs` `automate_cmds.rs` `automation/**` | 3–4 天 |
| 12 | **Camera Raw + 镜头** | 镜头校正、自适应广角、ACR 深度 | `algo/{camera_raw,lens,wideangle}.rs` `raw/develop.rs` | 3–4 天 |
| 13 | **切片 / 存储为 Web** | 切片工具、导出优化 | `engine/{slice,web}_cmds.rs` `doc/slices.rs` | 2 天 |
| 14 | **小工具补齐** | 多边形套索、单行单列、魔术橡皮擦、铅笔、图案图章、红眼、颜色替换、通道运算 | `engine/{select_extra,magnetic,redeye,retouch}_cmds.rs` | 2 天 |
| 15 | **旋转画布 / 色板库** | 旋转视图、ACO/ASE 色板导入 | `engine/vp_cmds.rs` `psd/aco.rs` | 半天 |

---

## 4. P2 GitHub 候选库（已核过许可的优先）

| 用途 | 库 | 许可 | 星量级 | 备注 |
| --- | --- | --- | --- | --- |
| PSD 读写（TS 原生） | `ag-psd` | MIT | 高（数千） | **最稳的 P2 方案**，支持图层/蒙版/文字/效果 |
| PSD 只读（快） | `@webtoon/psd` | Apache-2.0 | 中高 | 只读、性能好，适合做预览 |
| TIFF 读写 | `utif2` | MIT | 中 | 写 TIFF 用它 |
| GIF 编码 | `gifenc` | MIT | 中高 | 快、体积小 |
| PDF 读写 | `pdf-lib` | MIT | 很高 | 导出 PDF / PDF 演示文稿 |
| PDF 渲染 | `pdfjs-dist` | Apache-2.0 | 很高 | 导入 PDF 为图层 |
| EXIF / XMP 读 | `exifr` | MIT | 高 | 元数据面板 |
| 色彩管理 | `colorjs.io` | MIT | 高 | 色域转换、色差、软打样近似 |
| ICC 引擎 | `lcms-wasm` | 需核实（LittleCMS 本体 MIT） | 低 | 真 ICC 变换才需要 |
| SVG / 矢量运算 | `paper.js` | MIT | 高 | 路径布尔运算、SVG 导入导出 |
| 贝塞尔计算 | `bezier-js` | MIT | 高 | 钢笔曲线求值、分割、偏移 |
| 多边形布尔 | `polygon-clipping` | MIT | 中高 | 轻量替代 paper.js 的路径运算 |
| 字体整形 | `harfbuzzjs` | MIT | 中高 | OpenType 连字、复杂脚本 |
| 字体解析 | `fontkit` | MIT | 高 | 可变字体、字形轮廓 |
| HEIC 解码 | `libheif-js` | LGPL-3.0 | 中 | **注意 LGPL**，需确认分发方式 |
| EXR 解码 | `three` 的 `EXRLoader` | MIT | 很高 | 只为解码也可单抽 |
| 视频封装 | `mp4-muxer` / `webm-muxer` | MIT | 高 | 第 13 域要做时才用 |

> **P2 使用原则**：能用库就不自己写编解码；但**滤镜算法优先 P1**（PhotoCraft 的实现更贴近 PS 语义，且能避免引入大依赖）。

---

## 5. P3 自研 + 难度分级

| 难度 | 条目 |
| --- | --- |
| ★ | 单行/单列选框、铅笔、导出 JPEG/WebP/BMP、缩放上限核对、基于图层新建文档、图层颜色标签、扩展选取 |
| ★★ | 单位切换、多边形套索、魔术橡皮擦、仿制源面板、对齐分布、图层过滤、信息面板、注释、计数、工具预设、工作区自定义、快捷键自定义、路径对齐、导出图层 |
| ★★★ | 智能参考线扩展、批处理重命名、导出图层为文件、联系表、元数据编辑、可变字体、竖排文字、拼写检查 |
| ★★★★ | 版本历史、多窗口视图、画板、框架、图层复合、视频时间轴、通道专色、数据组变量 |

---

## 6. ⚠️ 难度极高 / 独家功能 —— 决策结果

> 2026-10-21 拍板：**第 1 项去掉，第 2、3 项留着**。
> 留下的不要求一次做完，先按第 8 节「小试点」跑通闭环，再按批推进。

### 6.1 已定（本轮）

| 状态 | 功能 | 决策 | 落地路径 |
| --- | --- | --- | --- |
| ❌ **已否决** | **16/32 位深工作流** | **不做** | 整条管线（Surface、合成、混合、滤镜、历史）都得换浮点，现有 Canvas2D 8 位路线要重写，等于从头重做一遍引擎，投入产出不成正比 |
| ✅ **已保留** | **动作录制 + JSX 脚本** | **做**，长线 | 三步走：① 把 `EditorShell` 的 `case` 分支抽成「命令总线」（可序列化指令 + 参数 schema）；② 录制/播放动作、保存 `.atn`；③ JS 脚本沙箱执行同一套命令总线（先做 JS，JSX 语法差异后置） |
| ✅ **已保留** | **消失点** | **做** | `algo/vanishing.rs`；先做最小版：四点定透视网格 + 平面贴图 + 贴合后继续绘制 |
| ✅ **已保留** | **透视变形** | **做** | `algo/perspective.rs`；四个角点自由拖拽，复用现有自由变换框的交互与遮罩 |
| ✅ **已保留** | **操控变形** | **做** | `algo/puppet.rs`；三角网格 + 骨钉 + 局部仿射变形，三项里工作量最大，排最后 |

### 6.2 仍待定（以后再说，不影响本周）

| # | 功能 | 为什么极高 | 我的建议 |
| --- | --- | --- | --- |
| 1 | **CMYK / LAB 输出** | 需要 ICC 引擎 + 四通道合成 + 印刷黑版生成 | 只做「导出时转换」（用 lcms-wasm），不做编辑态 CMYK |
| 2 | **智能对象 + 智能滤镜** | 需要嵌套文档树、非破坏滤镜栈、内容替换、堆栈模式 | 先做「智能滤镜」轻量版（可回溯参数的滤镜栈），智能对象押后 |
| 3 | **历史记录画笔** | 需要每笔的像素级快照，内存爆炸 | 不建议做 |
| 4 | **多窗口视图** | Tauri 多窗口 + 文档状态同步，工程量大 | 以后再说 |
| 5 | **PSB（超大文档 >30000px）** | 涉及分块存储、内存映射 | 先只支持 PSD |

> 3D、Adobe 生态联动已在第 7 节写死为「不做」，不再重复讨论。

---

## 7. 明确不做（写死，避免周末反复纠结）

1. 全部 **AI / 机器学习**功能：生成式填充、生成式扩展、文本生成图像、神经滤镜、AI 选择主体/天空/焦点、AI 增强边缘、Remove Tool、内容感知移动/填充/缩放、AI 防抖、AI 智能锐化增强、AI 调色、AI 降噪增强。
2. **3D** 整域（PS 26 起已移除）。
3. **已淘汰格式**：EPS / DCS / PICT / Zoomify / 抽出滤镜 / Digimarc。
4. **Adobe 生态联动**：Lightroom / Premiere / AE / Bridge / InDesign / 云文档 / CC 库。
5. **16/32 位深**（已否决，见第 6 节）、**PSB 大文档**、**多窗口**、**CMYK 编辑态**。

---

## 8. 小试点（先跑通一条闭环，再铺开）

> 你的判断是对的：**先小范围试点**。下面这条闭环一旦跑通，后面所有滤镜、所有通道、所有移植都是同一套模板；跑不通就说明架构要改，绝不要在错的架构上堆量。

### 8.1 试点范围（只做这几件事，别扩散）

| # | 试点项 | 具体内容 | 通过标准 |
| --- | --- | --- | --- |
| 1 | **滤镜框架** | 新建 `src/engine/filters/`，定义 `FilterDef { id, name, params, apply(src, params) }`，配一个通用参数弹窗 | 加一个新滤镜 = 写一个文件 + 一行注册，不改 `EditorShell` |
| 2 | **移植 3 个算法** | 高斯模糊（`algo/blur.rs`）、USM 锐化（`algo/sharpen.rs`）、添加杂色（`algo/noise.rs`） | 效果与 PhotoCraft 肉眼一致，代码走 TS + `ImageData` |
| 3 | **实时预览** | 滑块拖动过程中连续出图，预览不写历史，确定才提交一条历史 | 拖动帧率 ≥ 30fps（1000×1000 图），松手前后画面无跳变 |
| 4 | **通道抽象** | 通道 = 一张灰度 canvas；先只做「选区 → Alpha 通道 → 载回选区」 | 存/载往返后选区像素级一致 |
| 5 | **性能闸门** | 4000×4000 图片跑高斯模糊 | < 400ms 直接跑；否则试点 Worker 离屏方案 |
| 6 | **PSD 库验证**（可选） | 用 `ag-psd` 读一个带图层/蒙版的 PSD，转成 Strata 的 `Layer` | 能读出图层数量、名称、不透明度、混合模式 |

### 8.2 试点纪律

- **只做试点，不顺手加功能**：这 6 项之外的需求一律记进第 3 节清单，试点结束后再排。
- **一个算法一个测试**：`vitest` 里用 4×4 固定像素图比对输出，防止后面重构悄悄改坏。
- **试点期间不改现有面板**：新框架独立目录，跑通后再逐个把旧滤镜接过去。
- **试点不通过就停下来改架构**：尤其是第 3 项（实时预览）和第 5 项（性能），这两条不过，后面做得越多返工越狠。

### 8.3 试点通过后的判断

- 6 项全绿 → 按第 9 节排期，放心铺量。
- 第 3 项不达标 → 先解决预览管线（大概率要引入离屏双缓冲），不加新滤镜。
- 第 5 项不达标 → 先定 Worker 方案，再继续。

---

## 9. 周末执行顺序（建议）

### 周五晚 / 周六一早：先跑试点（第 8 节）

0. **小试点闭环**：滤镜框架 + 3 个算法 + 实时预览 + 选区通道往返 + 性能闸门
   - 通过才继续，不通过就停下来改架构

### 周六上午（先出成果，建立信心）

1. **滤镜第一批**：模糊 / 锐化 / 杂色 / 像素化（约 20 个）
   - 沿用试点定下的 `src/engine/filters/` 框架，按 PS 分组注册
   - `menuCatalog.data.ts` 补全 `filter.*` id，`EditorShell` 统一分发到参数弹窗
   - 实时预览机制直接复用（拖动即算）
2. **小工具补齐**：多边形套索、单行/单列、魔术橡皮擦、铅笔

### 周六下午

3. **滤镜第二、三批**：扭曲 / 风格化 / 素描 / 纹理 / 艺术效果（约 56 个）
4. **通道系统**：Alpha 通道、存/载入选区、通道运算

### 周日上午

5. **PSD 读写**（P1 自研 or P2 `ag-psd` 先跑通）
   - 先做「读」：图层、混合模式、不透明度、蒙版、样式
   - 再做「写」：至少保证往返不丢图层
6. **填充层 + 图案**、**图层样式补齐**

### 周日下午

7. **快速蒙版 + 调整边缘**
8. **文字深度**（字符/段落面板 + 文字变形）
9. 收尾：`npx tsc --noEmit` → `npm test` → `npm run build` 三项通过

> 不做 `npm run dev`（用户明确禁止，太烧机器）。验证一律用 tsc / vitest / build。

### 试点之后的长线（已确认保留，不在本周末）

| 顺序 | 功能 | 前置条件 |
| --- | --- | --- |
| L1 | **透视变形** | 先把自由变换框抽象成可复用的「四角控制」组件 |
| L2 | **消失点** | 依赖 L1 的透视求解；先做四点网格 + 平面贴图 |
| L3 | **操控变形** | 依赖网格变形工具，工作量最大 |
| L4 | **命令总线重构** | 把 `EditorShell` 的 `case` 分支抽成可序列化命令 |
| L5 | **动作录制 + 播放** | 依赖 L4，先做录制/播放，再存 `.atn` |
| L6 | **JS 脚本（JSX）** | 依赖 L4，先做 JS 沙箱，JSX 语法差异后置 |

---

## 10. 验收标准（每个任务包都必须满足）

- [ ] 参数滑块**拖动中实时渲染**，不是松手才渲染
- [ ] 可 `Ctrl+Z` 撤销，且历史只记一条（预览不进历史）
- [ ] 大图（4000×4000）单次滤镜 < 400ms，否则下放 Worker
- [ ] 菜单项从「禁用」变「可用」，快捷键与 PS 一致
- [ ] 中文文案全部走 `src/i18n/zh-CN.ts`，不硬编码
- [ ] `tsc --noEmit`、`vitest run`、`vite build` 三项全绿
- [ ] 移植自 PhotoCraft 的文件头写明来源与许可

---

## 11. 一句话结论

Strata 现在**底子够硬**（合成、混合、调整层、绘制、选区、历史都已成型），
真正缺的是四件事：**滤镜太少、没有 PSD、没有矢量、没有自动化**。
先用**小试点**把「滤镜框架 + 实时预览 + 通道」这条闭环跑通，再打 **滤镜军团 + PSD + 通道 + 快速蒙版**；
**不碰 16/32 位深**，**动作/JSX 与消失点/透视变形/操控变形保留为长线**。这四块做完，观感和「像不像 PS」会立刻上一个台阶。
