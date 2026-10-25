import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import StartPage from "./ui/StartPage";
import EditorShell from "./ui/EditorShell";
import { useTheme } from "./stores/theme";
import { loadAppInfo, type AppInfo } from "./core/appInfo";
import { applyEntry, captureDoc, History } from "./core/history";
import { zh } from "./i18n/zh-CN";
import type { StrataDoc } from "./core/document";
import { IMAGE_EXTENSIONS, extOf } from "./engine/image";
import { STRATA_EXTENSION } from "./engine/project";

/**
 * 应用根组件。
 *
 * 启动即进开始页面；打开文档后切到编辑壳。文档以多标签页并存，
 * 每一份文档各带一套撤销栈（History），互不干扰。
 * 全部文档关闭后回到开始页面 —— 程序不退出。
 */
export default function App() {
  const { mode, setMode, toggle } = useTheme();
  const [docs, setDocs] = useState<StrataDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  /** 撤销栈状态变更的计数器：History 是可变对象，靠它触发重渲染 */
  const [revision, setRevision] = useState(0);
  /** 启动时被命令行参数指定的待打开文件（双击 .strata 等场景）。 */
  const [launchPath, setLaunchPath] = useState<string | null>(null);

  const stacks = useRef(new Map<string, History>());
  const activeRef = useRef<string | null>(null);
  const docsRef = useRef<StrataDoc[]>([]);
  activeRef.current = activeId;
  docsRef.current = docs;

  useEffect(() => {
    let alive = true;
    loadAppInfo().then((it) => {
      if (alive) setInfo(it);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 启动参数里若带着一个可打开的文件（双击 .strata / 图片触发），
  // 交给开始页面按对应方式打开。读不到参数就静默跳过，不影响正常启动。
  useEffect(() => {
    let alive = true;
    invoke<string[]>("initial_open_args")
      .then((args) => {
        if (!alive) return;
        const hit = args.find(
          (a) =>
            IMAGE_EXTENSIONS.includes(extOf(a)) ||
            a.toLowerCase().endsWith(`.${STRATA_EXTENSION}`),
        );
        if (hit) setLaunchPath(hit);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** 打开一份新文档：挂上它自己的撤销栈，并置为当前标签页。 */
  const openDoc = useCallback((doc: StrataDoc) => {
    const stack = new History();
    stack.reset(captureDoc(doc, zh.editor.open));
    stacks.current.set(doc.id, stack);
    setDocs((prev) => [...prev, doc]);
    setActiveId(doc.id);
    setRevision((n) => n + 1);
  }, []);

  /** 关闭某份文档；关掉的是当前页时，焦点落到剩下的最后一份。 */
  const closeDoc = useCallback((id: string) => {
    stacks.current.delete(id);
    const next = docsRef.current.filter((d) => d.id !== id);
    setDocs(next);
    if (activeRef.current === id) {
      setActiveId(next.length > 0 ? next[next.length - 1].id : null);
    }
    setRevision((n) => n + 1);
  }, []);

  const selectDoc = useCallback((id: string) => setActiveId(id), []);

  /** 关闭全部文档：一次性清空标签与各自的撤销栈，回到开始页面。 */
  const closeAll = useCallback(() => {
    stacks.current.clear();
    setDocs([]);
    setActiveId(null);
    setRevision((n) => n + 1);
  }, []);

  /** 落一步可撤销的改动：先入栈，再更新文档。 */
  const commit = useCallback((next: StrataDoc, label: string) => {
    stacks.current.get(next.id)?.commit(captureDoc(next, label));
    setDocs((prev) => prev.map((d) => (d.id === next.id ? next : d)));
    setRevision((n) => n + 1);
  }, []);

  /** 只改画面、不入栈（拖滑杆、切选中这类即时预览）。 */
  const preview = useCallback((next: StrataDoc) => {
    setDocs((prev) => prev.map((d) => (d.id === next.id ? next : d)));
  }, []);

  const step = useCallback((dir: "undo" | "redo") => {
    const id = activeRef.current;
    if (!id) return;
    const stack = stacks.current.get(id);
    const entry = dir === "undo" ? stack?.undo() : stack?.redo();
    if (!entry) return;
    setDocs((prev) => prev.map((d) => (d.id === id ? applyEntry(d, entry) : d)));
    setRevision((n) => n + 1);
  }, []);

  const undo = useCallback(() => step("undo"), [step]);
  const redo = useCallback(() => step("redo"), [step]);

  /**
   * 历史面板点某一步：不认方向，只认落点。
   * 越界或点的是当前这一步，jumpTo 返回 null，这里直接跳过，不做无谓重绘。
   */
  const jumpHistory = useCallback((index: number) => {
    const id = activeRef.current;
    if (!id) return;
    const entry = stacks.current.get(id)?.jumpTo(index);
    if (!entry) return;
    setDocs((prev) => prev.map((d) => (d.id === id ? applyEntry(d, entry) : d)));
    setRevision((n) => n + 1);
  }, []);

  const doc = activeId === null ? null : docs.find((d) => d.id === activeId) ?? null;

  if (doc) {
    const stack = stacks.current.get(doc.id);
    return (
      <EditorShell
        docs={docs}
        doc={doc}
        info={info}
        themeMode={mode}
        onSetTheme={setMode}
        onSelectDoc={selectDoc}
        onCloseDoc={closeDoc}
        onCloseAll={closeAll}
        onOpenDoc={openDoc}
        onCommit={commit}
        onPreview={preview}
        onUndo={undo}
        onRedo={redo}
        canUndo={Boolean(stack?.canUndo)}
        canRedo={Boolean(stack?.canRedo)}
        historyLabels={stack ? stack.labels() : []}
        historyIndex={stack ? stack.index : -1}
        onHistoryJump={jumpHistory}
        revision={revision}
      />
    );
  }

  return (
    <StartPage
      info={info}
      themeMode={mode}
      onToggleTheme={toggle}
      onOpenDoc={openDoc}
      initialPath={launchPath}
    />
  );
}
