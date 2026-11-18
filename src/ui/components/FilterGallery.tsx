/**
 * 滤镜库（PhotoCraft Filter Gallery 形态）。
 *
 * 与旧版「6 个效果单选 + 滑块」不同：现在是效果堆栈 ——
 * 左侧效果目录，往中间堆栈里加项，多个效果按顺序叠加；每项可显隐、重排、删除；
 * 右侧调选中项的参数。确定时整条堆栈一次落库成一条历史。
 *
 * 预览从打开那一刻的 base 快照重算整条堆栈，绝不在上一次预览上叠加。
 * 参数核心见 core/filterStack.ts（纯函数、可测），活动层 id 全程不变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ADJUST_DEFS,
  adjustDef,
  newAdjustState,
  type AdjustId,
} from "../../core/layer";
import { applyFilterStack, moveItem, toggleItem, type FilterStackItem } from "../../core/filterStack";
import type { StrataDoc } from "../../core/document";
import { zh } from "../../i18n";
import DraggableModal from "./DraggableModal";
import "./FilterGallery.css";
import RangeInput from "./RangeInput";

interface Props {
  doc: StrataDoc;
  onPreview: (next: StrataDoc) => void;
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
}

const FILTERS = ADJUST_DEFS.filter((d) => d.family === "effect");
let uidSeq = 0;
const nextUid = () => `fx-${++uidSeq}`;

export default function FilterGallery({ doc, onPreview, onApply, onClose }: Props) {
  const base = useRef(doc).current;
  const [items, setItems] = useState<FilterStackItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const preview = useMemo(() => applyFilterStack(base, items), [base, items]);
  const usable = items.some((i) => i.visible) && preview.applied > 0;

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedRef = useRef(false);

  useEffect(() => {
    previewRef.current(preview.doc);
  }, [preview.doc]);

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    previewRef.current(base);
    onClose();
  }, [base, onClose]);

  const apply = useCallback(() => {
    if (closedRef.current || !usable) return;
    closedRef.current = true;
    onApply(preview.doc);
  }, [usable, onApply, preview.doc]);

  const addEffect = (id: AdjustId) => {
    const item: FilterStackItem = { uid: nextUid(), id, params: newAdjustState(id).params, visible: true };
    setItems((prev) => [...prev, item]);
    setSelected(item.uid);
  };

  const selectedItem = items.find((i) => i.uid === selected) ?? null;
  const selDef = selectedItem ? adjustDef(selectedItem.id) : null;

  const setParam = (paramId: string, value: number) => {
    if (!selectedItem) return;
    setItems((prev) => prev.map((it) =>
      it.uid === selectedItem.uid ? { ...it, params: { ...it.params, [paramId]: value } } : it,
    ));
  };

  // 控件与按钮都要 stopPropagation，免得点它们时把「选中项」也一起换了
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <DraggableModal
      id="filterGallery"
      title={zh.dialog.filterTitle}
      badge="滤镜库"
      onClose={cancel}
      width={880}
      height={620}
      footer={
        <>
          <span className="fg-note">
            {usable ? `${items.filter((i) => i.visible).length} 个效果叠加` : "从左侧添加效果到堆栈"}
          </span>
          <span className="fg-foot-spacer" />
          <button className="btn-ghost" onClick={cancel}>{zh.dialog.cancel}</button>
          <button className="btn-primary" onClick={apply} disabled={!usable}>{zh.dialog.confirm}</button>
        </>
      }
    >
      <div className="fgl">
        {/* 左：效果目录 */}
        <div className="fgl-catalog" role="listbox" aria-label={zh.dialog.filterTitle}>
          <div className="fgl-col-head">效果</div>
          {FILTERS.map((d) => (
            <button key={d.id} type="button" className="fg-item" onClick={() => addEffect(d.id)} title={`添加 ${d.label}`}>
              <span className="fg-item-name">{d.label}</span>
              <span className="fg-item-sub">+ 添加</span>
            </button>
          ))}
        </div>

        {/* 中：效果堆栈（自下而上叠加，与 PhotoCraft 一致） */}
        <div className="fgl-stack">
          <div className="fgl-col-head">
            <span>效果堆栈</span>
            <span className="fgl-col-sub">{items.length} 项</span>
          </div>
          {items.length === 0 && <p className="fgl-empty">左键点一个效果添加，可叠加多个</p>}
          <div className="fgl-stack-list">
            {items.map((it, i) => {
              const d = adjustDef(it.id);
              const on = it.uid === selected;
              return (
                <div
                  key={it.uid}
                  className={`fgl-card${on ? " is-on" : ""}${it.visible ? "" : " is-off"}`}
                  onClick={() => setSelected(it.uid)}
                  role="option"
                  aria-selected={on}
                >
                  <button
                    type="button"
                    className="fgl-eye"
                    title={it.visible ? "隐藏此效果" : "显示此效果"}
                    onClick={(e) => { stop(e); setItems(toggleItem(items, i)); }}
                  >
                    {it.visible ? "◉" : "○"}
                  </button>
                  <div className="fgl-card-main">
                    <span className="fgl-card-name">{d.label}</span>
                    <span className="fgl-card-sub">第 {i + 1} 层 · {d.params.length} 参数</span>
                  </div>
                  <div className="fgl-card-ops">
                    <button type="button" title="上移" disabled={i === 0}
                      onClick={(e) => { stop(e); setItems(moveItem(items, i, i - 1)); }}>↑</button>
                    <button type="button" title="下移" disabled={i === items.length - 1}
                      onClick={(e) => { stop(e); setItems(moveItem(items, i, i + 1)); }}>↓</button>
                    <button type="button" title="删除"
                      onClick={(e) => {
                        stop(e);
                        setItems((prev) => prev.filter((x) => x.uid !== it.uid));
                        if (on) setSelected(null);
                      }}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右：选中项参数 */}
        <div className="fgl-params">
          <div className="fgl-col-head">{selDef ? selDef.label : "参数"}</div>
          {!selectedItem && <p className="fgl-empty">选中一个效果来调它的参数</p>}
          {selectedItem && selDef && (
            <div className="fg-body">
              {selDef.params.map((p) => {
                const v = selectedItem.params[p.id] ?? p.def;
                return (
                  <label className="fg-field" key={p.id}>
                    <span className="fg-field-head">
                      <span className="fg-field-label">{p.label}</span>
                      <span className="fg-field-value">
                        {p.dec ? v.toFixed(p.dec) : Math.round(v)}{p.unit ?? ""}
                      </span>
                    </span>
                    <RangeInput
                      className="fg-range"
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      value={v}
                      aria-label={p.label}
                      onChange={(nv) => setParam(p.id, nv)}
                    />
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </DraggableModal>
  );
}
