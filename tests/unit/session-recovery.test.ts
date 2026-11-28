import { describe, expect, it } from "vitest";
import { recoveryKey } from "../../src/engine/sessionRecovery";

describe("自动恢复稿 key", () => {
  it("只含 Rust valid_key 允许的字符", () => {
    const key = recoveryKey({
      id: "doc-mn123-7",
      name: "测试",
      width: 1,
      height: 1,
      layers: [],
      activeLayerId: "",
    } as never);
    expect(key).toBe("sess-doc-mn123-7");
    expect(/^[A-Za-z0-9_-]+$/.test(key)).toBe(true);
    expect(key.length).toBeLessThanOrEqual(128);
  });
});
