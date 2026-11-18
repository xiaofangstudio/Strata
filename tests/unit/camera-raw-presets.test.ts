/**
 * Camera Raw 预设存读测试 —— 重点钉死「脏数据不崩」这条。
 * localStorage 是外部输入，一个 NaN / 字符串就能让大窗白屏，必须逐个字段校验。
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESETS,
  deleteUserPreset,
  loadUserPresets,
  presetToAdjust,
  sanitizeParams,
  saveUserPreset,
} from "../../src/core/cameraRawPresets";
import { newAdjustState } from "../../src/core/layer";

/** 内存版 Storage，模拟 localStorage 接口。 */
function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    get size() { return map.size; },
    dump: (k: string) => map.get(k),
  };
}

describe("sanitizeParams", () => {
  it("非对象输入返回全默认", () => {
    for (const bad of [null, undefined, 42, "x", [], true]) {
      expect(sanitizeParams(bad)).toEqual(newAdjustState("cameraraw").params);
    }
  });

  it("只认白名单字段，忽略未知键", () => {
    const out = sanitizeParams({ exposure: 1.5, grain: 99, totallyFake: "x" });
    expect(out.exposure).toBe(1.5);
    expect("grain" in out).toBe(false);
    expect("totallyFake" in out).toBe(false);
  });

  it("NaN / Infinity / 字符串数值被丢弃回默认", () => {
    const out = sanitizeParams({ exposure: NaN, contrast: Infinity, highlights: "20", shadows: 15 });
    expect(out.exposure).toBe(0);
    expect(out.contrast).toBe(0);
    expect(out.highlights).toBe(0);
    expect(out.shadows).toBe(15);
  });

  it("越界值夹到定义域", () => {
    const out = sanitizeParams({ exposure: 99, temperature: -999, vignetteMidpoint: 0 });
    expect(out.exposure).toBe(5);
    expect(out.temperature).toBe(-100);
    expect(out.vignetteMidpoint).toBe(5);
  });
});

describe("内置预设", () => {
  it("每个内置预设都只含合法参数", () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.builtin).toBe(true);
      expect(p.params).toEqual(sanitizeParams(p.params));
    }
  });
  it("原图预设是全中性", () => {
    expect(BUILTIN_PRESETS[0].params).toEqual(newAdjustState("cameraraw").params);
  });
});

describe("用户预设存读", () => {
  it("空存储返回空表", () => {
    expect(loadUserPresets(memStorage())).toEqual([]);
  });

  it("脏 JSON / 非数组 / 无名字条目都不崩", () => {
    for (const raw of ["{not json", "{}", '"str"', '[1,2,3]', '[{"params":{}}]']) {
      const s = memStorage();
      s.setItem("strata.cameraraw.presets", raw);
      expect(() => loadUserPresets(s)).not.toThrow();
      expect(loadUserPresets(s)).toEqual([]);
    }
  });

  it("保存后能读回，参数经校验", () => {
    const s = memStorage();
    expect(saveUserPreset({ name: "我的风格", params: { exposure: 1.2, bad: 9 } }, [], s)).toBe(true);
    const list = loadUserPresets(s);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("我的风格");
    expect(list[0].params.exposure).toBe(1.2);
    expect("bad" in list[0].params).toBe(false);
  });

  it("同名覆盖，不重复", () => {
    const s = memStorage();
    saveUserPreset({ name: "A", params: { contrast: 10 } }, [], s);
    saveUserPreset({ name: "A", params: { contrast: 40 } }, loadUserPresets(s), s);
    const list = loadUserPresets(s);
    expect(list).toHaveLength(1);
    expect(list[0].params.contrast).toBe(40);
  });

  it("空名字不保存", () => {
    const s = memStorage();
    expect(saveUserPreset({ name: "   ", params: {} }, [], s)).toBe(false);
    expect(s.size).toBe(0);
  });

  it("删除指定名字", () => {
    const s = memStorage();
    saveUserPreset({ name: "A", params: {} }, [], s);
    saveUserPreset({ name: "B", params: {} }, loadUserPresets(s), s);
    expect(deleteUserPreset("A", loadUserPresets(s), s)).toBe(true);
    expect(loadUserPresets(s).map((p) => p.name)).toEqual(["B"]);
  });

  it("存储抛异常时不扩散（隐私模式）", () => {
    const boom = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(loadUserPresets(boom)).toEqual([]);
    expect(saveUserPreset({ name: "x", params: {} }, [], boom)).toBe(false);
    expect(deleteUserPreset("x", [], boom)).toBe(false);
  });
});

describe("presetToAdjust", () => {
  it("包成合法的 cameraraw 调整状态", () => {
    const st = presetToAdjust({ exposure: 0.8, garbage: 1 });
    expect(st.id).toBe("cameraraw");
    expect(st.params.exposure).toBe(0.8);
    expect("garbage" in st.params).toBe(false);
  });
});
