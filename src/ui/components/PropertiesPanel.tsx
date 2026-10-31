/**
 * 属性面板（右侧 Dock 的第二组）。
 *
 * 两页：
 *   · 属性 —— 当前图层的真实信息（名称 / 类型 / 尺寸 / 不透明度 / 混合模式 /
 *     蒙版 / 剪贴 / 锁定），只显示文档里真有的东西；
 *   · 调整 —— 按明暗 / 色彩 / 效果三族列出全部调整图层，点一下就真的新建一层，
 *     与 PS / PhotoCraft 的「调整」面板同一套用法。
 */
import { Fragment, useState } from "react";
import { zh } from "../../i18n/zh-CN";
import { activeLayer, type StrataDoc } from "../../core/document";
import {
  ADJUST_DEFS,
  BLEND_MODES,
  adjustDef,
  newAdjustState,
  type AdjustFamily,
  type LayerKind,
  type StrataLayer,
} from "../../core/layer";
import { addAdjustLayer } from "../../core/layerOps";
import { AdjustProps, StyleProps } from "./LayersPanel";
import "./PropertiesPanel.css";

interface Props {
  doc: StrataDoc;
  onChange: (next: StrataDoc, label: string) => void;
  onPreview: (next: StrataDoc) => void;
  /** 合成画布（色阶类调整的直方图数据源） */
  compSource?: HTMLCanvasElement | null;
  compVersion?: number;
}

type Tab = "props" | "adjust";

const FAMILY_LABEL: Record<AdjustFamily, string> = {
  tone: zh.layers.adjustFamilyTone,
  color: zh.layers.adjustFamilyColor,
  effect: zh.layers.adjustFamilyEffect,
};

const FAMILY_ORDER: readonly AdjustFamily[] = ["tone", "color", "effect"];

const KIND_LABEL: Record<LayerKind, string> = {
  pixel: zh.panel.kindPixel,
  adjust: zh.panel.kindAdjust,
  group: zh.panel.kindGroup,
};

export default function PropertiesPanel({
  doc,
  onChange,
  onPreview,
  compSource,
  compVersion,
}: Props) {
  const [tab, setTab] = useState<Tab>("props");
  const cur = activeLayer(doc);

  return (
    <section className="dock-panel" aria-label={zh.panel.properties}>
      <div className="panel-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "props"}
          className={tab === "props" ? "panel-tab is-on" : "panel-tab"}
          onClick={() => setTab("props")}
        >
          {zh.panel.properties}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "adjust"}
          className={tab === "adjust" ? "panel-tab is-on" : "panel-tab"}
          onClick={() => setTab("adjust")}
        >
          {zh.panel.adjust}
        </button>
      </div>

      {tab === "props" ? (
        cur ? (
          <div className="dock-scroll pp-body">
            <PropRow label={zh.panel.propName} value={cur.name} />
            <PropRow label={zh.panel.propKind} value={KIND_LABEL[cur.kind]} />
            <PropRow label={zh.panel.propSize} value={layerSize(cur)} />
            <PropRow label={zh.panel.propOpacity} value={`${cur.opacity}%`} />
            <PropRow label={zh.panel.propBlend} value={blendLabel(cur)} />
            <PropRow
              label={zh.panel.propMask}
              value={cur.mask ? (cur.maskActive ? zh.panel.yes : zh.panel.no) : zh.panel.no}
            />
            <PropRow label={zh.panel.propClip} value={cur.clip ? zh.panel.yes : zh.panel.no} />
            <PropRow label={zh.panel.propLock} value={cur.locked ? zh.panel.yes : zh.panel.no} />
            {cur.kind === "adjust" ? (
              <AdjustProps
                doc={doc}
                layer={cur}
                onChange={onChange}
                onPreview={onPreview}
                compSource={compSource}
                compVersion={compVersion}
              />
            ) : (
              <StyleProps doc={doc} layer={cur} onChange={onChange} onPreview={onPreview} />
            )}
          </div>
        ) : (
          <p className="dock-hint pp-empty">{zh.panel.propsEmpty}</p>
        )
      ) : (
        <div className="dock-scroll pp-adjust">
          {FAMILY_ORDER.map((fam) => {
            const items = ADJUST_DEFS.filter((d) => d.family === fam);
            if (items.length === 0) return null;
            return (
              <Fragment key={fam}>
                <span className="pp-group">{FAMILY_LABEL[fam]}</span>
                <div className="pp-grid">
                  {items.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="pp-item"
                      title={`${zh.layers.adjustAdd}：${d.label}`}
                      onClick={() => {
                        onChange(addAdjustLayer(doc, newAdjustState(d.id)), adjustDef(d.id).label);
                        setTab("props");
                      }}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </Fragment>
            );
          })}
          <p className="dock-hint">{zh.panel.adjustHint}</p>
        </div>
      )}
    </section>
  );
}

/** 图层尺寸：像素层看画布，调整层 / 组不占像素。 */
function layerSize(layer: StrataLayer): string {
  if (layer.kind !== "pixel") return "—";
  return `${layer.surface.width} × ${layer.surface.height}`;
}

function blendLabel(layer: StrataLayer): string {
  return BLEND_MODES.find((b) => b.id === layer.blend)?.label ?? layer.blend;
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="pp-row">
      <span className="pp-row-label">{label}</span>
      <span className="pp-row-value" title={value}>
        {value}
      </span>
    </div>
  );
}
