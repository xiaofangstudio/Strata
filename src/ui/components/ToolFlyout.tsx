/**
 * 工具二级面板的内容（工具轨负责摆放与开关，这里负责里面放什么）。
 *
 * 与顶栏选项条用的是同一套共享控件（`./controls`），所以面板里**没有任何
 * 只读装饰件**：每一个色块都能点开改颜色，每一根滑杆都能拖。
 *
 * 内容按工具分四类：
 *  · 画笔 / 橡皮 —— 笔尖预览 + 预设 + 颜色 + 大小 / 硬度 / 不透明度；
 *  · 填色 / 渐变 / 形状 / 文字 —— 前景 / 背景两个可编辑色块 + 交换 + 默认黑白；
 *  · 移动 / 抓手 / 缩放 —— 视图命令（适应窗口 / 实际像素）；
 *  · 其余 —— 明确写出参数在哪，不留空白面板。
 */
import { zh } from "../../i18n/zh-CN";
import { isShapeTool, isTextTool, usesBrush, type ToolId } from "../../tools/catalog";
import type { BrushSettings } from "../../engine/paint";
import { BrushLibrary, BrushPresetGroup, BrushTipPreview, ColorField, Slider } from "./controls";
import "./OptionsBar.css";
import "./ToolFlyout.css";

/** 面板里用得到的两色编辑块。 */
function ColorPair({
  fg,
  bg,
  onFg,
  onBg,
  onSwap,
  onResetColors,
}: {
  fg: string;
  bg: string;
  onFg: (hex: string) => void;
  onBg: (hex: string) => void;
  onSwap: () => void;
  onResetColors: () => void;
}) {
  return (
    <>
      <ColorField
        label={zh.tools.fg}
        hex={fg}
        onChange={onFg}
        footer={
          <button type="button" className="fly-btn" onClick={onSwap}>
            {zh.options.swap}
          </button>
        }
      />
      <ColorField
        label={zh.tools.bgColor}
        hex={bg}
        onChange={onBg}
        footer={
          <button type="button" className="fly-btn" onClick={onResetColors}>
            {zh.options.colorsDefault}
          </button>
        }
      />
    </>
  );
}

interface Props {
  tool: ToolId;
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
  fg: string;
  bg: string;
  onFg: (hex: string) => void;
  onBg: (hex: string) => void;
  onSwap: () => void;
  onResetColors: () => void;
  /** 视图：适应窗口 / 实际像素 */
  onFit: () => void;
  onActual: () => void;
}

export default function ToolFlyout({
  tool,
  brush,
  onBrush,
  fg,
  bg,
  onFg,
  onBg,
  onSwap,
  onResetColors,
  onFit,
  onActual,
}: Props) {
  const title = zh.tools[tool];

  // 画笔 / 橡皮：笔尖、预设、颜色、参数
  if (usesBrush(tool)) {
    const isEraser = tool === "eraser";
    return (
      <>
        <header className="fly-head">
          <span className="fly-title">{title}</span>
          <span className="fly-sub">{zh.tools.flyoutBrush}</span>
        </header>

        <div className="fly-tip">
          <BrushTipPreview brush={brush} isEraser={isEraser} size={64} />
          <div className="fly-tip-meta">
            <span className="fly-tip-size">{brush.size} px</span>
            <span className="fly-hint">{isEraser ? zh.options.eraserHint : zh.options.brushHint}</span>
          </div>
        </div>

        <BrushPresetGroup brush={brush} onPatch={onBrush} />
        <BrushLibrary brush={brush} onPatch={onBrush} />

        <ColorField
          label={zh.options.color}
          hex={fg}
          onChange={onFg}
          hint={zh.options.brushColorHint}
        />

        <Slider
          label={zh.options.size}
          min={1}
          max={500}
          value={brush.size}
          suffix="px"
          onChange={(v) => onBrush({ size: v })}
        />
        <Slider
          label={zh.options.hardness}
          min={0}
          max={100}
          value={brush.hardness}
          suffix="%"
          onChange={(v) => onBrush({ hardness: v })}
        />
        <Slider
          label={zh.options.opacity}
          min={1}
          max={100}
          value={brush.opacity}
          suffix="%"
          onChange={(v) => onBrush({ opacity: v })}
        />
        <Slider
          label={zh.options.flow}
          min={1}
          max={100}
          value={brush.flow}
          suffix="%"
          onChange={(v) => onBrush({ flow: v })}
        />
        <Slider
          label={zh.options.spacing}
          min={1}
          max={100}
          value={brush.spacing}
          suffix="%"
          onChange={(v) => onBrush({ spacing: v })}
        />

        <p className="fly-note">{zh.tools.flyoutShape}</p>
        <Slider
          label={zh.options.jitter}
          min={0}
          max={100}
          value={brush.jitter}
          suffix="%"
          hint={zh.options.jitterHint}
          onChange={(v) => onBrush({ jitter: v })}
        />
        <Slider
          label={zh.options.roundness}
          min={10}
          max={100}
          value={brush.roundness}
          suffix="%"
          hint={zh.options.roundnessHint}
          onChange={(v) => onBrush({ roundness: v })}
        />
        <Slider
          label={zh.options.brushAngle}
          min={0}
          max={360}
          value={brush.angle}
          suffix="°"
          hint={zh.options.brushAngleHint}
          onChange={(v) => onBrush({ angle: v })}
        />

        <p className="fly-note">{zh.tools.flyoutFull}</p>
      </>
    );
  }

  // 填色 / 渐变 / 形状 / 文字：颜色为主
  if (tool === "bucket" || tool === "gradient" || isShapeTool(tool) || isTextTool(tool)) {
    return (
      <>
        <header className="fly-head">
          <span className="fly-title">{title}</span>
          <span className="fly-sub">{zh.tools.flyoutColor}</span>
        </header>

        <ColorPair
          fg={fg}
          bg={bg}
          onFg={onFg}
          onBg={onBg}
          onSwap={onSwap}
          onResetColors={onResetColors}
        />

        <button type="button" className="fly-btn is-wide" onClick={onResetColors}>
          {zh.options.colorsDefault}
        </button>

        <p className="fly-note">{zh.options.colorPickHint}</p>
        <p className="fly-note">{zh.tools.flyoutFull}</p>
      </>
    );
  }

  // 视图类：给两个能立刻点动的命令
  if (tool === "move" || tool === "hand" || tool === "zoom") {
    return (
      <>
        <header className="fly-head">
          <span className="fly-title">{title}</span>
          <span className="fly-sub">{zh.tools.flyoutNav}</span>
        </header>
        <button type="button" className="fly-btn is-wide" onClick={onFit}>
          {zh.tools.flyoutViewFit}
        </button>
        <button type="button" className="fly-btn is-wide" onClick={onActual}>
          {zh.tools.flyoutView100}
        </button>
        <p className="fly-note">{zh.tools.flyoutFull}</p>
      </>
    );
  }

  // 其余工具：不装作有参数，直接说清参数在哪儿
  return (
    <>
      <header className="fly-head">
        <span className="fly-title">{title}</span>
        <span className="fly-sub">{zh.tools.flyoutQuick}</span>
      </header>
      <p className="fly-note">{zh.tools.flyoutHint}</p>
      <p className="fly-note">{zh.tools.flyoutFull}</p>
    </>
  );
}
