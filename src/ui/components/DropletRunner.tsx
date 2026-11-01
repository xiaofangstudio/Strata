/**
 * Droplet 运行器：双击 .strata-droplet 文件后，Strata 以这个界面启动。
 *
 * 工作方式与 PS 的 Droplet 同构：配方已装载 → 用户拖入（或选择）一批图片 →
 * 每张图按配方处理并导出到指定文件夹 → 逐条给出成功 / 失败结果。
 * 关掉窗口 = 卸下配方，回到普通启动。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  recipeOpLabel,
  runRecipeDocOps,
  type Recipe,
  type RecipeOp,
} from "../../core/recipe";
import { openFileToDoc } from "../../engine/openFile";
import { encodePng } from "../../engine/image";
import { isOpenablePath } from "../../core/launch";
import BrandMark from "./BrandMark";
import "./DropletRunner.css";

interface Props {
  recipe: Recipe;
  onClose: () => void;
}

interface Result {
  file: string;
  ok: boolean;
  msg: string;
}

async function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality / 100),
  );
  if (!blob) throw new Error("JPG 编码失败");
  return new Uint8Array(await blob.arrayBuffer());
}

export default function DropletRunner({ recipe, onClose }: Props) {
  const [outDir, setOutDir] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const runRef = useRef<(paths: string[]) => void>(() => {});

  const pickOutDir = useCallback(async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") setOutDir(picked);
    } catch {
      /* 用户取消 */
    }
  }, []);

  const runFiles = useCallback(
    async (paths: string[]) => {
      if (!outDir || paths.length === 0) return;
      setRunning(true);
      const acc: Result[] = [];
      for (const p of paths) {
        try {
          const opened = await openFileToDoc(p);
          const { doc, exports } = runRecipeDocOps(opened.doc, recipe);
          if (exports.length === 0) {
            acc.push({ file: p, ok: false, msg: "配方里没有导出步骤，图处理了但没落到磁盘" });
            continue;
          }
          const layer = doc.layers[0];
          const canvas = layer.surface;
          for (const ex of exports) {
            const stem = p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "output";
            if (ex.op === "exportPng") {
              const bytes = await encodePng(canvas);
              const target = `${outDir.replace(/[\\/]+$/, "")}/${stem}.png`;
              const { writeFileBytes } = await import("../../engine/image");
              await writeFileBytes(target, bytes);
            } else if (ex.op === "exportJpg") {
              const bytes = await encodeJpeg(canvas, ex.quality);
              const target = `${outDir.replace(/[\\/]+$/, "")}/${stem}.jpg`;
              const { writeFileBytes } = await import("../../engine/image");
              await writeFileBytes(target, bytes);
            }
          }
          acc.push({
            file: p,
            ok: true,
            msg: exports.map((e: RecipeOp) => recipeOpLabel(e)).join(" + "),
          });
        } catch (e) {
          acc.push({
            file: p,
            ok: false,
            msg: e instanceof Error ? e.message : String(e),
          });
        }
        setResults([...acc]);
      }
      setRunning(false);
    },
    [outDir, recipe],
  );

  const pickFiles = useCallback(async () => {
    try {
      const picked = await open({
        multiple: true,
        filters: [
          {
            name: "图片",
            extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"],
          },
        ],
      });
      const list = picked ? (Array.isArray(picked) ? picked : [picked]) : [];
      if (list.length) void runFiles(list);
    } catch {
      /* 用户取消 */
    }
  }, [runFiles]);

  runRef.current = runFiles;

  // Tauri 接管窗口级拖放，必须走 webview 事件才能拿到真实路径
  //（HTML5 drop 在 v2 里只有文件名没有路径）。与开始页面同一套惯例。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const fn = await getCurrentWebview().onDragDropEvent((ev) => {
          if (ev.payload.type === "over") {
            setDragging(true);
          } else if (ev.payload.type === "leave") {
            setDragging(false);
          } else if (ev.payload.type === "drop") {
            setDragging(false);
            const paths = ev.payload.paths.filter(isOpenablePath);
            if (paths.length) runRef.current(paths);
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch {
        /* 浏览器预览等场景没有该 API，降级为只用对话框选择 */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className={dragging ? "droplet is-drag" : "droplet"}>
      <div className="droplet-card">
        <div className="droplet-head">
          <BrandMark size={34} />
          <div>
            <h1 className="droplet-title">Droplet 已装载：{recipe.name}</h1>
            <p className="droplet-ops">{recipe.ops.map(recipeOpLabel).join(" → ")}</p>
          </div>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} title="卸下配方">
            卸下配方
          </button>
        </div>

        <div className="droplet-body">
          <button type="button" className="btn-ghost btn-sm" onClick={() => void pickOutDir()}>
            选择导出文件夹…
          </button>
          <span className="droplet-dir" title={outDir ?? ""}>
            {outDir ?? "还没选 —— 处理结果会导到这里"}
          </span>

          <div className="droplet-drop">
            {running ? (
              <p>正在处理…</p>
            ) : (
              <>
                <p>把图片拖到这里，或</p>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!outDir}
                  onClick={() => void pickFiles()}
                >
                  选择要处理的图片
                </button>
              </>
            )}
          </div>

          {!outDir && <p className="droplet-warn">先选好导出文件夹，再拖图进来。</p>}

          {results.length > 0 && (
            <ul className="droplet-results">
              {results.map((r, i) => (
                <li key={i} className={r.ok ? "is-ok" : "is-bad"}>
                  <span className="droplet-file">{r.file}</span>
                  <span className="droplet-msg">{r.msg}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="droplet-note">
            配方按扁平合成处理（图层栈先合成一张再执行）。处理只读源文件并写导出文件夹，
            不会改动原图；支持 PNG / JPG / WebP / BMP / GIF / TIFF。
          </p>
        </div>
      </div>
    </div>
  );
}
