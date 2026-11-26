# PhotoCraft 新版差值对比（2026-11-26）

> 用户要求：重新克隆最新 PhotoCraft，替换旧参考副本，先比一比它多了什么，再把值得搬的搬过来。
> 旧参考：`PhotoCraft/`（2026-11-15 快照，`crates/algo/src` 只有 64 个顶层文件、缺 24 顶层 + 74 子模块声明）。
> 新参考：`storytold/photocraft`，HEAD `f0205ae`（2026-11-25），已拉完整历史（至 2026-11-26 的 merge）。
> 新快照已替换旧 `PhotoCraft/`；上游 LICENSE 为 MIT / Apache-2.0，移植处保留来源注释。

## 1. 先说结论

- **大部分「新文件」不是上游新功能，而是旧快照漏掉的模块**：`art_history.rs` / `faces.rs` /
  `lens_flare.rs` / `magnetic.rs` / `redeye.rs` / `relight.rs` / `remove.rs` / `nonlocal.rs` /
  `vectorscope.rs` 等的首次提交都在 2026-10-07～10-23，只是 11-15 那次克隆不完整。
  其中 `remove`（移除工具）、`redeye`、`art_history`、`lens_flare` 对应的工具在旧 README 里就已列出，
  Strata 旧审计里已判过「观感等价 / 不整体搬」，这次不重复搬。
- **真正新增（11-15 之后）的高价值项**：调整画笔（第 70 个工具）、旋转画布对话框（插值可选）、
  Calculations 结果通道灰度预览、星形工具点数 3–20、钢笔形状模式 Fill/Stroke/W/H/Align Edges、
  Add Anchor Point 拖出手柄、Layer Comps to Files、Content-Aware Fill 自定义取样笔刷、
  Move 工具方向拖拽距离、RAW Develop 锐利预览 / 记住窗口。
- **架构项不搬**：`engine-core` / `engine-paint` / `engine-vector` / `ipp` 是 Rust 端 crate 拆分，
  Strata 是 Tauri + TypeScript，没有对应关系；自绘窗（own-window dialogs）我们已经有 `DraggableModal`。
- **色彩管线项不搬**：CMYK 原生保留、Camera Raw `MonotoneCurve` 等与 Strata 自有 RAW/CMS 同源，
  按既有口径不替换。

## 2. 逐项对比表

| 新版能力 | 上游证据 | Strata 现状 | 处理 |
|---|---|---|---|
| Adjustment Brush 调整画笔 | `crates/ui-egui/src/tools/adjustment_brush.rs`；README 工具数 69→70；#12519/#12520/#16051 | 无；但有调整层 + 蒙版编辑入口 | **本次移植**：新工具、画进调整层蒙版、Add/Subtract、Overlay 着色、无调整层时新建 |
| Rotate Canvas 任意角度 + 插值 | `engine-core/src/cmd/mode_cmds.rs:833`，`angle -359.99..359.99`，`bicubic/bilinear/nearest` | 有 90/180 旋转和 `rotateDocumentArbitrary()`，但没有角度窗与插值选择 | **本次补**：对话框 + 三档插值 + 预览 |
| Star points 3–20 | `star_points_field_tests.rs`、2026-11-25 `fcd6eed99` | 形状只有 rect/ellipse/line/leaf，无星形 | **本次移植**：星形工具 + 点数 3–20 纯函数与测试 |
| Move tool 方向拖拽距离 | 2026-11-25 `9a9c391d6` | 移动图层无方向/距离提示 | **本次补**：浮层即时显示 dx/dy |
| Calculations 结果通道灰度预览 | `feat(dialogs): Calculations dialog previews its result channel in grey`、`calculations_ui.rs` | `image.calculations` 只支持两个 Alpha 通道 | 后续项：扩到任意通道运算 |
| Pen 形状模式 Fill/Stroke/W/H/Align Edges | `feat(pen)`、`shape_options.rs` | 无钢笔形状模式 | 后续项：工作量大，另立批次 |
| Add Anchor Point 拖出手柄 | `12707/12708/12732` 系列提交 | 无锚点编辑 | 后续项 |
| Layer Comps to Files | `13940` 系列提交 | 有图层复合面板，没有批量导出 | 后续项 |
| Content-Aware Fill 自定义取样笔刷 / 内容感知裁剪 | `12118`、`14253`、`15338` | 基础 inpaint + `inpaintComplete`，无取样笔刷 UI | 后续项 |
| Notes 面板空态 / 新建文档预设 Recent | `11793`、`14038`、`14043` | 注释面板与新建文档有基础实现 | 后续项 |
| Droplet Destination | `#13711` | 无 Droplet 机制 | 不适用 |
| Engine crate 拆分 / 自绘窗 / CMYK / RAW | 多提交 | 架构与色彩管线不同源 | 不搬 |

## 3. 本次移植范围

P6 调整画笔、P7 旋转画布对话框与插值、P8 星形工具、P9 移动方向距离提示。
每项仍按硬口径：纯函数 + 单测 + 六语言 + 真接线，不做假按钮，不改 `activeLayerId`，
完成后跑 tsc / 全量 vitest / 滤镜真值 / Tauri 构建并覆盖根目录 `Strata.exe`。

## 4. 已落地（同日）

- **P6 调整画笔**：新工具 `adjustmentBrush`（快捷键 A，修饰组）。`src/core/adjustmentBrush.ts`
  提供 14 种调整映射、非中性起始参数、目标层判定、建层与蒙版 alpha 合成；EditorShell 用真实
  `Stroke` 画蒙版，Add / Subtract、Overlay 染色、选区转初始蒙版、连续笔画落在同一层，
  索引颜色明确拒绝。**不抢 activeLayerId**。
- **P7 旋转画布**：`rotateDocumentArbitrary()` 增加 bicubic / bilinear / nearest 三档重采样；
  新增 `RotateCanvasDialog`（可拖可缩、尾随节流预览 + 直方图 + 按住对比 + 对话框撤销栈），
  替换原先那个只有数字框的假专业窗口。
- **P8 星形工具**：`src/core/starShape.ts` 提供点数 3–20（默认 5，独立设置，超界夹取）、
  内外半径比例与顶点生成；`shapeStar` 接入形状工具、选项条与六语言。
- **P9 移动读数**：`src/core/moveReadout.ts` 复刻上游的箭头 + 绝对距离读数，
  拖动图层时在浮层即时显示，不进像素 / 历史。

新增单测 4 组（调整画笔 8、旋转 4、星形 4、移动读数 2），六语言字典同步。
后续对比项（Calculations 任意通道、钢笔形状模式、锚点手柄、图层复合批量导出、
内容识别填充自定义取样等）保留为下一批，不在这里硬凑。
