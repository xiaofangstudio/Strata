/**
 * 选项条（立项规划书 §7.1 的第 ④ 条）。
 *
 * 「3 项随工具变化 + 「⋯ 更多」」，长度恒定 —— 切工具时选项条高度与右端
 * 位置不跳，用户的手指不用重新找地方。前 3 项放最常用的参数，「⋯ 更多」
 * 里放该工具剩下的真实参数与说明。
 *
 * 不做假控件：当前工具没有任何参数时，明确写「此工具暂无可调参数」。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { zh } from "../../i18n/zh-CN";
import {
  isRetouchTool,
  isSelectionTool,
  isShapeTool,
  isTextTool,
  usesBrush,
  type ToolId,
} from "../../tools/catalog";
import { type BrushSettings, type GradientStyle } from "../../engine/paint";
import {
  WARP_STYLES,
  type WarpStyle,
} from "../../engine/text";
import { DEFAULT_SHAPE, type ShapeSettings } from "../../engine/shapes";
import {
  TEXT_FAMILIES,
  type TextAlign,
  type TextFamilyId,
  type TextSettings,
} from "../../engine/text";
import {
  DEFAULT_RETOUCH,
  needsSample,
  type RetouchMode,
  type RetouchSettings,
  type SpongeMode,
  type ToneRange,
} from "../../engine/retouch";
import type { SelectionMode } from "../../core/selection";
import {
  BrushLibrary,
  BrushPresetGroup,
  BrushTipPreview,
  Check,
  ColorField,
  ModeGroup,
  SegGroup,
  Slider,
  resetBrush,
  type SegOption,
} from "./controls";
import ToolIcon from "./ToolIcon";
import "./OptionsBar.css";

interface Props {
  tool: ToolId;
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
  /** 修饰工具参数（仿制 / 修复 / 模糊 / 锐化 / 减淡 / 加深 / 海绵共用一套） */
  retouch: RetouchSettings;
  onRetouch: (patch: Partial<RetouchSettings>) => void;
  /** 形状工具参数（矩形 / 椭圆 / 直线共用一套） */
  shape: ShapeSettings;
  onShape: (patch: Partial<ShapeSettings>) => void;
  /** 文字工具参数（字体 / 字号 / 行距 / 对齐 / 加粗斜体） */
  text: TextSettings;
  onText: (patch: Partial<TextSettings>) => void;
  /** 前景色 / 背景色，以及交换、复位 —— 形状填充描边、油漆桶、渐变都在这里直接改 */
  fg: string;
  bg: string;
  onFg: (hex: string) => void;
  onBg: (hex: string) => void;
  onSwap: () => void;
  onResetColors: () => void;
  /** 渐变类型（线性 / 径向 / 角度 / 对称 / 菱形）与反向 */
  gradientStyle: GradientStyle;
  onGradientStyle: (s: GradientStyle) => void;
  gradientReverse: boolean;
  onGradientReverse: (v: boolean) => void;
  tolerance: number;
  onTolerance: (v: number) => void;
  /** 选区组合方式（新建 / 添加 / 减去 / 交叉） */
  selectionMode: SelectionMode;
  onSelectionMode: (m: SelectionMode) => void;
  /** 羽化半径（像素） */
  feather: number;
  onFeather: (v: number) => void;
  /** 魔棒：是否只取与落点相连的一片 */
  contiguous: boolean;
  onContiguous: (v: boolean) => void;
  /** 魔棒：对所有图层取样（按合成结果取色） */
  sampleAllLayers?: boolean;
  onSampleAllLayers?: (v: boolean) => void;
  /** 当前画布尺寸，供裁剪工具只读显示 */
  docSize: string;
  /** 打开画笔设置面板（F5）；只有画笔类工具会显示入口 */
  onOpenBrushPanel?: () => void;
}

