/**
 * 自动化相关弹窗：创建 Droplet、脚本事件管理器。
 *
 * 两者共用一个配方编辑器（固定的操作序列勾选 + 参数），这是相对 PS
 * 「任意可编排的动作」的如实简化 —— 配方内核只认这几种真实现了的操作，
 * 界面上就把能勾的都列出来，不画假的自定义编排界面。
 */
import { useCallback, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { zh } from "../../i18n";
import {
  parseRecipe,
  RECIPE_EXTENSION,
  recipeOpLabel,
  type Recipe,
  type RecipeOp,
} from "../../core/recipe";
import { readFileBytes, writeFileBytes } from "../../engine/image";
import Modal from "./Modal";

/* ------------------------------------------------------------ 配方编辑器 */

interface RecipeDraft {
  name: string;
  autoContrast: boolean;
  grayscale: boolean;
  fitOn: boolean;
  fitMaxSide: number;
  exportPng: boolean;
  exportJpg: boolean;
  jpgQuality: number;
}

const DEFAULT_DRAFT: RecipeDraft = {
  name: "我的批处理",
  autoContrast: true,
  grayscale: false,
  fitOn: false,
  fitMaxSide: 1024,
  exportPng: true,
  exportJpg: false,
  jpgQuality: 90,
};

function draftToOps(d: RecipeDraft): RecipeOp[] {
  const ops: RecipeOp[] = [];
  if (d.autoContrast) ops.push({ op: "autoContrast" });
  if (d.grayscale) ops.push({ op: "grayscale" });
  if (d.fitOn) ops.push({ op: "fit", maxSide: Math.max(16, Math.round(d.fitMaxSide)) });
  if (d.exportPng) ops.push({ op: "exportPng" });
  if (d.exportJpg) ops.push({ op: "exportJpg", quality: d.jpgQuality });
  return ops;
}

function draftToRecipe(d: RecipeDraft): Recipe {
  return { kind: "strata-droplet", version: 1, name: d.name || "未命名配方", ops: draftToOps(d) };
}

function RecipeEditor({
  draft,
  onChange,
}: {
  draft: RecipeDraft;
  onChange: (d: RecipeDraft) => void;
}) {
  const set = (patch: Partial<RecipeDraft>) => onChange({ ...draft, ...patch });
  const preview = draftToRecipe(draft);
  return (
    <>
      <label className="field">
        <span className="field-label">配方名称</span>
        <span className="field-input">
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </span>
      </label>
      <div className="pref-tools">
        <label className="pref-tool">
          <input
            type="checkbox"
            checked={draft.autoContrast}
            onChange={(e) => set({ autoContrast: e.target.checked })}
          />
          自动对比度
        </label>
        <label className="pref-tool">
          <input
            type="checkbox"
            checked={draft.grayscale}
            onChange={(e) => set({ grayscale: e.target.checked })}
          />
          转灰度
        </label>
        <label className="pref-tool">
          <input
            type="checkbox"
            checked={draft.fitOn}
            onChange={(e) => set({ fitOn: e.target.checked })}
          />
          长边限制
          <input
            type="number"
            min={16}
            max={8192}
            value={draft.fitMaxSide}
            disabled={!draft.fitOn}
            onChange={(e) => set({ fitMaxSide: Number(e.target.value) || 1024 })}
            style={{ width: 72 }}
          />
          px
        </label>
        <label className="pref-tool">
          <input
            type="checkbox"
            checked={draft.exportPng}
            onChange={(e) => set({ exportPng: e.target.checked })}
          />
          导出 PNG
        </label>
        <label className="pref-tool">
          <input
            type="checkbox"
            checked={draft.exportJpg}
            onChange={(e) => set({ exportJpg: e.target.checked })}
          />
          导出 JPG（质量
          <input
            type="number"
            min={10}
            max={100}
            value={draft.jpgQuality}
            disabled={!draft.exportJpg}
            onChange={(e) => set({ jpgQuality: Number(e.target.value) || 90 })}
            style={{ width: 56 }}
          />
          ）
        </label>
      </div>
      <p className="isz-hint">
        执行顺序固定为勾选顺序：{preview.ops.map(recipeOpLabel).join(" → ") || "（还没勾任何操作）"}。
        处理按扁平合成进行：图层栈先合成一张再执行操作，与批处理的预期一致。
      </p>
    </>
  );
}

/* ------------------------------------------------------------ 创建 Droplet */

interface CreateDropletProps {
  onClose: () => void;
  /** 建好后的提示回调（用编辑壳的 toast）。 */
  onDone: (msg: string) => void;
}

export function CreateDropletDialog({ onClose, onDone }: CreateDropletProps) {
  const [draft, setDraft] = useState<RecipeDraft>(DEFAULT_DRAFT);

  const create = useCallback(async () => {
    const recipe = draftToRecipe(draft);
    if (recipe.ops.length === 0) return;
    try {
      const target = await save({
        defaultPath: `${recipe.name}.${RECIPE_EXTENSION}`,
        filters: [
          { name: "Strata Droplet 配方", extensions: [RECIPE_EXTENSION] },
        ],
      });
      if (typeof target !== "string") return;
      await writeFileBytes(target, new TextEncoder().encode(JSON.stringify(recipe, null, 2)));
      onDone(
        `Droplet 已创建：${target}。双击它就会带着这个配方打开 Strata，把图片拖进窗口即可批处理。`,
      );
      onClose();
    } catch (e) {
      onDone(`创建 Droplet 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [draft, onDone, onClose]);

  return (
    <Modal
      title="创建 Droplet"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={draftToOps(draft).length === 0}
            onClick={() => void create()}
          >
            保存 Droplet 文件…
          </button>
        </>
      }
    >
      <RecipeEditor draft={draft} onChange={setDraft} />
      <p className="isz-hint">
        Droplet 是一个 {RECIPE_EXTENSION} 配方文件：双击它会以「已装载」状态打开 Strata，
        之后拖入（或选择）的每张图都按这个配方处理并导出到你指定的文件夹。
      </p>
    </Modal>
  );
}

/* ------------------------------------------------------ 脚本事件管理器 */

const EVENTS_KEY = "strata.scriptEvents";

export interface ScriptEventMap {
  /** 打开已有文件（sourcePath 非空）时执行 */
  open?: Recipe;
  /** 新建空文档时执行 */
  new?: Recipe;
}

export function loadScriptEvents(): ScriptEventMap {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ScriptEventMap = {};
    for (const key of ["open", "new"] as const) {
      const r = parsed[key];
      if (r) {
        const ok = parseRecipe(JSON.stringify(r));
        if (ok) out[key] = ok;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveScriptEvents(map: ScriptEventMap): void {
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(map));
  } catch {
    /* 存不了就只在本次会话生效 */
  }
}

interface ScriptEventsProps {
  onClose: () => void;
  onDone: (msg: string) => void;
}

export function ScriptEventsDialog({ onClose, onDone }: ScriptEventsProps) {
  const [map, setMap] = useState<ScriptEventMap>(() => loadScriptEvents());

  const pickRecipe = useCallback(
    async (which: "open" | "new") => {
      try {
        const picked = await open({
          multiple: false,
          filters: [{ name: "Strata Droplet 配方", extensions: [RECIPE_EXTENSION] }],
        });
        if (typeof picked !== "string") return;
        const bytes = await readFileBytes(picked);
        const recipe = parseRecipe(new TextDecoder().decode(bytes));
        if (!recipe) {
          onDone("这个文件不是合法的 Strata 配方");
          return;
        }
        const next = { ...map, [which]: recipe };
        setMap(next);
        saveScriptEvents(next);
        onDone(`已把「${recipe.name}」挂到该事件上`);
      } catch (e) {
        onDone(`读取配方失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [map, onDone],
  );

  const clear = useCallback(
    (which: "open" | "new") => {
      const next = { ...map };
      delete next[which];
      setMap(next);
      saveScriptEvents(next);
    },
    [map],
  );

  const rows: { key: "open" | "new"; label: string; hint: string }[] = [
    {
      key: "open",
      label: "打开文档时",
      hint: "任何来源的文件被打开后（启动参数、拖入、最近文件…）立即执行",
    },
    { key: "new", label: "新建文档时", hint: "新建空白画布后立即执行" },
  ];

  return (
    <Modal title="脚本事件管理器" onClose={onClose} width={560}>
      <p className="modal-lead">
        把批处理配方挂到事件上，事件发生时自动对文档执行。配方从 Droplet
        文件里来（先用「创建 Droplet」做一个）。
      </p>
      {rows.map((r) => (
        <section className="pref-sec" key={r.key}>
          <h3 className="pref-h">{r.label}</h3>
          <p className="pref-note">{r.hint}</p>
          <div className="pref-row">
            <span className="pref-val" style={{ minWidth: 0, textAlign: "left", flex: 1 }}>
              {map[r.key] ? `已挂配方：${map[r.key]?.name}` : "未设置"}
            </span>
            <button type="button" className="btn-ghost btn-sm" onClick={() => void pickRecipe(r.key)}>
              选择配方文件…
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={!map[r.key]}
              onClick={() => clear(r.key)}
            >
              清除
            </button>
          </div>
        </section>
      ))}
      <p className="isz-hint">
        说明：导出事件暂不支持（导出入口分散在多条链路上，挂错会静默吞图，宁缺毋滥）。
        配方按扁平合成执行，处理后可直接撤销一步还原。
      </p>
    </Modal>
  );
}
