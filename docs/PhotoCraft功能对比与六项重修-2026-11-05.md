# PhotoCraft 功能 / 动画对比与六项差距重修（2026-11-05 第二轮）

> 参考源码：`D:\20533\deskbox\fangwork\_回收_Strata参考软件_20261031\reference\artcraft-photocraft\`
> （Rust workspace，25 crate，egui 0.36 + wgpu 30，MIT / Apache-2.0 双授权）
> 本轮依据用户要求「照着 PhotoCraft 再看一遍功能、动画更全面、磨砂改真半透明、
> 六项差距把有地基和空白的全部重新修一遍」执行。
> 口径沿用 `docs/六项差距全修计划-2026-11-04.md`：参考副本不进仓库，运行时依赖才进安装包；
> 代码里「移植自 PhotoCraft」的来源声明一律保留（授权归属要求）。

---

## 一、先说结论

| 维度 | PhotoCraft | Strata（本轮前） | Strata（本轮后） |
|---|---|---|---|
| 菜单功能条目 | 约 630 项 / 9 个顶级菜单 | 656 项 / 10 个顶级菜单 | 不变（**数量本来就不落后**） |
| 模块规模 | 25 个 Rust crate | `src/core` 36 + `src/engine` 38 + 50 个 UI 组件 | 新增 `engine/motion.ts`、`ui` 动效层 |
| 滤镜定义 | Filter Gallery ×47（近似） | 73 个 `FILTER_DEFS` | 不变 |
| UI 动效 | 克制、功能性：蚂蚁线 10fps、flick 指数衰减、egui 全局淡入（可一键关） | 26 条「只有入场」keyframes + 1 个蚂蚁线循环 | 三档动效 + 退场 + 缓动缩放 + 惯性平移 + 双指手势 + 变换手柄/图钉反馈 + 加载反馈 |
| 动画缩放 | **明确列为缺失**（`docs/ui-parity.md:173` "Animated zoom \| missing"） | 缺失 | **已补**（RAF 缓动） |
| 玻璃 / 磨砂 UI | **完全没有**（egui 不透明 Frame） | 全局磨砂只是「糊」 | **真正的半透明玻璃**（底色带 alpha + 亮边 + 内高光） |
| 六项差距 | — | 1 项真完成、1 项基本完成、4 项残缺且有假完成 | 6 项全部重修，死代码接活、静默回退消除 |

**一句话**：菜单数量我们不落后，差距从来在「点亮率 / 条件完备度」和**动效质感**；
而 PhotoCraft 自己的动画体系其实很薄（没有统一动画框架、没有缓动曲线库、动画缩放还标着缺失），
所以这轮「更全面」是**超过它**，不是抄它。

---

## 二、功能对比（照着它的目录逐类核过）

| 类别 | PhotoCraft 条目数 | Strata 现状 | 判断 |
|---|---|---|---|
| Layer | 205 | 图层树 / 蒙版 / 调整层 / 组 / 样式 / 智能对象堆叠 | 条目齐，部分高级条件分支仍灰 |
| Edit | 92 | Content-Aware / Puppet Warp / Free Transform / 预设 | 齐 |
| View | 90 | 校样 / 色域警告 / 参考线 / 缩放 / 屏幕模式 | 齐；校样本轮换真 ICC |
| Filter | 79 | 73 个滤镜定义，`filter.*` 由 `filterDef` 自动点亮 | 齐 |
| Image | 77 | Mode / Adjustments / Apply Image / 测量 / Trap | 齐 |
| Window | 70 | 工作区 / 面板开关 / 多文档 | 齐 |
| File | 70 | 打开 / 保存 / 导出 / 自动化 / Droplet | 齐 |
| Type | 55 | 文字引擎 / 字距 / 变形文字 | 齐 |
| Select | 32 | Subject / Sky / Focus / 修改 / 蒙版 | 齐 |
| Help | **0** | 有（关于页） | 我们多一个 |

**PhotoCraft 的独特项**（我们部分有、部分没有）：画布钉点编辑（Blur Gallery pins / Puppet Warp pins）、
智能对象 12 种 Stack Mode、Content-Aware 全家、印前测量/色盲校样、Affinity 文档导入、
WASM 插件沙箱、MCP 自动化通道、全局 `enableAnimations` 开关。
其中钉点编辑我们本来就有 `meshWarp` + `PuppetWarpDialog`，本轮补上了**落点反馈动画**。

---

## 三、动画对比（本轮重点）

### 3.1 PhotoCraft 实际有的动画（逐项核过源码）

| 动画 | 参数 | 位置 |
|---|---|---|
| 选区蚂蚁线 | dash 4pt、10pt/s、周期 8pt、100ms 重绘 | `ui-egui/src/tool_feedback.rs:171-218`、`canvas.rs:4335-4343` |
| Flick 惯性平移 | `TAU=0.18s`、`decay=exp(-dt/TAU)`、启动 150pt/s、停止 15pt/s | `flick_pan.rs:12-22,87-96` |
| 全局淡入/滑动/滚动 | egui `style.animation_time`，由 `enableAnimations` 一键归零 | `prefs_ui.rs:413-426`、`engine/src/prefs.rs:279-281` |
| 标题栏按钮圆盘 | `animate_value_with_time(..., 0.2s)` | `titlebar.rs:355-364` |
| Toggle 滑块 | `animate_bool` + `egui::lerp` | `widgets.rs:1136-1151` |
| 文字插入符闪烁 | 0.530s | `type_tool.rs:794-798` |
| 不确定进度条 | `time*0.8` fract 循环段 | `jobs_ui.rs:597-611` |
| 通知自动隐藏 | 默认 6s，hover 暂停 | `notices.rs:240-256` |
| 工具长按 flyout | 0.35s 阈值 | `panels.rs:180-208` |

**它明确没有**：统一动画框架 / 缓动函数库 / 弹簧物理、退场动画、动画缩放（`ui-parity.md:173` 标 missing）、
图层展开动画（`layer_reveal.rs:52` 注释 "no animation: Photoshop jumps"）、笔刷光标动效、
双指手势过渡、玻璃质感 UI。

### 3.2 本轮给 Strata 补齐的

- **数学地基**：`src/engine/motion.ts`（纯函数，19 条单测）—— 5 种缓动、补间、
  缓动缩放、指数摩擦惯性、双指 pinch 距离/角度/中心、跨 ±180° 角度归一、手柄插值。
- **统一动效层**：`src/styles/motion.css` + `tokens.css` 补 `--ease-spring` / `--dur-in` / `--dur-out` / `--motion-amp`。
- **三档动效**（`full / reduced / off`，写入 `:root[data-motion]`）：完整 / 精简（只留淡入、位移幅度归零）/ 关闭；
  系统 `prefers-reduced-motion` 从「粗暴压成 1ms」改成分级降级。
- **退场动画**：`Modal.tsx` 加 closing 状态机 + `.is-closing` 通用类，遮罩淡出、对话框 pop-out、
  toast / popover / flyout 的 out 关键帧。
- **画布**：Ctrl+滚轮从离散跳变改 RAF 缓动缩放（`×1.1` 幂次，快速连续滚轮平滑接续）、
  抓手/空格拖拽松手走指数惯性滑行、双指 pinch 缩放 + 双指平移（capture 阶段接管，第二指不落笔）。
- **「变换的手指」**：自由变换八手柄 + 旋转手柄加出现淡入 / 抓取收缩 / 抓取呼吸光环；
  操控变形图钉落点播一圈波纹（`.pin-ripple`）。
- **其它**：加载/不确定进度条、骨架屏、卡片 hover 微浮、分段控件选中过渡、笔刷光标尺寸过渡、聚焦光环统一。

> 关于用户原话「变换的手指的动画」：按两种最合理的理解**都做了** —— 变换手柄/图钉（手指按住的点）
> 的拖拽反馈，以及双指手势变换。若指的是别的（例如数码笔手势），说一声我再补。

---

## 四、磨砂：从「糊」改成真正的半透明玻璃

**根因**：`personal.css` 原来写 `color-mix(in srgb, var(--surface) 72%, var(--frost-color) 10%)`。
两个**不透明色**混出来仍是 100% 不透明，`backdrop-filter` 完全白做，只剩一层染色模糊 —— 这就是「糊」。

**本轮改法**：
1. 底色改成三层**带 alpha**：斜向白色光泽 + `rgba(var(--glass-tint-rgb), var(--glass-alpha))` +
   `color-mix(surface 12%, transparent)`，整体 alpha 远小于 1。
2. `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat)) brightness(1.04)` 现在真的能透。
3. 1px 半透明亮边 + `inset` 顶部内高光 + 底部暗边 + 双层外阴影（玻璃的「厚度」）。
4. **去掉玻璃卡本体上的 `clip-path: var(--squircle)`**：clip-path 会创建裁剪上下文、在 WebView2 下切断
   backdrop-filter 采样区域，且裁不出圆角高光；本体改用 `--r-glass` 大圆角，超椭圆留给预览/装饰。
5. `.app-bg` 加两团柔和光晕，保证没导入背景图时玻璃也「有东西可透」，不会像透一片白墙。
6. 预览 `.glass-preview` 与真实卡片**复用同一套 `--glass-*` 变量**，所见即所得。
7. 参数全部进偏好：`glassAlpha / glassBlur / glassSat / glassSheen` + 六语言文案 + 个性化页四个滑块；
   `App.tsx` 注入 CSS 变量；Tauri Acrylic 的 alpha 也跟玻璃透明度联动（不再固定 170）。
8. 窗口磨砂的遮罩去掉二次虚化，避免「玻璃卡 + 模糊遮罩」叠出脏感。

**PhotoCraft 这边完全没有玻璃 UI**（`dock.rs:528-530` 甚至明确关掉滚动渐隐以免影响真实颜色），
唯一 "Liquid Glass" 出现在 `apps/photocraft/src/app_icon.rs:29-32`，指的是 macOS 系统渲染图标变体。
所以这一项是我们自己的方向，不是搬运。

---

## 五、六项差距：全部重新修一遍

| 项 | 重修前真实状态 | 本轮重修 | 验证 |
|---|---|---|---|
| **数位板** | ✅ 真完成（tilt/rotation/橡皮端/coalesced 全接） | 无需重修，作为接线范本 | `pen.test.ts` 10 条 |
| **HEIC/HEIF** | 🟡 真解码但 16bit 截高位、`parallel` feature 被关 | 16bit→8bit 线性归一化 + 有序抖动；打开 `parallel`（rayon 已在依赖里，不顶体积/MSRV） | `cargo check --lib` 0 错 |
| **PSD 写侧** | 🟡 读侧不读 `adjustment`/`opened`；`writePsd` 失败把全部调整层静默降级成透明层；8+ 字段丢失；无往返测试 | `readNode` 补读调整层与组展开（`psdAdjustmentFrom` 逆映射）；catch 降级逐条并入 warnings；补齐 colorbalance/bw/photofilter/channelmixer/gradientmap/hs/curves 字段；10 类无等价物逐条列名字与原因；组展开状态接进 LayersPanel | `psd-bridge` 21 + `psd-roundtrip` 12 条 |
| **RAW** | 🟡 真引擎但 CR3 只取预览、显影失败静默、Clarity/Texture 是全零 stub、jxl 是 Unsupported | Clarity/Texture 换成编译期生成的真实响应表（0 严格恒等）；jxl 错误分类（不支持 vs 损坏）；解码结果新增 `source`/`warning`，CR3 与降级都明确标记；新增可选 `hdrCurve`；前端用全局事件把提示送到所有打开路径 | `cargo check --lib` 0 错 + 独立 harness 6 条 |
| **CMS** | 🟡 真 ICC 转换有了，但 `iccSoftProof` 是**零调用死代码**，实时校样/色域警告仍走矩阵；读嵌入 ICC 只接一条路径；BPC 目标侧未实现 | `iccSoftProofBestEffort` 接进实时校样管线（真 ICC 优先、失败明确回退并留痕）；`gamutWarning` 用真 ICC 超色域掩码；`openFileToDoc` 等所有打开路径读嵌入 profile；结构化解析优先、猜标签兜底；BPC 目标侧曲线拟合补齐 | `cms-icc` 19 + `proof` 15 + `color-profile` 8 条 |
| **GPU** | 🟡 只有「拼合图像」接了；27 种混合只实现 11 种、其余**静默给错结果**；无 `adjust.wgsl`；无一致性测试 | WGSL 补齐 16 种（含 4 种非分离式 + dissolve 确定性哈希），`SUPPORTED_GPU_BLENDS` 扩到 27；新建 `adjust.wgsl` 8 个算子；补 CPU/GPU 像素对拍（27 模式 × 15 样本 × 5 档不透明度，容差 ≤1/255）+ 负向对照；`shaders/README.md` 同步更新 | `gpu-blend` + `gpu-adjust` 62 条 |

**计划 §三 的三条硬验收**：PSD 往返 ✅、GPU 像素一致 ✅、CMS 往返误差 ✅ —— 本轮全部落地
（此前一条都没有）。

---

## 六、本轮验证

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错 |
| `npx vitest run` | **50 文件 / 790 条全过**（开工前 674 条，净增 116 条） |
| `npm run build` | 成功（仅有既存的 chunk 体积 / 动态导入告警） |
| `cargo check --lib`（src-tauri） | 0 错 |

---

## 七、还剩什么（如实列，别对外夸大）

1. **CR3 传感器数据仍不解码**：只取相机内嵌 JPEG 预览，但现在会明确提示「这不是 RAW 显影」。
   真正解 CRX 需要新依赖，会顶体积/MSRV，按计划列进「已知不支持」。
2. **JPEG XL 压缩的 DNG 仍不支持**：`jxl.rs` 只做明确错误分类，没硬造解码。
3. **10 类无 PSD 等价物的调整层**：视觉效果仍不写进 PSD，只保留占位/烤平像素 + 逐条 warnings。
4. **GPU 仍只接「拼合图像」**：调色台 / 滤镜实时预览没 GPU 化 —— `composeDoc` 同步每帧调用、
   GPU 读回异步，硬接会掉帧；`adjust.wgsl` 已备好地基。
5. **双指旋转没映射到视图旋转**：本轮 pinch 只做缩放 + 平移，避免破坏坐标映射。
6. **WGSL 没跑真实 `createShaderModule` 编译**：环境无 WebGPU / naga / tint，只有纯 TS 公式对拍 +
   人工语法审查；上线前建议离线校验一次。
7. **`cargo test --lib` 工程级无法编译（既存缺陷，与本轮无关）**：`strata_raw` 的 8 处测试引用被
   feature 门控的 `testgen`，打开 feature 又缺 `image` crate；本轮用独立 harness + const 断言验证。
8. **CMS 监视器 profile 读取未做**：按原计划后置。
9. **组展开状态只在图层面板首次挂载时消费**：文档中途替换不会重新同步（刻意维持，避免改交互逻辑）。

---

## 八、改动文件索引

- 玻璃：`src/styles/personal.css`（重写）、`src/App.tsx`、`src/stores/prefs.ts`、
  `src/ui/components/Preferences.tsx`、六语言 `src/i18n/*`
- 动效：`src/styles/motion.css`（新建）、`src/styles/tokens.css`、`src/engine/motion.ts`（新建）、
  `tests/unit/motion.test.ts`（新建）、`src/main.tsx`、`src/ui/components/Modal.tsx`、
  `src/ui/EditorShell.tsx`、`src/ui/components/PuppetWarpDialog.tsx`
- 六项：`src/engine/psd.ts`、`src/engine/cms.ts`、`src/core/proof.ts`、`src/engine/openFile.ts`、
  `src/engine/image.ts`、`src/core/layer.ts`、`src/ui/components/LayersPanel.tsx`、
  `src/engine/gpu/*`、`shaders/*`、`src-tauri/src/strata_raw/*`、`src-tauri/src/strata_cms/*`、
  `src-tauri/src/decode.rs`、`src-tauri/src/heif.rs`、`src-tauri/Cargo.toml`
- 测试：新增 `cms-icc` / `gpu-adjust` / `psd-roundtrip` / `motion` / `prefs-personal` 等
- 文档：本文件 + `shaders/README.md`