export default function OptionsBar({
  tool,
  brush,
  onBrush,
  retouch,
  onRetouch,
  shape,
  onShape,
  text,
  onText,
  fg,
  bg,
  onFg,
  onBg,
  onSwap,
  onResetColors,
  gradientStyle,
  onGradientStyle,
  gradientReverse,
  onGradientReverse,
  tolerance,
  onTolerance,
  selectionMode,
  onSelectionMode,
  feather,
  onFeather,
  contiguous,
  onContiguous,
  sampleAllLayers,
  onSampleAllLayers,
  docSize,
  onOpenBrushPanel,
}: Props) {
  const { main, extra } = buildControls(tool, {
    brush,
    onBrush,
    retouch,
    onRetouch,
    shape,
    onShape,
    text,
    onText,
    fg,
    bg,
    onFg,
    onBg,
    onSwap,
    onResetColors,
    gradientStyle,
    onGradientStyle,
    gradientReverse,
    onGradientReverse,
    tolerance,
    onTolerance,
    selectionMode,
    onSelectionMode,
    feather,
    onFeather,
    contiguous,
    onContiguous,
    sampleAllLayers,
    onSampleAllLayers,
    docSize,
  });

  return (
    <div className="optbar" role="toolbar" aria-label={zh.tools[tool]}>
      {/* 工具名与选项组都按工具换 key：换工具时整块重挂载，好让入场动效重放一遍，
          用户一眼能确认「这一下点到了」。 */}
      <span className="optbar-tool" key={`tool-${tool}`}>
        <ToolIcon id={tool} size={18} />
        <span className="optbar-tool-name">{zh.tools[tool]}</span>
      </span>
      <span className="optbar-sep" />

      <div className="optbar-items" key={`items-${tool}`}>
        {main.length > 0 ? main : <span className="optbar-none">{zh.options.none}</span>}
      </div>

      {usesBrush(tool) && onOpenBrushPanel && (
        <button
          type="button"
          className="btn-ghost btn-sm optbar-brush-panel"
          title={zh.options.brushPanel.openHint}
          onClick={onOpenBrushPanel}
        >
          {zh.options.brushPanel.open}
        </button>
      )}

      <MoreMenu>{extra}</MoreMenu>
    </div>
  );
}

/* ---------------- 各项控件 ---------------- */

interface Ctx {
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
  retouch: RetouchSettings;
  onRetouch: (patch: Partial<RetouchSettings>) => void;
  shape: ShapeSettings;
  onShape: (patch: Partial<ShapeSettings>) => void;
  text: TextSettings;
  onText: (patch: Partial<TextSettings>) => void;
  fg: string;
  bg: string;
  onFg: (hex: string) => void;
  onBg: (hex: string) => void;
  onSwap: () => void;
  onResetColors: () => void;
  gradientStyle: GradientStyle;
  onGradientStyle: (s: GradientStyle) => void;
  gradientReverse: boolean;
  onGradientReverse: (v: boolean) => void;
  tolerance: number;
  onTolerance: (v: number) => void;
  selectionMode: SelectionMode;
  onSelectionMode: (m: SelectionMode) => void;
  feather: number;
  onFeather: (v: number) => void;
  contiguous: boolean;
  onContiguous: (v: boolean) => void;
  sampleAllLayers?: boolean;
  onSampleAllLayers?: (v: boolean) => void;
  docSize: string;
}

interface Built {
  /** 常驻的 3 项参数（左起） */
  main: ReactNode[];
  /** 「⋯ 更多」里的内容，可以是一段说明加一组控件 */
  extra: ReactNode;
}

/** 渐变类型：与 PS 的五种对应。 */
const GRADIENT_OPTIONS: SegOption<GradientStyle>[] = [
  { value: "linear", label: zh.options.gradientLinear, hint: zh.options.gradientTypeHint },
  { value: "radial", label: zh.options.gradientRadial, hint: zh.options.gradientTypeHint },
  { value: "angle", label: zh.options.gradientAngle, hint: zh.options.gradientTypeHint },
  { value: "reflected", label: zh.options.gradientReflected, hint: zh.options.gradientTypeHint },
  { value: "diamond", label: zh.options.gradientDiamond, hint: zh.options.gradientTypeHint },
];

