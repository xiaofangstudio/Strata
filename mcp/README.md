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
node strata-mcp.mjs --selftest   :: 自检：应输出「已注册 10 个工具」
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
  lib/schema.mjs        轻量 schema 校验/补默认值
  lib/png.mjs           PNG 编解码（生成纯色底图等）
  package.json
```

## 自检与冒烟

```bat
node strata-mcp.mjs --selftest
```

自检会比对「能力清单声明的工具」与「实际注册的工具」，两边有一处对不上就退出码 1。
