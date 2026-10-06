import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "strata.theme";

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* 存储不可用时忽略，退回默认 */
  }
  return "light";
}

/** 主题：浅色默认，深色可切，选择记在本地。 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readStored);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* 忽略写入失败 */
    }
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((m) => (m === "light" ? "dark" : "light"));
  }, []);

  return { mode, setMode, toggle };
}
