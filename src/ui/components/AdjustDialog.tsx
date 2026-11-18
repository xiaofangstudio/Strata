/**
 * 调整参数对话框（与 FilterFxDialog 同一套「实时预览 / 确定才落库 / 可取消」）。
 *
 * 为什么必须做成弹窗：以前「图像 > 调整」「图层 > 新建调整图层」点一下就
 * `addAdjustLayer` —— 新建层会抢走 `activeLayerId`，而调色台只在「活动层正好是
 * 调色层」时才渲染（EditorShell 的 gradeLayer），于是用户看到的就是「调色台突然
 * 变回新建引导、之前调的色全没了」。而且新建的是**中性参数**的层，画面毫无变化，
 * 参数又藏在右侧属性面板里 —— 这正是「所有东西都起效了，但是又没有起效」。
 *
 * 现在打开时只在内存里造一份「base + 临时调整层」的工作文档：
 *   · 拖参数 → 只更新这份工作文档，并推给画布的 previewDoc ref（不进 React 状态）
 *   · 取消   → 把 base 推回去，原文档一个字节没动
 *   · 确定   → 才把这份工作文档落库（一条历史）
 *
 * 两条硬约束：
 *   ① **绝不改 activeLayerId**：React 的 doc 在预览期间也不变，所以调色台 / 图层
 *      选中态 / 历史调色层全都纹丝不动；
 *   ② **预览与结果同源**：工作文档就是最终落库的那份 doc，不会出现「拖的时候
 *      一个样、松手变另一个样」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adjustDef,
  createAdjustLayer,
  newAdjustState,
  type AdjustId,
  type StrataLayer,
} from "../../core/layer";
import type { StrataDoc } from "../../core/document";
import { zh } from "../../i18n";
import DraggableModal from "./DraggableModal";
import { AdjustProps } from "./LayersPanel";
import "./AdjustDialog.css";

interface Props {
  doc: StrataDoc;
  /** 从菜单进来时点名的调整类型 */
  adjustId: AdjustId;
  /** 合成画布：色阶 / 亮度对比度拿它算直方图 */
  compSource?: HTMLCanvasElement | null;
  compVersion?: number;
  /** 拖动参数时的即时预览（不进历史） */
  onPreview: (next: StrataDoc) => void;
  /** 确定：把工作文档落库，进历史 */
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
}

/**
 * 在活动层上方插一层临时调整层 —— 位置规则与 layerOps.spliceAbove 完全一致
 * （选中组时插到组内最上层），**唯一区别是保留 base.activeLayerId**。
 */
function withTempLayer(base: StrataDoc, id: AdjustId): { doc: StrataDoc; layerId: string } {
  const layer = createAdjustLayer(adjustDef(id).label, newAdjustState(id));
  const at = base.layers.findIndex((l) => l.id === base.activeLayerId);
  const cur = at >= 0 ? base.layers[at] : null;
  const parent = cur ? (cur.kind === "group" ? cur.id : (cur.parent ?? null)) : null;
  const placed: StrataLayer = { ...layer, parent };
  const where = cur?.kind === "group" ? at : at < 0 ? base.layers.length : at + 1;
  const layers = [...base.layers];
  layers.splice(where, 0, placed);
  // ⚠️ 不写 activeLayerId：调色台变脸的根因就在 spliceAbove 那一行
  return { doc: { ...base, layers, dirty: true }, layerId: placed.id };
}

export default function AdjustDialog({
  doc,
  adjustId,
  compSource,
  compVersion,
  onPreview,
  onApply,
  onClose,
}: Props) {
  const base = useRef(doc).current;
  const temp = useMemo(() => withTempLayer(base, adjustId), [base, adjustId]);
  const [work, setWork] = useState<StrataDoc>(temp.doc);
  const layer = work.layers.find((l) => l.id === temp.layerId) ?? null;

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedRef = useRef(false);

  /** 工作文档一变就喂给画布：只走 ref，整棵编辑壳不会跟着重渲染。 */
  useEffect(() => {
    previewRef.current(work);
  }, [work]);

  /**
   * 参数还是全默认就不让确定 —— 否则又会落一个「画面完全没变化」的中性层，
   * 那正是用户说的「起效了又没起效」。曲线 / 渐变映射的额外结构一并比较。
   */
  const neutral = layer
    ? JSON.stringify(layer.adjust) === JSON.stringify(newAdjustState(adjustId))
    : true;

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    previewRef.current(base);
    onClose();
  }, [base, onClose]);

  const apply = useCallback(() => {
    if (closedRef.current || neutral) return;
    closedRef.current = true;
    onApply(work);
  }, [work, neutral, onApply]);

  if (!layer) return null;

  return (
    <DraggableModal
      id="adjust"
      title={adjustDef(adjustId).label}
      badge="调整"
      onClose={cancel}
      width={500}
      height={600}
      footer={
        <>
          <span className="ad-note">
            {neutral ? "还没调参数：先拖一下滑杆或曲线" : "确定后生成可随时回改的调整图层"}
          </span>
          <span className="ad-spacer" />
          <button className="btn-ghost" onClick={cancel}>
            {zh.dialog.cancel}
          </button>
          <button className="btn-primary" onClick={apply} disabled={neutral}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="ad">
        <p className="ad-hint">
          参数在这里调好再确定：拖动时画布实时预览，取消则原图一点不变。
          当前选中的图层与右侧调色台都不会被打断。
        </p>
        {/*
          AdjustProps 是属性面板里那套参数 UI（色阶专用编辑器、曲线、渐变映射、
          分通道滑杆都在里面）。这里把它的 doc / layer 换成「工作文档 + 临时层」，
          onChange / onPreview 都只更新弹窗自己的 state —— 于是一条滑杆也不会
          写进历史、更不会碰活动层。确定才由 onApply 统一落库。
        */}
        <AdjustProps
          doc={work}
          layer={layer}
          compSource={compSource ?? null}
          compVersion={compVersion}
          onPreview={setWork}
          onChange={(next) => setWork(next)}
        />
      </div>
    </DraggableModal>
  );
}
