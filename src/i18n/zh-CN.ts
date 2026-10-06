/**
 * 界面文案（简体中文）。
 *
 * Strata 是中文第一的产品，界面不出现英文硬编码。
 * 这里集中存放全部用户可见文案，便于后续统一校对与替换。
 */
export const zh = {
  app: {
    name: "Strata",
    tagline: "修图 · 绘画",
    studio: "小方工作室",
    version: "版本",
  },

  theme: {
    toLight: "切换到浅色",
    toDark: "切换到深色",
    light: "浅色",
    dark: "深色",
  },

  start: {
    newCanvas: "新建画布",
    presets: "常用尺寸",
    width: "宽度",
    height: "高度",
    unit: "像素",
    background: "背景",
    bgWhite: "白色",
    bgTransparent: "透明",
    create: "创建画布",

    recent: "最近文件",
    recentEmptyTitle: "还没有打开过文件",
    recentEmptyHint: "从下面「导入」打开一张图片，或先新建一个画布。",
    recentClear: "清空记录",
    recentRemove: "从列表移除",

    importTitle: "导入",
    importButton: "打开图片…",
    importHint: "支持 PNG / JPG / WebP / BMP / GIF，也可以直接把文件拖进窗口。",

    others: "其它入口",
    sample: "示例工程",
    sampleHint: "即将提供",
    shortcuts: "快捷键速览",
    about: "关于",

    footerHint: "当前为 M0 骨架版：可打开图片查看并导出 PNG。",
  },

  shortcuts: {
    title: "快捷键速览",
    hint: "下面是 M0 已经生效的部分；完整快捷键表与命令面板（Ctrl + K）随 M1 的正式编辑界面补齐。",
    rows: [
      { keys: "Ctrl + O", desc: "打开图片" },
      { keys: "Ctrl + Shift + S", desc: "导出 PNG" },
      { keys: "Ctrl + W", desc: "关闭当前文档，回到开始页面" },
      { keys: "Ctrl + 0", desc: "画布适应窗口" },
      { keys: "Ctrl + 1", desc: "画布 100% 显示" },
      { keys: "Esc", desc: "关闭浮层" },
    ],
    close: "知道了",
  },

  about: {
    title: "关于 Strata",
    intro:
      "Strata 是「小方工作室」自研的 Windows 优先、全中文、永久免费开源（MIT）的 Photoshop 平替，修图与绘画并列为一级能力。",
    facts: [
      { k: "产品", v: "Strata" },
      { k: "版本", v: "" },
      { k: "运行环境", v: "" },
      { k: "协议", v: "MIT · 永久免费 · 不盈利" },
      { k: "仓库", v: "github.com/xiaofangstudio/Strata" },
    ],
    noAi: "本产品不含任何 AI / 机器学习功能，这是定位的一部分，不是暂缺。",
    close: "知道了",
  },

  editor: {
    backToStart: "回到开始页面",
    closeDoc: "关闭文档",
    open: "打开图片",
    exportPng: "导出 PNG",
    fit: "适应窗口",
    zoom100: "100%",
    unsavedHint: "M0 为只读查看模式，编辑能力随 M1 提供。",
    exported: "导出成功",
  },

  dialog: {
    openTitle: "打开图片",
    saveTitle: "导出 PNG",
    close: "关闭",
  },

  error: {
    openFailed: "打开失败",
    exportFailed: "导出失败",
  },
} as const;

export type Dict = typeof zh;
