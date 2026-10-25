# strata-mcp

Strata 图像编辑器的 MCP 服务器。让外部 AI（Claude Desktop、Cursor、任意 MCP 客户端）
在不打开界面的前提下读写 `.strata` 工程文件。

- 传输：stdio（零网络端口）
- 协议：MCP `2024-11-05`
- 依赖：`@modelcontextprotocol/sdk`、`zod`
- 入口：`strata-mcp.mjs`

## 快速开始

```bat
cd mcp
npm install
node strata-mcp.mjs --selftest   :: 自检：应输出「已注册 35 个工具」
node strata-mcp.mjs              :: 正常服务，等待 stdio 输入
```

### 接到 Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "strata": {
      "command": "node",
      "args": ["D:/20533/Desktop/Strata/mcp/strata-mcp.mjs"],
      "env": { "STRATA_MCP_ROOT": "D:/20533/Desktop/Strata/projects" }
    }
  }
}
```

`STRATA_MCP_ROOT` 是**可选**的写盘沙箱：设了它，所有路径必须落在该目录内，
否则报「path 越权」。不设则只要求路径是绝对的、且以 `.strata` 结尾。

## 提供的工具

| 工具 | 作用 | 写盘 |
| --- | --- | --- |
| `strata_capabilities` | 返回完整能力字典（画布限制与预设、混合模式、调整类型及参数范围与默认值、图层样式、图层类型、选区模式与运算、工具清单、导入导出格式、工程格式、工具名列表） | 否 |
| `strata_read_project` | 读取工程并返回结构化摘要（可选回传像素 base64） | 否 |
| `strata_write_project` | 由 manifest 规范化后写成 `.strata`，支持 `dryRun` | 是 |
| `strata_patch_layer` | 改图层名 / 可见性 / 不透明度 / 混合模式 / 剪贴 / 锁定 / 蒙版开关 | 是 |
| `strata_add_layer` | 新增像素层或调整层 | 是 |
| `strata_remove_layer` | 删除图层（至少保留一层） | 是 |
| `strata_move_layer` | 图层顺序 up / down / top / bottom | 是 |
| `strata_duplicate_layer` | 复制图层，副本置于原层上方 | 是 |
| `strata_validate` | 校验工程，逐条返回 error / warning 与中文原因 | 否 |
| `strata_build_recipe` | 由「配方」直接生成工程 JSON，不碰磁盘 | 否 |

### 图像管线（Mark 3：能真的修图）

| 工具 | 作用 |
| --- | --- |
| `strata_open_image` | 打开 PNG / JPEG 进内存会话（`maxSide` 可先缩） |
| `strata_image_info` / `strata_image_preview` | 查会话信息 / 取 base64 预览 |
| `strata_adjust_image` | 按算子序列调色（15 种：亮度对比度、饱和度、自然饱和度、色阶、曲线、通道混合器、黑白、曝光、白平衡、色相、色彩平衡、反相、去色、色调分离、阈值） |
| `strata_filter_image` | 施加滤镜（高斯/方框/USM/杂色/马赛克/中间值/动感模糊） |
| `strata_cutout` | 抠图：`mode=subject` 拆主体、`mode=background` 留背景并填补洞。参数 `tolerance` / `edgeGate`（边缘闸门）/ `feather` / `sides`（种子边） |
| `strata_composite` | 把叠层贴到底图上（`overlayWidth` 等比缩放、`x/y` 落点、`opacity`） |
| `strata_light` | 打光：`glow` 径向光斑 / `beam` 自然光束 / `shadow` 接触阴影 / `vignette` 暗角 |
| `strata_edit_image` | 一步到位：打开 → 调色 → 滤镜 → 导出 |
| `strata_export_image` | 导出为 PNG / JPEG |

### 图层文档（Mark 4：插画排版）

| 工具 | 作用 |
| --- | --- |
| `strata_doc_new` | 新建分层文档（可铺背景色） |
| `strata_doc_add_image` | 加图片层（来源可指定 `crop` 把局部拆成独立层） |
| `strata_doc_add_text` | 加文字层（中文可用，支持字重/字距/行高/描边/阴影） |
| `strata_doc_add_shape` | 加形状层：矩形（圆角/虚线框）、椭圆、渐变；`blur` 做柔光/软阴影 |
| `strata_doc_adjust_layer` | 给**单层**调色，可用 `region`（矩形/椭圆+羽化）做**分区调色** |
| `strata_doc_drop_shadow` | 按图层轮廓生成投影（multiply），塑造阴影感 |
| `strata_doc_preview` / `strata_doc_export` | 压平预览 / 导出 PNG·JPEG |

图层自上而下即叠放顺序，`flatten` 时逐层合成，支持 normal / multiply / screen /
overlay / softLight / darken / lighten / add。文字与形状由 `@napi-rs/canvas` 调系统字体渲染
（思源黑 / 微软雅黑 / 黑体），画完读回像素再进图层栈 —— 所以「插画 + 排版」能一条链路做完。

### 相册与质感（Mark 5：悬挂相册 / 关节 / 胶封 / 玻璃膜）

| 工具 | 作用 |
| --- | --- |
| `strata_doc_add_path` | 加**手绘矢量路径层**（挂钩、链子等）：`commands` 支持 `M/L/C/Q/A/Z` 指令（SVG 心智模型），自动按包围盒裁图并返回 `originX/originY`，配合下方变换即可把路径坐标当文档坐标用 |
| `strata_doc_transform_layer` | 图层**关节变换**：以 `pivot`（默认图层中心）为轴做 `scale` + `rotate`，可做放大缩小关节、挂歪的猫 |
| `strata_doc_add_contour` | 给某图层自动描**贴边虚线框**：取该层 alpha 轮廓（marching squares 最大外环）→ 沿弧长画虚线 → 与图层对齐叠放，虚线紧贴主体边缘而非独立方框 |
| `strata_doc_layer_effect` | 单层质感：**胶封（gloss）** 边缘暗环 + 定向高光 + 对比微调，**投影** 已另有 `strata_doc_drop_shadow` |
| `strata_doc_add_glow` | 加**独立光晕层**（径向渐变、透明底），可 screen/overlay/add 任意混合，用于「每只猫背后打光 / 整体打光」 |
| `strata_doc_add_glass` | 加**明玻璃膜层**（冷色薄底 + 斜向反光带 + 四周厚度高光），盖在最上面浮一层玻璃质感 |
| `strata_doc_save` | 把分层文档存成可编辑的 **`.strata` 工程**（每层独立像素层，保留不透明度与混合模式），可用 Strata 打开续编 |

底层新图元（均在 `lib/imageOps.mjs` / `lib/draw.mjs`，已配 `test/primitives.test.mjs`）：
轮廓 `marchingSquaresContours` / `outerContour` / `polylineArea`、虚线 `strokeRingDashed`、
旋转 `rotateImage`、胶封 `glossLayer`、矢量路径 `renderPath`、光晕 `renderRadialGlow`、玻璃 `renderGlass`。
`scripts/mcp-album-demo.mjs` 用这套工具端到端拼出「悬挂的猫」相册（1080×1350，约 39 层）。

抠图不用 AI，走「边界洪水填充（多种子、Sobel 边缘闸门）+ 最大连通域 + 羽化」；
背景与主体颜色接近时优先调 `edgeGate` 与 `sides`，仍不干净就换一张对比更强的图 —— 
纯色/虚化背景效果最好，这一步的上限由素材决定。

**建议的调用顺序**：先 `strata_capabilities` 取一次清单，再按里面的 id 去调其它工具，
不要凭记忆编造混合模式或调整类型的 id。

## 设计约定

1. **单一事实来源**。所有业务常量（混合模式、调整类型与参数范围、图层样式、
   画布预设、工具清单、导入导出格式）都定义在 `lib/capabilities.mjs`，
   而它逐字对齐 `src/core/layer.ts`、`src/tools/catalog.ts`、`src/i18n/zh-CN.ts`、
   `src/core/presets.ts`、`src/engine/image.ts`、`src/engine/project.ts`。
   **改了源码里的这些文件，必须同步 `lib/capabilities.mjs`。**
2. **零业务逻辑**。校验、规范化、增删改层全部调用 `lib/project.mjs`，
   与界面落盘走同一套代码，不会出现「MCP 写出来的工程界面打不开」。
3. **宁可拒绝，不写坏文件**。任何一处不合法就整体拒绝、不落盘，并逐条给出中文原因；
   越界数值夹到边界但会在 `warnings` 里说明。
4. **stdout 只跑协议**，日志一律走 stderr。

## 文件结构

```
mcp/
  strata-mcp.mjs        服务器入口（工具注册 + 参数校验）
  lib/capabilities.mjs  能力字典（业务常量单一事实来源）
  lib/project.mjs       .strata 读写、校验、图层操作
  lib/imageOps.mjs      图像管线（解码 / 调色算子 / 滤镜 / 抠图 / 合成 / 打光 / 轮廓 / 虚线 / 旋转 / 胶封）
  lib/draw.mjs          矢量路径、光晕、玻璃膜等渲染（@napi-rs/canvas）
  lib/schema.mjs        轻量 schema 校验/补默认值
  lib/png.mjs           PNG 编解码（生成纯色底图等）
  package.json
```

## 自检与冒烟

```bat
node strata-mcp.mjs --selftest        :: 比对「能力清单声明的工具」与「实际注册的工具」，对不上则退出码 1
npm test                             :: 运行 lib/ 下新增图元单元测试（test/primitives.test.mjs）
```

自检会比对「能力清单声明的工具」与「实际注册的工具」，两边有一处对不上就退出码 1。
