/**
 * 主题。
 *
 * 两层结构，故意不合并：
 * - `data-theme` 只有 light / dark —— 组件里几十处 `[data-theme="light"]`
 *   选择器都靠它，动了会全崩；
 * - `data-skin` 是皮肤，叠加在上层只覆盖颜色令牌（见 styles/themes.css）。
 *
 * 「跟随系统」不是一套配色，而是一种策略：监听 prefers-color-scheme，
 * 把 mode 跟着系统切。
 */
import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

/** 皮肤 id（与 themes.css 里的 [data-skin="..."] 一一对应；default = 内置浅/深）。 */
export type ThemeSkin =
  | "default"
  | "pro"
  | "pro-medium"
  | "pro-light-gray"
  | "pro-light"
  | "studio"
  | "studio-light"
  | "classic"
  | "solarized-dark"
  | "adwaita"
  | "adwaita-dark"
  | "breeze-light"
  | "breeze-dark"
  | "soft-light"
  | "soft-dark";

export interface ThemeDef {
  id: ThemeSkin;
  label: string;
  /** 该皮肤要求的底色；default 跟随当前 mode */
  base: ThemeMode | "auto";
  /** 菜单项 id（window.theme.*） */
  menuId: string;
}

/** 全部皮肤，顺序即菜单顺序。 */
export const THEMES: ThemeDef[] = [
  { id: "default", label: "内置主题（跟随系统）", base: "auto", menuId: "window.theme.system" },
  { id: "pro", label: "Pro 主题", base: "dark", menuId: "window.theme.pro" },
  { id: "pro-medium", label: "Pro 中灰", base: "dark", menuId: "window.theme.proMedium" },
  { id: "pro-light-gray", label: "Pro 浅灰", base: "light", menuId: "window.theme.proLightGray" },
  { id: "pro-light", label: "Pro 浅色", base: "light", menuId: "window.theme.proLight" },
  { id: "studio", label: "Studio", base: "dark", menuId: "window.theme.studio" },
  { id: "studio-light", label: "Studio 浅色", base: "light", menuId: "window.theme.studioLight" },
  { id: "classic", label: "经典", base: "light", menuId: "window.theme.classic" },
  { id: "solarized-dark", label: "Solarized Dark", base: "dark", menuId: "window.theme.solarizedDark" },
  { id: "adwaita", label: "Adwaita 浅色", base: "light", menuId: "window.theme.adwaita" },
  { id: "adwaita-dark", label: "Adwaita 深色", base: "dark", menuId: "window.theme.adwaitaDark" },
  { id: "breeze-light", label: "Breeze 浅色", base: "light", menuId: "window.theme.breezeLight" },
  { id: "breeze-dark", label: "Breeze 深色", base: "dark", menuId: "window.theme.breezeDark" },
  { id: "soft-light", label: "柔和浅色", base: "light", menuId: "window.theme.softLight" },
  { id: "soft-dark", label: "柔和深色", base: "dark", menuId: "window.theme.softDark" },
];

const STORAGE_KEY = "strata.theme";
const SKIN_KEY = "strata.skin";
const SYSTEM_KEY = "strata.theme.system";

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* 忽略 */
  }
  return "light";
}

function readSkin(): ThemeSkin {
  try {
    const v = localStorage.getItem(SKIN_KEY);
    if (v && THEMES.some((t) => t.id === v)) return v as ThemeSkin;
  } catch {
    /* 忽略 */
  }
  return "default";
}

function readSystem(): boolean {
  try {
    return localStorage.getItem(SYSTEM_KEY) === "1";
  } catch {
    return false;
  }
}

/** 主题：浅色默认，深色可切，皮肤可选，也能跟随系统。 */
export function useTheme() {
  const [mode, setModeRaw] = useState<ThemeMode>(readMode);
  const [skin, setSkinRaw] = useState<ThemeSkin>(readSkin);
  const [followSystem, setFollowSystem] = useState(readSystem);

  // 跟随系统：监听 prefers-color-scheme，系统变了就把 mode 带过去
  useEffect(() => {
    if (!followSystem) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setModeRaw(mq.matches ? "dark" : "light");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [followSystem]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = mode;
    if (skin === "default") delete root.dataset.skin;
    else root.dataset.skin = skin;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
      localStorage.setItem(SKIN_KEY, skin);
      localStorage.setItem(SYSTEM_KEY, followSystem ? "1" : "0");
    } catch {
      /* 忽略写入失败 */
    }
  }, [mode, skin, followSystem]);

  const setMode = useCallback((m: ThemeMode) => {
    setFollowSystem(false);
    setModeRaw(m);
  }, []);

  const toggle = useCallback(() => {
    setFollowSystem(false);
    setModeRaw((m) => (m === "light" ? "dark" : "light"));
  }, []);

  /** 选一套主题：皮肤 + 它要求的底色一起切（default 走「跟随系统」）。 */
  const setTheme = useCallback((id: ThemeSkin) => {
    const def = THEMES.find((t) => t.id === id);
    if (!def) return;
    if (id === "default") {
      setFollowSystem(true);
      setSkinRaw("default");
      return;
    }
    setFollowSystem(false);
    setSkinRaw(id);
    if (def.base !== "auto") setModeRaw(def.base);
  }, []);

  return { mode, skin, followSystem, setMode, setTheme, setSkin: setSkinRaw, toggle };
}
