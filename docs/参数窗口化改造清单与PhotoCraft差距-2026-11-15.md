# 参数窗口化改造清单 与 新版 PhotoCraft 差距分析

> 2026-11-15 立项调研。用户原话：「Photocraft 他们的很多滤镜啊，图像编辑什么的，我们的就只是个简单的滑块，
> 而他们是新开一个窗口，这样子调整更方便，还能自由拖动。所以你看看我们需要有哪些可以调整为窗口的」
> —— **本文档是「下回重点更改」的执行清单，本轮不改任何代码。**
>
> 参考源码：`D:\20533\deskbox\fangwork\Strata\PhotoCraft\`（本轮克隆的新版 main）
> 对照基线：旧版副本 `D:\20533\deskbox\fangwork\_回收_Strata参考软件_20261031\reference\artcraft-photocraft\`
> 既有结论：`docs/六项差距全修计划-2026-11-04.md`、`docs/PhotoCraft功能对比与六项重修-2026-11-05.md`

---

## 一、一句话结论

**差距不在功能数量，在「参数怎么调」这一层。**

菜单条目、滤镜数量我们不落后（filter.* 79 条、image.adjustments.* 22 条、73 个滤镜定义、32 个调整定义）；
真正的落差是 PhotoCraft 把「凡是有参数的命令」统一变成一个**可拖动、可缩放、不压暗画面、带独立预览、
还能在画布上直接拖控制点**的工作窗口，而我们绝大多数参数操作是**固定居中 + 遮罩压暗 + 一串滑块**的小弹窗。

更要紧的是：我们**已经有可拖动浮窗的地基**（`FloatingDoc.tsx`），只是没接到参数对话框上。
所以这不是「从零造窗口」，而是「把已有能力接过去 + 把少数几个专用大窗口补齐」。

---

## 二、新版 PhotoCraft 到底怎么做（逐条核过源码）

### 2.1 窗口骨架（`crates/ui-egui/src/dialogs.rs`）

| 特性 | 实现 | 源码位置 |
|---|---|---|
| **可拖动** | `egui::Modal::new(id).area(area)`，`area` 记住位置；标题栏拖动区不算在窗口遮挡内 | `dialogs.rs:652`、`titlebar_drag_area_is_clear()` |
| **可缩放** | `resizable_dialog()` 返回 `Option<Vec2>` → `egui::Resize`，默认 960×900、最小 560×400 | `dialogs.rs:192` + `show_modal()` |
| **不压暗画面** | `backdrop_color(egui::Color32::TRANSPARENT)`，注释写得很直白：「Photoshop doesn't dim the window behind dialogs: previews must be judged at true contrast」 | `dialogs.rs:652` + `dialogs.rs:658` 注释 |
| **窗口开着画布仍可用** | `free_pointer_over()` / `pan_delta()` / `free_press()`：空格拖拽、中键、抓手工具照样平移缩放；还能在画布上取样、加钉点 | `dialogs.rs:92` 等头部注释 |
| **弹窗叠放** | `ui.dialogs` 数组 + layer 顺序管理，只有最上面那个吃输入 | `dialogs.rs:100`、`older_dialog_above()` |

### 2.2 关键机制：**有参数就自动开窗**，不是逐个手写

`crates/ui-egui/src/dialogs/filter_dialog.rs:334`：

```rust
pub fn has_dialog(command: &str) -> bool {
    if command == "filter.filterGallery" { return false; }   // 它有自己独立的全窗口
    (command.starts_with("filter.")
        || command.starts_with("select.modify.")
        || PREVIEWED.contains(&command)
        || matches!(command, "image.trim" | "select.refineEdge" | ... ))
        && photocraft_engine::commands::find(command)
             .is_some_and(|c| !parse_spec(c.params).is_empty())
}
```

- 参数 UI 由**引擎命令的参数规格自动生成**（`parse_spec`）：`Range / Choice / Bool / Int / Text / Document / Grid / Json / Color` 九种控件类型，
  命令加个参数就自动多一行控件，不用写 UI。
- 预览跑的是**同一条引擎命令**，在降采样 proxy 文档上算（像素半径按 proxy 比例缩放），所见即所得；
  不是另写一套「近似效果」。
- 还有**窗口内独立预览窗**（#3769），以及「点画布任意位置把预览中心定位过去」（`docs/ui-parity.md` #9648）。

### 2.3 四个专用大窗口（差距最大的部分）

| 窗口 | 规模 | 形态 |
|---|---|---|
| **Filter Gallery** `dialogs/gallery_ui.rs` | 922 行 | 全窗口：左大预览 + 中分类缩略图 + 右**效果层堆栈**（可新建 / 删除 / 重排 / 显隐，自下而上叠加），24MP 图层在 UI 线程外渲染带进度条 |
| **Camera Raw** `dialogs/camera_raw_ui.rs` + `camera_raw_{detail,preview,scope,gpu}_ui.rs` | 312 行 + 4 个分文件 | 左预览 + 右 7 个页签（Light / Color / Effects / Curve / Color Mixer / Color Grading / Detail）+ 直方图；≤900px CPU proxy，**worker 线程算预览，拖控件不等**，部分阶段走 GPU；支持 .xmp 存读设置 |
| **Blur Gallery** `dialogs/blur_pins.rs` | 774 行 | Field / Iris / Spin / Tilt-Shift 直接在**画布上编辑**：点击加钉、拖钉移动、拖选中钉的环调模糊量（转一圈 = 整个范围）、Delete 删钉；Iris 还有四个轮廓手柄 + 圆角方块 + 内部四点的锐利核心 |
| **Adjustments** `dialogs/adjust_dialog.rs` + `adjust_editors.rs` | 696 行 + 编辑器组 | 与 Properties 面板**共用同一套编辑器**；字段是命令完整参数集（自动化 `ui.dialog.set` 可读写）；预览是 GPU 合成的临时调整层；Levels/Curves 带黑/灰/白点吸管 |

其余还有 `liquify_ui` / `puppet_ui` / `wide_angle_ui` / `color_picker_ui`（全对话框 + 实时预览 + 吸管 + hex）/
`layer_style` / `warp_text` / `stack_dialog` / `shape_dialog` / `bitmap_dialog` / `color_range_ui` / `color_table_ui` 等。

### 2.4 它自己承认的短板（别把它当满分范本）

新版 `ROADMAP.md` / `docs/ui-parity.md` 自评：

- 功能广度 **~76%**，但「真正能干活」只有 **~45%**，仍是 alpha，953 个 open issue，25 条性能预算里 22 条没达标；
- **UI/UX 保真度只有 40%**；
- 30/35 个面板、56/68 个工具；
- 「Panel groups float and tear off into OS windows」标 **missing**；
- 自己写的 PSD 还不能可靠被 Photoshop 接受（#1281 / #2469）。

---

## 三、我们现在的样子

### 3.1 骨架是「固定居中模态」

`src/ui/components/Modal.tsx` + `Modal.css`：

```css
.modal-mask { position: fixed; inset: 0; display:flex; align-items:center; justify-content:center;
              background: var(--mask); backdrop-filter: blur(2px); }
