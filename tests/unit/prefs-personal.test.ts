/**
 * 个性化偏好解析测试。
 *
 * `read()` 在模块加载时从 localStorage 解析，这里用 stub + resetModules
 * 在每次测试里重跑模块，验证 7 个个性化字段的默认值回退与越界夹取。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeStorage());
  vi.resetModules();
});

describe("prefs · 个性化字段默认回退", () => {
  it("localStorage 为空时，7 个个性化字段落在出厂默认值", async () => {
    const { currentPrefs, DEFAULT_PREFS } = await import("../../src/stores/prefs");
    const p = currentPrefs();
    expect(p.bgImage).toBe(DEFAULT_PREFS.bgImage);
    expect(p.bgFrost).toBe(80);
    expect(p.globalFrost).toBe(false);
    expect(p.windowFrost).toBe(false);
    expect(p.frostColor).toBe("#3d6bff");
    expect(p.uiFont).toBe("");
    expect(p.uiScale).toBe(100);
  });
});

describe("prefs · 个性化字段解析与夹取", () => {
  it("合法值被原样采用，越界/类型错误被夹取或回退默认", async () => {
    localStorage.setItem(
      "strata.prefs",
      JSON.stringify({
        bgImage: "C:\\Users\\me\\bg.png",
        bgFrost: 130, // 越界 → 夹到 100
        globalFrost: true,
        windowFrost: "yes", // 非布尔 → 回退默认 false
        frostColor: "#ff0000",
        uiFont: "song",
        uiScale: 200, // 越界 → 夹到 140
      }),
    );

    const { currentPrefs } = await import("../../src/stores/prefs");
    const p = currentPrefs();
    expect(p.bgImage).toBe("C:\\Users\\me\\bg.png");
    expect(p.bgFrost).toBe(100);
    expect(p.globalFrost).toBe(true);
    expect(p.windowFrost).toBe(false);
    expect(p.frostColor).toBe("#ff0000");
    expect(p.uiFont).toBe("song");
    expect(p.uiScale).toBe(140);
  });

  it("背景磨砂与 UI 缩放在合法边界内不被夹取", async () => {
    localStorage.setItem(
      "strata.prefs",
      JSON.stringify({ bgFrost: 0, uiScale: 80 }),
    );
    const { currentPrefs } = await import("../../src/stores/prefs");
    const p = currentPrefs();
    expect(p.bgFrost).toBe(0);
    expect(p.uiScale).toBe(80);
  });
});

describe("prefs · UI 字体回退栈", () => {
  it("UI_FONT_STACKS 覆盖空（系统默认）与 6 种命名字体", async () => {
    const { UI_FONT_STACKS } = await import("../../src/stores/prefs");
    expect(UI_FONT_STACKS[""]).toContain("Microsoft YaHei");
    for (const id of ["yahei", "pingfang", "segoe", "source-han", "dengxian", "song"]) {
      expect(typeof UI_FONT_STACKS[id]).toBe("string");
      expect(UI_FONT_STACKS[id].length).toBeGreaterThan(0);
    }
  });
});

describe("prefs · 真正半透明玻璃与动效档位", () => {
  it("默认玻璃参数与动效档位", async () => {
    const { currentPrefs } = await import("../../src/stores/prefs");
    const p = currentPrefs();
    expect(p.glassAlpha).toBe(18);
    expect(p.glassBlur).toBe(22);
    expect(p.glassSat).toBe(165);
    expect(p.glassSheen).toBe(18);
    expect(p.motion).toBe("full");
  });

  it("玻璃参数越界夹取、动效只认三档", async () => {
    localStorage.setItem(
      "strata.prefs",
      JSON.stringify({
        glassAlpha: 90, // → 45
        glassBlur: 1, // → 8
        glassSat: 500, // → 200
        glassSheen: -10, // → 0
        motion: "bogus", // → full
      }),
    );
    const { currentPrefs } = await import("../../src/stores/prefs");
    const p = currentPrefs();
    expect(p.glassAlpha).toBe(45);
    expect(p.glassBlur).toBe(8);
    expect(p.glassSat).toBe(200);
    expect(p.glassSheen).toBe(0);
    expect(p.motion).toBe("full");
  });

  it("reduced / off 两档被保留", async () => {
    for (const m of ["reduced", "off"]) {
      vi.resetModules();
      localStorage.setItem("strata.prefs", JSON.stringify({ motion: m }));
      const { currentPrefs } = await import("../../src/stores/prefs");
      expect(currentPrefs().motion).toBe(m);
    }
  });
});
