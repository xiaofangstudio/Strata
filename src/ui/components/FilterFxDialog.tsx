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
import { zh } from "../../i18n";
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
  blurGallery: "模糊画廊",
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
  "blurGallery",
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

/**
 * 预览用的滤镜：**在小图上算，再放大回原尺寸**。
 *
 * 原来这里是 `applyFilterToLayer(base, ...)` 直接跑全分辨率 ——
 * 高斯模糊这类卷积在 24MP 上要好几百毫秒，而拖动时每帧都要跑一次，
 * 结果就是"拖一下、等半秒"。缩到 ~1100px 后成本降到几十分之一，
 * 放大回原尺寸只是一次 GPU 拉伸，几乎免费。
 *
 * 确认（onApply）时仍走全分辨率，所以最终结果不受影响；
 * 预览只是"形状对得上"，这正是调参数时需要的。
 */
function previewFilter(base: StrataDoc, def: FilterDef, params: Record<string, number>): StrataDoc {
  const MAX_SIDE = 1100;
  const s = Math.min(1, MAX_SIDE / Math.max(base.width, base.height));
  const act = base.layers.find((l) => l.id === base.activeLayerId);
  if (s >= 0.999 || !act || act.kind !== "pixel" || !act.surface) {
    return applyFilterToLayer(base, def, params);
  }

  const sw = Math.max(1, Math.round(base.width * s));
  const sh = Math.max(1, Math.round(base.height * s));
  const small = document.createElement("canvas");
  small.width = sw;
  small.height = sh;
  const sc = small.getContext("2d");
  if (!sc) return applyFilterToLayer(base, def, params);
  sc.imageSmoothingQuality = "medium";
  sc.drawImage(act.surface, 0, 0, sw, sh);

  const smallDoc: StrataDoc = {
    ...base,
    width: sw,
    height: sh,
    layers: base.layers.map((l) => (l.id === act.id ? { ...l, surface: small, mask: null } : l)),
  };
  const res = applyFilterToLayer(smallDoc, def, params);
  if (res === smallDoc) return base;

  const resLayer = res.layers.find((l) => l.id === act.id);
  if (!resLayer || !resLayer.surface) return base;

  // 放大回文档尺寸：doc 的宽高一致，后续合成 / 存盘都不会错位
  const big = document.createElement("canvas");
  big.width = base.width;
  big.height = base.height;
  const bc = big.getContext("2d");
  if (!bc) return base;
  bc.imageSmoothingQuality = "medium";
  bc.drawImage(resLayer.surface, 0, 0, base.width, base.height);

  return {
    ...base,
    layers: base.layers.map((l) => (l.id === act.id ? { ...l, surface: big } : l)),
  };
}

export default function FilterFxDialog({ doc, filterId, onPreview, onApply, onClose }: Props) {
  const base = useRef(doc).current;
  const [id, setId] = useState<string>(() => filterDef(filterId)?.id ?? FILTER_DEFS[0].id);
  const [params, setParams] = useState<Record<string, number>>(() =>
    filterParams(filterDef(id) ?? FILTER_DEFS[0]),
  );

  const def: FilterDef = filterDef(id) ?? FILTER_DEFS[0];

  const preview = useMemo(() => previewFilter(base, def, params), [base, def, params]);
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
    // 确认时重算全分辨率：预览是缩放近似，落库必须是真东西
    const full = applyFilterToLayer(base, def, params);
    onApply(full === base ? base : full);
  }, [base, def, onApply, params]);

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