.modal      { max-width: calc(100vw - 48px); max-height: calc(100vh - 96px); ... }
```

- **不能拖、不能缩放、不能记位置**；点遮罩关闭、Esc 关闭；
- 遮罩压暗 + 虚化，而且我们早就知道这有问题——`Modal.css:242` 有一段补丁：
  > 「调滤镜/调色参数本质是『看着画面调』，背景一糊一暗就只能盲调」
  → 于是加了 `body.is-tuning` 在**按下滑块的那一刻**临时撤掉虚化。这是补丁，不是解法；PhotoCraft 直接让遮罩透明。

### 3.2 参数类功能现状

| 组件 | 尺寸 | 形态 |
|---|---|---|
| `FilterFxDialog.tsx` | 520 | 73 个滤镜左列表 + 右滑块；`previewFilter()` 缩到 1100px 近似预览，确定才跑全分辨率 |
| `FilterGallery.tsx` | 600 | 名字叫 Gallery，其实只是 `ADJUST_DEFS.filter(family==="effect")` 的 **6 个效果单选 + 滑块**，没有缩略图、没有效果堆栈、没有独立预览 |
| `AdjustDialog.tsx` | 460 | 22 个图像调整 + 18 个「新建调整图层」共用；复用 `AdjustProps`（含 `LevelsEditor` 直方图、`CurveEditor`、`GradientEditor`），实时预览走 ref-only `previewDoc` |
| `ImageOpsDialog.tsx` | 440–560 | 15 种图像运算，纯数字框 / select / checkbox，**没有实时预览** |
| `LiquifyDialog.tsx` | — | 469 行，已有画布预览与笔刷交互 |
| `PuppetWarpDialog.tsx` | — | 424 行，已有画布钉点 |
| `RefineEdgeDialog.tsx` | — | 111 行，偏薄 |
| `EditorShell.tsx` 内联小弹窗 | 400–520 | **23 个** `<Modal>`（新建参考线、描边、重命名、布局、旋转、图像/画布大小、导出、通道计算…），65 处 input |

### 3.3 我们已经有的地基（**别重写**）

- `FloatingDoc.tsx`：`FloatRect{x,y,w,h,zoom}` + pointer 事件 + transform 的**可拖动、可缩放浮窗**，还带位置记忆。目前只用于「窗口 > 排列 > 浮动在窗口中」。
- `GradeWindowOverlay.tsx`：画布上的范围线框 / 手柄 / 抓取区，已有 `readOnly` 只读模式（总览多个线框时只画轮廓、不吃事件）。
- `engine/meshWarp.ts`：MLS 木偶变形；`engine/filters/gallery.ts::iterativeVariableBlur()`：场景 / 光圈 / 移轴模糊共用地基。
- `previewDoc` ref-only 预览链：`markInteracting()` + `scheduleRender()`，拖动不进 React 状态，确定才落一条历史。
- `FilterFxDialog` / `AdjustDialog` 的「base 快照 → 实时预览 → 取消还原 → 确定落库」模型已经是正确范式。

---

## 四、差距到底在哪（分三类，别混为一谈）

### 4.1 真差距 —— 下回该补的

| # | 差距 | PhotoCraft | 我们 |
|---|---|---|---|
| G1 | **窗口可拖 / 可缩 / 记位置** | `Modal.area()` + `Resize` | 固定居中，无 resize |
| G2 | **不压暗画面** | 透明遮罩，为的是「按真实对比度判断预览」 | 压暗 + blur(2px)，靠 `is-tuning` 打补丁 |
| G3 | **窗口开着画布仍可交互** | 平移 / 缩放 / 取样 / 加钉点全都能用 | 模态遮罩把画布全挡了 |
| G4 | **有参数就自动开窗** | `has_dialog()` + `parse_spec()` 由命令规格生成控件 | 每个功能手写 `Modal` / 内联弹窗，23 个散在 EditorShell |
| G5 | **窗口内独立预览 + 点击画布定位预览中心** | #3769 / #9648 | 只能看主画布，且是缩略图近似 |
| G6 | **Filter Gallery 效果堆栈** | 多滤镜叠加 / 重排 / 显隐 / 缩略图分类 | 只有 6 个滑块单选 |
| G7 | **Camera Raw 工作窗口** | 7 页签 + 直方图 + worker 预览 + .xmp | `filter.cameraRaw` 直接弹 460px 的 `AdjustDialog` |
| G8 | **模糊画廊画布钉点** | 4 种模糊直接在图上拖钉 / 转环 | 只有滑块；`iterativeVariableBlur` 地基闲置 |
| G9 | **参数编辑器与属性面板同源** | `adjust_editors` 共用 | 已复用 `AdjustProps`（**这条基本追平**），但吸管取样、命令参数自动化读写还缺 |

### 4.2 架构差异 —— 不是差距，别照抄

- Rust workspace（23 crate）+ egui + wgpu 单进程原生应用 ↔ 我们 Tauri 2 + React 19 + WebView2；
- 它的「命令注册表 + 参数规格」是引擎层契约 ↔ 我们 `FILTER_DEFS` / `ADJUST_DEFS` 在 TS 层；
  → 我们可以借鉴「规格驱动控件」这个思路，但不必搬 Rust 的命令总线。
- 它 85 万行 / 26 crate 是规模差异，不是功能差距（既有文档已确认）。

### 4.3 我们领先 / 不该倒退的

菜单与滤镜条目数、73 个滤镜真值（`filter-truth.test.ts` 零假）、三档动效体系、真半透明玻璃 UI、
7 语言 i18n 契约、WebGPU 拼合、真 ICC 转换、`FloatingDoc` 已有拖动地基、ref-only 预览不进历史。

---

## 五、下回重点改造清单（**按优先级排，含复用地基**）

### P0 · 骨架：一次改造，全站参数窗口一起受益

| 项 | 做法 | 复用 |
|---|---|---|
| 1 | 把 `Modal` 升级为 **`DraggableModal`**：标题栏拖动、右下角 resize、位置/尺寸按窗口 id 记忆 | `FloatingDoc.tsx` 的 pointer/transform 逻辑抽成 `useFloatRect()` hook |
| 2 | 遮罩默认改**透明 / 极淡**，拖参数不再需要 `body.is-tuning` | 删 `Modal.css` 的补丁段 |
| 3 | 参数窗口打开时**画布仍可平移 / 缩放 / 取样**（非模态） | 参考 `dialogs.rs` 的 `free_pointer_over` 分发；注意别破坏 `markInteracting()` |
| 4 | **规格驱动控件**：`FILTER_DEFS` / `ADJUST_DEFS` 的 `params` 就是规格，写一个通用 `ParamWindow` 自动出控件 | `FilterFxDialog` 的 `def.params.map` 抽出来 |
| 5 | 统一「base 快照 → 预览 → 取消还原 → 确定落库」到 hook | `FilterFxDialog` / `AdjustDialog` 已有模型 |

> P0 的收益：23 个内联小弹窗 + 全部滤镜 / 调整一次获得「可拖、可缩、不压暗、画布可用」.
> **风险**：改 Modal 影响面极大（导出、首选项、关于页都用它），必须做成 opt-in：`draggable` 默认 false，只给参数类窗口开；
> 先跑 `tsc --noEmit` + `vitest run` 全绿再动其它。

### P1 · 四个专用大窗口（用户最直观感受到「他们有我们没有」）

| 优先级 | 功能 | 现状 | 目标形态 | 可复用地基 |
|---|---|---|---|---|
| **1** | **滤镜库** `filter.filterGallery` | `FilterGallery.tsx` = 6 个滑块 | 左大预览 + 中分类缩略图 + 右**效果堆栈**（叠加 / 重排 / 显隐），确定一次落库 | `FILTER_DEFS` 73 个定义、`applyFilterToLayer`、缩略图预览 |
| **2** | **Camera Raw** `filter.cameraRaw` | 弹 460px `AdjustDialog` | 左预览 + 右 7 页签（曝光/颜色/效果/曲线/混色/分级/细节）+ 直方图 + 预设存读 | `cameraraw` 已有 `AdjustId`、`LevelsEditor`、`ScopesPanel`、`HistogramPanel` |
| **3** | **模糊画廊 4+1 项** `filter.blurGallery.*` | 滑块 | 画布钉点：点加钉 / 拖钉 / 转环调量 / Delete 删钉；Iris 轮廓手柄、Tilt-Shift 实虚线 | `iterativeVariableBlur()`、`GradeWindowOverlay` 手柄、`meshWarp` |
| **4** | **液化 / 木偶变形** | 已有画布交互，但固定居中 | 大窗口化 + 可拖可缩 + 不压暗 | `LiquifyDialog` 469 行、`PuppetWarpDialog` 424 行，本体几乎不用改 |

补充项（同一批做）：`filter.adaptiveWideAngle`、`filter.lensCorrection`、`filter.vanishingPoint` → 画布透视辅助线 + 参数窗口；
`select.refineEdge`（Select and Mask）→ 独立大窗口 + 边缘预览（现在只有 111 行）。

### P2 · 通用参数窗口化（P0 骨架完成后自动受益，只需排序调尺寸）

**图像 > 调整 22 项 + 新建调整层 18 项**，按「参数多、最需要看画面」优先做大窗口：

- 第一梯队（参数 ≥5 或带曲线/直方图）：`levels`（已有 `LevelsEditor` 直方图可拖）、`curves`、`colorbalance`（9 参数）、
  `channelmixer`、`selectivecolor`、`hdtoning`、`shadowhighlight`、`gradientmap`、`huesat`、`channellevels`、`cameraraw`
- 第二梯队：`exposure`、`vibrance`、`photofilter`、`matchcolor`、`replacecolor`、`colorlookup`、`blackwhite`、`bc`、`bw`
- 单参数 / 无预览的保持小窗口即可：`invert`、`desaturate`、`equalize`、`posterize`、`threshold`

**滤镜 79 项**，多参数的优先做大窗口（高斯 / 镜头 / 动感 / 径向 / 表面模糊、USM / 智能锐化、
减少杂色 / 添加杂色 / 蒙尘划痕、置换 / 波浪 / 旋转扭曲 / 极坐标、光照效果 / 镜头光晕、
色彩半调 / 铜版雕刻 / 油画）；单参数、一键型滤镜（去斑、锐化、查找边缘、风）保持现状态。

**图像运算 15 项**：位图 / 双色调 / 索引颜色 / CMYK / Lab / 颜色表 / 应用图像 / 陷印 → 需要**加实时预览**并窗口化；
纯数据录入（变量 / 数据组 / 测量记录 / 比例标记）保持小弹窗。

**其它内联小弹窗**（图像大小、画布大小、旋转、描边、图层样式、文字变形、参考线布局）→
P0 骨架给个「可拖」就够，不必逐个重做。

### P3 · 明确**不**动的

导出、首选项、关于 / 文件信息、色板 / 颜色面板这类表单：居中模态反而更顺手，不要为了统一而统一。

---

## 六、实施顺序与硬约束

**顺序**：P0（骨架 + 回归） → P1-1 滤镜库 → P1-2 Camera Raw → P1-3 模糊画廊 → P1-4 液化/木偶 → P2 逐个调尺寸。

**铁律（改之前先看 `.workbuddy/memory/MEMORY.md`）**：

1. **任何菜单动作都不要随意改 `activeLayerId`** —— `GradePanel` 只在活动层是 grade 调整层时渲染，抢活动层会让调色台「变脸」。
2. 滤镜菜单靠 `resolve()` 的 `default:` → `filterDef(id)` 兜底自动点亮，加定义不用改 UI；新增 `FilterGroup` 必须同步
   `FilterFxDialog` 的 `GROUP_LABELS` / `GROUP_ORDER`（`Record<FilterGroup>` 穷举约束）。
3. 预览走 `previewDoc` ref-only + `markInteracting()` + `scheduleRender()`，**确定才 `setDocs` 落一条历史**；取消必须还原 base。
4. 新增文案必须覆盖 7 语言 `src/i18n/*`，缺键 tsc 直接报错；i18n 顶层分组有契约测试。
5. **CSS 类名一律加前缀**：本轮刚踩过坑——`CommandPalette.css` 的裸 `.cp` 泄漏到 `ColorPicker`，把取色方块压成一条线。
   新窗口组件用 `.pw-*` 之类独占前缀，别用 `.modal` / `.cp` 这种通用名。
6. 按钮类 `white-space: nowrap`（中文标签在窄 flex 里会被拆成竖排）；`.modal-foot` 已 `flex-wrap`。
7. 移动图层性能三件套别破坏：`markInteracting()`、`composeForDisplay` 的 `prescaled`/`prescaledMask`、`moveCapRef`。
8. 验收：`npx tsc --noEmit` + `npx vitest run`（含 73 个滤镜真值核对）+ `npm run build`；
   改完前端要**直接替换根目录 `Strata.exe`**，不是只给 NSIS 安装包。

**交付口径**：改完直接 `Copy-Item src-tauri/target/release/strata.exe → Strata.exe -Force`（`Strata.lnk` 指向它）。

---

## 七、克隆说明

- 位置：`D:\20533\deskbox\fangwork\Strata\PhotoCraft\`（**根目录**，按用户要求）
- 版本：GitHub `storytold/photocraft` 的 `main` 最新版（本轮 HEAD 附近，含 `crates/ui-egui/src/dialogs/` 重构后的窗口模块）
- 与旧副本（2026-10-17）的差异：对话框从 `ui-egui/src/*.rs` 平铺，重构成了 `ui-egui/src/dialogs/` 子目录；
  Camera Raw 预览改成 worker 线程 + 部分 GPU 阶段；新增 `filter_preview_ui` 的画布定位预览（#9648）。
- `.gitignore` 已有 `/PhotoCraft/`，**该目录不进仓库**（沿用「参考副本不进仓库，运行时依赖才进安装包」口径）。
- 本轮网络对 git / codeload 通道限速与 502，最终走 raw CDN 落地源码快照；不含 `.git` 历史，
  若日后需要完整 git 历史，网络恢复时补一次 `git clone --depth 1` 覆盖即可。
