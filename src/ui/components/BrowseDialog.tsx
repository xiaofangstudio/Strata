/**
 * 浏览（File > Scripts > Browse，对齐 PS 的 Bridge 入口）。
 *
 * 做成真正的文件夹浏览：选一个目录，网格里同时给出子文件夹（可逐级下钻）
 * 与可直接打开的图片 / 工程卡片，缩略图串行解码（与开始页面同一套惯例）。
 * 点图片卡片 = 用与「双击图片」完全相同的通路（engine/openFile.ts）进编辑器。
 */
import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { zh } from "../../i18n";
import { fileStat, loadImage, makeThumbnail } from "../../engine/image";
import { openFileToDoc } from "../../engine/openFile";
import { isOpenablePath } from "../../core/launch";
import { useRecentFiles } from "../../stores/recent";
import type { StrataDoc } from "../../core/document";
import Modal from "./Modal";
import BrandMark from "./BrandMark";
import "./BrowseDialog.css";

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface Props {
  onClose: () => void;
  onOpenDoc: (doc: StrataDoc) => void;
}

/** 父目录；没有更上层时返回 null。 */
function parentOf(p: string): string | null {
  const cut = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (cut <= 0) return null;
  const parent = p.slice(0, cut);
  // 盘根（如 D:）不当作可进入的目录
  return /^[A-Za-z]:$/.test(parent) ? null : parent;
}

export default function BrowseDialog({ onClose, onOpenDoc }: Props) {
  const { push } = useRecentFiles();
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [opening, setOpening] = useState<string | null>(null);
  const runId = useRef(0);

  const load = useCallback(async (target: string) => {
    const id = runId.current + 1;
    runId.current = id;
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<DirEntry[]>("list_dir", { path: target });
      if (runId.current !== id) return;
      // 目录在前、按名排序；文件按名排序
      const dirs = list.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name, "zh"));
      const files = list.filter((e) => !e.isDir && isOpenablePath(e.path)).sort((a, b) => a.name.localeCompare(b.name, "zh"));
      setEntries([...dirs, ...files]);
      setDir(target);
      // 缩略图串行补齐：一张解码完再下一张，不把解码器打爆
      for (const f of files) {
        if (runId.current !== id) return;
        try {
          const bmp = await loadImage(f.path);
          const thumb = await makeThumbnail(bmp);
          bmp.close();
          if (runId.current !== id) return;
          if (thumb) setThumbs((m) => new Map(m).set(f.path, thumb));
        } catch {
          /* 读不出缩略图的文件点开时再如实报错 */
        }
      }
    } catch (e) {
      if (runId.current !== id) return;
      setEntries([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (runId.current === id) setLoading(false);
    }
  }, []);

  const pickFolder = useCallback(async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") void load(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load]);

  const openFile = useCallback(
    async (path: string) => {
      setError(null);
      setOpening(path);
      try {
        const opened = await openFileToDoc(path);
        const stat = await fileStat(path);
        push(path, {
          thumb: opened.thumb,
          mtime: opened.mtime,
          size: stat.exists ? stat.size : undefined,
        });
        onOpenDoc(opened.doc);
      } catch (e) {
        setError(`打不开：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setOpening(null);
      }
    },
    [onOpenDoc, push],
  );

  const parent = dir ? parentOf(dir) : null;
  const dirs = (entries ?? []).filter((e) => e.isDir);
  const files = (entries ?? []).filter((e) => !e.isDir);

  return (
    <Modal title="浏览（Bridge 式文件夹浏览）" onClose={onClose} width={860} height={640}>
      <div className="browse">
        <div className="browse-bar">
          <button type="button" className="btn-ghost btn-sm" onClick={() => void pickFolder()}>
            选择文件夹…
          </button>
          {parent && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => void load(parent)}>
              上一级
            </button>
          )}
          <span className="browse-path" title={dir ?? ""}>
            {dir ? dir : "还没选择文件夹"}
          </span>
        </div>

        {error && (
          <div className="browse-error">
            {error}
            <button type="button" className="banner-close" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        {!dir && !error && (
          <div className="browse-empty">
            <BrandMark size={44} />
            <p>选一个文件夹开始浏览 —— 子文件夹可以逐级点进去，图片点一下就进编辑器。</p>
            <button type="button" className="btn-primary" onClick={() => void pickFolder()}>
              {zh.start.importButton}
            </button>
          </div>
        )}

        {dir && (
          <div className="browse-grid-wrap">
            {loading && entries === null && <p className="browse-note">正在读取文件夹…</p>}
            <div className="browse-grid">
              {dirs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  className="browse-card is-dir"
                  onClick={() => void load(d.path)}
                  title={d.path}
                >
                  <span className="browse-thumb is-folder">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                      />
                    </svg>
                  </span>
                  <span className="browse-name">{d.name}</span>
                </button>
              ))}
              {files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className="browse-card"
                  disabled={opening !== null}
                  onClick={() => void openFile(f.path)}
                  title={`${f.path}（${f.size > 0 ? `${(f.size / 1024).toFixed(0)} KB` : "未知大小"}）`}
                >
                  <span className="browse-thumb">
                    {thumbs.get(f.path) ? (
                      <img src={thumbs.get(f.path)} alt={f.name} />
                    ) : (
                      <BrandMark size={22} />
                    )}
                  </span>
                  <span className="browse-name">
                    {f.name}
                    {opening === f.path && <span className="recent-tag is-busy">打开中…</span>}
                  </span>
                </button>
              ))}
            </div>
            {entries !== null && dirs.length === 0 && files.length === 0 && !loading && (
              <p className="browse-note">这个文件夹里没有能打开的文件（支持图片与 .strata 工程）。</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