/** 前景 / 背景两个可编辑色块 + 交换与复位，供渐变、油漆桶、形状共用。 */
function ColorPair({ c, compact }: { c: Ctx; compact?: boolean }) {
  return (
    <>
      <ColorField
        key="fg"
        label={zh.tools.fg}
        hex={c.fg}
        onChange={c.onFg}
        compact={compact}
        footer={
          <button type="button" className="btn-ghost btn-xs" onClick={c.onSwap}>
            {zh.options.swap}
          </button>
        }
      />
      <ColorField
        key="bg"
        label={zh.tools.bgColor}
        hex={c.bg}
        onChange={c.onBg}
        compact={compact}
        footer={
          <button type="button" className="btn-ghost btn-xs" onClick={c.onResetColors}>
            {zh.options.colorsDefault}
          </button>
        }
      />
    </>
  );
}

function buildControls(tool: ToolId, c: Ctx): Built {
  if (usesBrush(tool)) {
    const isEraser = tool === "eraser";
    return {
      main: [
        <BrushTipPreview key="tip" brush={c.brush} isEraser={isEraser} />,
        <BrushPresetGroup key="preset" brush={c.brush} onPatch={c.onBrush} />,
        <ColorField
          key="color"
          label={zh.options.color}
          hex={c.brush.color}
          onChange={c.onFg}
          hint={zh.options.brushColorHint}
          footer={
            <button type="button" className="btn-ghost btn-xs" onClick={c.onSwap}>
              {zh.options.swap}
            </button>
          }
        />,
        <Slider
          key="size"
          label={zh.options.size}
          min={1}
          max={500}
          value={c.brush.size}
          onChange={(v) => c.onBrush({ size: v })}
        />,
        <Slider
          key="hardness"
          label={zh.options.hardness}
          min={0}
          max={100}
          value={c.brush.hardness}
          onChange={(v) => c.onBrush({ hardness: v })}
          suffix="%"
        />,
        <Slider
          key="opacity"
          label={zh.options.opacity}
          min={1}
          max={100}
          value={c.brush.opacity}
          onChange={(v) => c.onBrush({ opacity: v })}
          suffix="%"
        />,
      ],
      extra: (
        <>
          <p className="opt-note">{isEraser ? zh.options.eraserHint : zh.options.brushHint}</p>
          <div className="opt-extra-row">
            <Slider
              key="flow"
              label={zh.options.flow}
              min={1}
              max={100}
              value={c.brush.flow}
              onChange={(v) => c.onBrush({ flow: v })}
              suffix="%"
            />
            <Slider
              key="spacing"
              label={zh.options.spacing}
              min={1}
              max={50}
              value={c.brush.spacing}
              onChange={(v) => c.onBrush({ spacing: v })}
              suffix="%"
            />
            <Slider
              key="smoothing"
              label={zh.options.smoothing}
              min={0}
              max={100}
              value={c.brush.smoothing}
              onChange={(v) => c.onBrush({ smoothing: v })}
              suffix="%"
              hint={zh.options.smoothingHint}
            />
          </div>
          <p className="opt-note">{zh.options.spacingHint}</p>
          <div className="opt-extra-row">
            <Check
              key="pulled"
              label={zh.options.pulledString}
              on={c.brush.pulledString}
              onChange={(v) => c.onBrush({ pulledString: v })}
              hint={zh.options.pulledStringHint}
            />
            <Check
              key="catchUp"
              label={zh.options.catchUp}
              on={c.brush.catchUp}
              onChange={(v) => c.onBrush({ catchUp: v })}
              hint={zh.options.catchUpHint}
            />
            <Check
              key="catchUpEnd"
              label={zh.options.catchUpOnEnd}
              on={c.brush.catchUpOnEnd}
              onChange={(v) => c.onBrush({ catchUpOnEnd: v })}
              hint={zh.options.catchUpOnEndHint}
            />
          </div>
          <div className="opt-extra-row">
            <SegGroup
              label={zh.options.tip}
              value={c.brush.tip}
              onChange={(tip) => c.onBrush({ tip })}
              options={[
                { value: "round", label: zh.options.tipRound },
                { value: "pencil", label: zh.options.tipPencil },
                { value: "chalk", label: zh.options.tipChalk },
                { value: "bristle", label: zh.options.tipBristle },
                { value: "spray", label: zh.options.tipSpray },
              ]}
            />
            <SegGroup
              label={zh.options.texture}
              value={c.brush.texture}
              onChange={(texture) => c.onBrush({ texture })}
              options={[
                { value: "none", label: zh.options.textureNone },
                { value: "paper", label: zh.options.texturePaper },
                { value: "canvas", label: zh.options.textureCanvas },
                { value: "grain", label: zh.options.textureGrain },
                { value: "dots", label: zh.options.textureDots },
              ]}
            />
          </div>
          <div className="opt-extra-row">
            <SegGroup
              label={zh.options.symmetry}
              value={c.brush.symmetry ?? "none"}
              onChange={(symmetry) => c.onBrush({ symmetry })}
              options={[
                { value: "none", label: zh.options.symmetryNone },
                { value: "vertical", label: zh.options.symmetryVertical, hint: zh.options.symmetryHint },
                { value: "horizontal", label: zh.options.symmetryHorizontal, hint: zh.options.symmetryHint },
                { value: "both", label: zh.options.symmetryBoth, hint: zh.options.symmetryHint },
              ]}
            />
          </div>
          <p className="opt-note">{zh.options.tipHint}</p>
          <p className="opt-note">{zh.options.textureHint}</p>
          <div className="opt-extra-row">
            <Slider
              key="textureScale"
              label={zh.options.textureScale}
              min={50}
              max={400}
              value={c.brush.textureScale}
              onChange={(v) => c.onBrush({ textureScale: v })}
              suffix="%"
              hint={zh.options.textureScaleHint}
            />
            <Slider
              key="textureDepth"
              label={zh.options.textureDepth}
              min={0}
              max={100}
              value={c.brush.textureDepth}
              onChange={(v) => c.onBrush({ textureDepth: v })}
              suffix="%"
              hint={zh.options.textureDepthHint}
            />
            <Slider
              key="hueJitter"
              label={zh.options.hueJitter}
              min={0}
              max={100}
              value={c.brush.hueJitter}
              onChange={(v) => c.onBrush({ hueJitter: v })}
              suffix="%"
              hint={zh.options.hueJitterHint}
            />
          </div>
          <div className="opt-extra-row">
            <Slider
              key="jitter"
              label={zh.options.jitter}
              min={0}
              max={100}
              value={c.brush.jitter}
              onChange={(v) => c.onBrush({ jitter: v })}
              suffix="%"
              hint={zh.options.jitterHint}
            />
            <Slider
              key="roundness"
              label={zh.options.roundness}
              min={10}
              max={100}
              value={c.brush.roundness}
              onChange={(v) => c.onBrush({ roundness: v })}
              suffix="%"
              hint={zh.options.roundnessHint}
            />
            <Slider
              key="angle"
              label={zh.options.brushAngle}
              min={0}
              max={360}
              value={c.brush.angle}
              onChange={(v) => c.onBrush({ angle: v })}
              suffix="°"
              hint={zh.options.brushAngleHint}
            />
          </div>
          <div className="opt-extra-row">
            <BrushLibrary brush={c.brush} onPatch={c.onBrush} />
          </div>
          <div className="opt-extra-row">
            <ColorField
              label={zh.options.color}
              hex={c.brush.color}
              onChange={c.onFg}
              hint={zh.options.brushColorHint}
            />
          </div>
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => c.onBrush(resetBrush(c.brush))}
          >
            {zh.options.reset}
          </button>
        </>
      ),
    };
  }

  // 修饰七件（仿制 / 修复 / 模糊 / 锐化 / 减淡 / 加深 / 海绵）。
  // 前 3 项恒定（大小 / 硬度 / 力度），其余参数与说明一律进「⋯ 更多」，
  // 这样切工具时选项条长度不跳。
  if (isRetouchTool(tool)) {
    const mode = tool as RetouchMode;
    const rt = c.retouch;
    const note = RETOUCH_NOTE[mode];

    const main: ReactNode[] = [
      <Slider
        key="size"
        label={zh.options.size}
        min={1}
        max={500}
        value={rt.size}
        onChange={(v) => c.onRetouch({ size: v })}
      />,
      <Slider
        key="hardness"
        label={zh.options.hardness}
        min={0}
        max={100}
        value={rt.hardness}
        onChange={(v) => c.onRetouch({ hardness: v })}
        suffix="%"
      />,
      <Slider
        key="strength"
        label={zh.options.strength}
        min={1}
        max={100}
        value={rt.strength}
        onChange={(v) => c.onRetouch({ strength: v })}
        suffix="%"
      />,
    ];

    const extra: ReactNode[] = [
      <p key="hint" className="opt-note">
        {note.hint}
      </p>,
    ];
    if (needsSample(mode)) {
      extra.push(
        <p key="need" className="opt-note">
          {zh.options.cloneNeedSample}
        </p>,
      );
    }
    if (note.extra) {
      extra.push(
        <p key="ex" className="opt-note">
          {note.extra}
        </p>,
      );
    }

    extra.push(
      <div key="row" className="opt-extra-row">
        <Slider
          key="spacing"
          label={zh.options.spacing}
          min={1}
          max={50}
          value={rt.spacing}
          onChange={(v) => c.onRetouch({ spacing: v })}
          suffix="%"
        />
      </div>,
    );

    if (mode === "sponge") {
      extra.push(
        <SegGroup
          key="sponge"
          label={zh.options.spongeMode}
          value={rt.sponge}
          options={SPONGE_OPTIONS}
          onChange={(v) => c.onRetouch({ sponge: v })}
        />,
      );
    }
    if (mode === "dodge" || mode === "burn") {
      extra.push(
        <SegGroup
          key="range"
          label={zh.options.range}
          value={rt.range}
          options={RANGE_OPTIONS}
          onChange={(v) => c.onRetouch({ range: v })}
        />,
      );
    }

    extra.push(
      <p key="pace" className="opt-note">
        {zh.options.retouchPace}
      </p>,
      <button
        key="reset"
        type="button"
        className="btn-ghost btn-xs"
        onClick={() => c.onRetouch(DEFAULT_RETOUCH)}
      >
        {zh.options.reset}
      </button>,
    );

    return { main, extra: <>{extra}</> };
  }

  // 形状三件（矩形 / 椭圆 / 直线）：填充 / 描边 / 线宽恒定在前，说明进「⋯ 更多」
  if (isShapeTool(tool)) {
    const note =
      tool === "shapeRect"
        ? zh.options.shapeRectHint
        : tool === "shapeEllipse"
          ? zh.options.shapeEllipseHint
          : zh.options.shapeLineHint;
    const st = c.shape;
    return {
      main: [
        <Check
          key="fill"
          label={zh.options.fill}
          on={st.fill}
          onChange={(v) => c.onShape({ fill: v })}
          hint={zh.options.shapeFillHint}
        />,
        <Check
          key="stroke"
          label={zh.options.stroke}
          on={st.stroke}
          onChange={(v) => c.onShape({ stroke: v })}
          hint={zh.options.shapeStrokeHint}
        />,
        <Slider
          key="sw"
          label={zh.options.strokeWidth}
          min={0}
          max={100}
          value={st.strokeWidth}
          onChange={(v) => c.onShape({ strokeWidth: v })}
          suffix="px"
        />,
      ],
      extra: (
        <>
          <p className="opt-note">{note}</p>
          <p className="opt-note">{zh.options.shapeHint}</p>
          <div className="opt-extra-row">
            <ColorField
              label={zh.options.fill}
              hex={c.fg}
              onChange={c.onFg}
              hint={zh.options.shapeFillHint}
              footer={
                <button type="button" className="btn-ghost btn-xs" onClick={c.onSwap}>
                  {zh.options.swap}
                </button>
              }
            />
            <ColorField
              label={zh.options.stroke}
              hex={c.bg}
              onChange={c.onBg}
              hint={zh.options.shapeStrokeHint}
              footer={
                <button type="button" className="btn-ghost btn-xs" onClick={c.onResetColors}>
                  {zh.options.colorsDefault}
                </button>
              }
            />
          </div>
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => c.onShape(DEFAULT_SHAPE)}
          >
            {zh.options.reset}
          </button>
        </>
      ),
    };
  }

  // 选区四件（矩形 / 椭圆 / 套索 / 魔棒）：模式永远在最前，后面跟该工具自己的参数
  if (isSelectionTool(tool)) {
    const wand = tool === "wand";
    const main: ReactNode[] = [
      <ModeGroup key="mode" value={c.selectionMode} onChange={c.onSelectionMode} />,
    ];
    if (wand) {
      main.push(
        <Slider
          key="tol"
          label={zh.options.tolerance}
          min={0}
          max={100}
          value={c.tolerance}
          onChange={c.onTolerance}
        />,
        <Check
          key="contig"
          label={zh.options.contiguous}
          on={c.contiguous}
          onChange={c.onContiguous}
          hint={zh.options.wandHint}
        />,
        c.sampleAllLayers !== undefined && c.onSampleAllLayers && (
          <Check
            key="sampleall"
            label={zh.options.sampleAllLayers}
            on={c.sampleAllLayers}
            onChange={c.onSampleAllLayers}
            hint={zh.options.sampleAllLayersHint}
          />
        ),
      );
    } else {
      main.push(
        <Slider
          key="feather"
          label={zh.options.feather}
          min={0}
          max={100}
          value={c.feather}
          onChange={c.onFeather}
          suffix="px"
        />,
      );
    }
    return {
      main,
      extra: (
        <>
          <p className="opt-note">
            {wand ? zh.options.wandHint : tool === "polyLasso" ? zh.options.polyLassoHint : zh.options.selectionHint}
          </p>
          {!wand && <p className="opt-note">{zh.options.featherHint}</p>}
          <p className="opt-note">{zh.options.marqueeSampleAll}</p>
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => (wand ? c.onTolerance(32) : c.onFeather(0))}
          >
            {zh.options.reset}
          </button>
        </>
      ),
    };
  }

  // 魔术橡皮擦：与魔棒同一套容差 / 连续参数，只是「选中」变成「擦成透明」
  if (tool === "magicEraser") {
    return {
      main: [
        <Slider
          key="tol"
          label={zh.options.tolerance}
          min={0}
          max={100}
          value={c.tolerance}
          onChange={c.onTolerance}
        />,
        <Check
          key="contig"
          label={zh.options.contiguous}
          on={c.contiguous}
          onChange={c.onContiguous}
          hint={zh.options.wandHint}
        />,
        c.sampleAllLayers !== undefined && c.onSampleAllLayers && (
          <Check
            key="sampleall"
            label={zh.options.sampleAllLayers}
            on={c.sampleAllLayers}
            onChange={c.onSampleAllLayers}
            hint={zh.options.sampleAllLayersHint}
          />
        ),
      ],
      extra: (
        <>
          <p className="opt-note">{zh.options.magicEraserHint}</p>
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => c.onTolerance(32)}
          >
            {zh.options.reset}
          </button>
        </>
      ),
    };
  }

  if (isTextTool(tool)) {
    return {
      main: [
        <SegGroup<TextFamilyId>
          key="family"
          label={zh.options.font}
          value={c.text.family}
          options={TEXT_FAMILIES.map((f) => ({
            value: f.id,
            label: f.label,
            hint: f.stack,
          }))}
          onChange={(family) => c.onText({ family })}
        />,
        <Slider
          key="size"
          label={zh.options.fontSize}
          min={8}
          max={400}
          value={Math.round(c.text.size)}
          suffix="px"
          onChange={(size) => c.onText({ size })}
        />,
        <Slider
          key="tracking"
          label={zh.options.letterSpacing}
          min={-20}
          max={100}
          value={Math.round(c.text.letterSpacing)}
          suffix="px"
          onChange={(letterSpacing) => c.onText({ letterSpacing })}
        />,
        <SegGroup<TextAlign>
          key="align"
          label={zh.options.textAlign}
          value={c.text.align}
          options={[
            { value: "left", label: zh.options.alignLeft },
            { value: "center", label: zh.options.alignCenter },
            { value: "right", label: zh.options.alignRight },
          ]}
          onChange={(align) => c.onText({ align })}
        />,
      ],
      extra: (
        <>
          <Slider
            label={zh.options.lineHeight}
            min={80}
            max={260}
            value={Math.round(c.text.lineHeight * 100)}
            suffix="%"
            onChange={(v) => c.onText({ lineHeight: v / 100 })}
          />
          <Check
            label={zh.options.textBold}
            on={c.text.bold}
            onChange={(bold) => c.onText({ bold })}
          />
          <Check
            label={zh.options.textItalic}
            on={c.text.italic}
            onChange={(italic) => c.onText({ italic })}
          />
          <SegGroup<WarpStyle>
            label={zh.options.textWarp}
            value={c.text.warp}
            options={WARP_STYLES.map((w) => ({ value: w.id, label: w.label }))}
            onChange={(warp) => c.onText({ warp })}
          />
          {c.text.warp !== "none" && (
            <Slider
              label={zh.options.textWarpAmount}
              min={-100}
              max={100}
              value={Math.round(c.text.warpAmount)}
              suffix="%"
              onChange={(v) => c.onText({ warpAmount: v })}
            />
          )}
          <p className="opt-note">{zh.options.textHint}</p>
        </>
      ),
    };
  }

  if (tool === "crop") {
    return {
      main: [
        <span key="size" className="opt">
          <span className="opt-label">{zh.options.size}</span>
          <span className="opt-readonly">{c.docSize}</span>
        </span>,
      ],
      extra: (
        <>
          <p className="opt-note">{zh.options.cropHint}</p>
          <p className="opt-note">{zh.options.cropNoSelection}</p>
        </>
      ),
    };
  }

  if (tool === "bucket") {
    return {
      main: [
        <Slider
          key="tol"
          label={zh.options.tolerance}
          min={0}
          max={100}
          value={c.tolerance}
          onChange={c.onTolerance}
        />,
        <ColorField
          key="fg"
          label={zh.options.color}
          hex={c.fg}
          onChange={c.onFg}
          hint={zh.options.bucketColorHint}
          footer={
            <button type="button" className="btn-ghost btn-xs" onClick={c.onSwap}>
              {zh.options.swap}
            </button>
          }
        />,
      ],
      extra: (
        <>
          <p className="opt-note">{zh.options.bucketHint}</p>
          <div className="opt-extra-row">
            <ColorPair c={c} />
          </div>
          <button type="button" className="btn-ghost btn-xs" onClick={c.onResetColors}>
            {zh.options.colorsDefault}
          </button>
        </>
      ),
    };
  }

  if (tool === "gradient") {
    return {
      // 顶栏已是「真控件」：类型可切、两个色块点开就能改色或直接取色器取色
      main: [
        <SegGroup<GradientStyle>
          key="type"
          label={zh.options.gradientType}
          value={c.gradientStyle}
          options={GRADIENT_OPTIONS}
          onChange={c.onGradientStyle}
        />,
        <ColorField
          key="a"
          label={zh.tools.fg}
          hex={c.fg}
          onChange={c.onFg}
          hint={zh.options.gradientStartHint}
          footer={
            <button type="button" className="btn-ghost btn-xs" onClick={c.onSwap}>
              {zh.options.swap}
            </button>
          }
        />,
        <ColorField
          key="b"
          label={zh.tools.bgColor}
          hex={c.bg}
          onChange={c.onBg}
          hint={zh.options.gradientEndHint}
          footer={
            <button type="button" className="btn-ghost btn-xs" onClick={c.onResetColors}>
              {zh.options.colorsDefault}
            </button>
          }
        />,
      ],
      extra: (
        <>
          <p className="opt-note">{zh.options.gradientHint}</p>
          <p className="opt-note">{zh.options.gradientTypeHint}</p>
          <div className="opt-extra-row">
            <ColorPair c={c} />
          </div>
          <Check
            label={zh.options.gradientReverse}
            on={c.gradientReverse}
            onChange={c.onGradientReverse}
            hint={zh.options.gradientReverseHint}
          />
          <div className="opt-extra-row">
            <SegGroup<GradientStyle>
              label={zh.options.gradientType}
              value={c.gradientStyle}
              options={GRADIENT_OPTIONS}
              onChange={c.onGradientStyle}
            />
          </div>
          <button type="button" className="btn-ghost btn-xs" onClick={c.onResetColors}>
            {zh.options.colorsDefault}
          </button>
        </>
      ),
    };
  }

  if (tool === "move") return { main: [], extra: <p className="opt-note">{zh.options.moveHint}</p> };
  if (tool === "hand") return { main: [], extra: <p className="opt-note">{zh.options.handHint}</p> };
  if (tool === "zoom") return { main: [], extra: <p className="opt-note">{zh.options.zoomHint}</p> };
  if (tool === "eyedropper")
    return { main: [], extra: <p className="opt-note">{zh.tools.eyedropperHint}</p> };

  return { main: [], extra: <p className="opt-note">{zh.options.none}</p> };
}

