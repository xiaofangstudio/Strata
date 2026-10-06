import { useEffect, useState } from "react";
import StartPage from "./ui/StartPage";
import EditorShell from "./ui/EditorShell";
import { useTheme } from "./stores/theme";
import { loadAppInfo, type AppInfo } from "./core/appInfo";
import type { StrataDoc } from "./core/document";

/**
 * 应用根组件。
 *
 * 启动即进开始页面；打开文档后切到编辑壳（M0 为只读查看），
 * 关闭文档回到开始页面 —— 程序不退出。
 */
export default function App() {
  const { mode, toggle } = useTheme();
  const [doc, setDoc] = useState<StrataDoc | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let alive = true;
    loadAppInfo().then((it) => {
      if (alive) setInfo(it);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (doc) {
    return <EditorShell doc={doc} onClose={() => setDoc(null)} />;
  }

  return (
    <StartPage
      info={info}
      themeMode={mode}
      onToggleTheme={toggle}
      onOpenDoc={setDoc}
    />
  );
}
