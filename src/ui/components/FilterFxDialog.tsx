/**
 * 滤镜参数弹窗（试点框架的 UI 侧）。
 *
 * 与 FilterGallery 同一套实时预览模型：打开那一刻的文档作 base，滑块拖动
 * 中每帧重算预览（useMemo 直推 onPreview，不进历史），确定才落盘一条历史。
 * 列表按 模糊 / 锐化 / 杂色 / 像素化 分组，全部读 FilterDef 注册表。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FILTER_DEFS,
  filterDef,
  filterParams,
  type FilterDef,
  type FilterGroup,
} from "../../engine/filters/defs";
import { applyFilterToLayer } from "../../core/filterOps";
import type { StrataDoc } from "../../core/document";
import { zh } from "../../i18n/zh-CN";
import Modal from "./Modal";
import RangeInput from "./RangeInput";
import "./FilterGallery.css";

interface Props {
  doc: StrataDoc;
  /** 从菜单进来时点名的滤镜 id */
  filterId: string;
  /** 拖动参数时的即时预览（不进历史） */
  onPreview: (next: StrataDoc) => void;
  /** 确定：把结果写进当前图层，进历史 */
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
}

const GROUP_LABELS: Record<FilterGroup, string> = {
  blur: "模糊",
  sharpen: "锐化",
  noise: "杂色",
  pixelate: "像素化",
  distort: "扭曲",
  stylize: "风格化",
  sketch: "素描",
  texture: "纹理",
  artistic: "艺术效果",
  other: "其他",
  render: "渲染",
  video: "视频",
};

const GROUP_ORDER: FilterGroup[] = [
  "blur",
  "sharpen",
  "noise",
  "pixelate",
  "distort",
  "stylize",
  "sketch",
  "texture",
  "artistic",
  "render",
  "other",
  "video",
];

export default function FilterFxDialog({ doc, filterId, onPreview, onApply, onClose }: Props) {
  const base = useRef(doc).current;
  const [id, setId] = useState<string>(() => filterDef(filterId)?.id ?? FILTER_DEFS[0].id);
  const [params, setParams] = useState<Record<string, number>>(() =>
    filterParams(filterDef(id) ?? FILTER_DEFS[0]),
  );

  const def: FilterDef = filterDef(id) ?? FILTER_DEFS[0];

  const preview = useMemo(
    () => applyFilterToLayer(base, def, params),
    [base, def, params],
  );
  const usable = preview !== base;

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedRef = useRef(false);

  useEffect(() => {
    previewRef.current(preview);
  }, [preview]);

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    previewRef.current(base);
    onClose();
  }, [base, onClose]);

  const apply = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onApply(preview);
  }, [onApply, preview]);

  const pick = (next: FilterDef) => {
    setId(next.id);
    setParams(filterParams(next));
  };

  return (
    <Modal
      title={def.label}
      onClose={cancel}
      width={520}
      footer={
        <>
          <span className="fg-note">{usable ? def.label : zh.dialog.filterNoPixel}</span>
          <span className="fg-foot-spacer" />
          <button className="btn-ghost" onClick={cancel}>
            {zh.dialog.cancel}
          </button>
          <button className="btn-primary" onClick={apply} disabled={!usable}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="fg">
        <div className="fg-list" role="listbox" aria-label={zh.dialog.filterTitle}>
          {GROUP_ORDER.map((g) => {
            const items = FILTER_DEFS.filter((d) => d.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className="fg-group">{GROUP_LABELS[g]}</div>
                {items.map((d) => {
                  const on = d.id === id;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={on ? "fg-item is-on" : "fg-item"}
                      onClick={() => pick(d)}
                    >
                      <span className="fg-item-name">{d.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="fg-body">
          <p className="fg-hint">{zh.dialog.filterHint}</p>
          {def.params.map((p) => {
            const v = params[p.id] ?? p.def;
            return (
              <label className="fg-field" key={p.id}>
                <span className="fg-field-head">
                  <span className="fg-field-label">{p.label}</span>
                  <span className="fg-field-value">
                    {p.dec ? v.toFixed(p.dec) : Math.round(v)}
                    {p.unit ?? ""}
                  </span>
                </span>
                {p.choices ? (
                  <select
                    className="fg-select"
                    value={v}
                    onChange={(e) =>
                      setParams((prev) => ({ ...prev, [p.id]: Number(e.target.value) }))
                    }
                  >
                    {p.choices.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <RangeInput
                    className="fg-range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={v}
                    aria-label={p.label}
                    onChange={(nv) => setParams((prev) => ({ ...prev, [p.id]: nv }))}
                  />
                )}
              </label>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