/** 修饰工具的说明文案（主提示 + 可选补充）。 */
const RETOUCH_NOTE: Record<RetouchMode, { hint: string; extra?: string }> = {
  clone: { hint: zh.options.cloneHint, extra: zh.options.cloneHintExtra },
  heal: { hint: zh.options.healHint, extra: zh.options.healHintExtra },
  blur: { hint: zh.options.blurHint, extra: zh.options.blurHintExtra },
  sharpen: { hint: zh.options.sharpenHint, extra: zh.options.sharpenHintExtra },
  dodge: { hint: zh.options.dodgeHint, extra: zh.options.dodgeBurnHintExtra },
  burn: { hint: zh.options.burnHint, extra: zh.options.dodgeBurnHintExtra },
  sponge: { hint: zh.options.spongeHint, extra: zh.options.spongeHintExtra },
};

const SPONGE_OPTIONS: SegOption<SpongeMode>[] = [
  { value: "desaturate", label: zh.options.desaturate },
  { value: "saturate", label: zh.options.saturate },
];

const RANGE_OPTIONS: SegOption<ToneRange>[] = [
  { value: "shadows", label: zh.options.shadows },
  { value: "midtones", label: zh.options.midtones },
  { value: "highlights", label: zh.options.highlights },
];

/* ---------------- 「⋯ 更多」 ---------------- */

function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 颜色浮层 portal 到 body 上，仍属于「更多」面板的一部分，点它不算点外面
      if (t?.closest(".color-pop")) return;
      if (!rootRef.current?.contains(t as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".color-pop")) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="optbar-more-wrap" ref={rootRef}>
      <button
        type="button"
        className="btn-ghost btn-sm optbar-more"
        aria-expanded={open}
        title={zh.options.moreHint}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯ {zh.options.more}
      </button>
      {open && (
        <div className="optbar-pop" role="dialog" aria-label={zh.options.more}>
          {children}
        </div>
      )}
    </div>
  );
}
