import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/core/pluginHost";
import {
  pluginActionId,
  pluginPermissionLabel,
  registerPlugin,
  unregisterPlugin,
} from "../../src/core/pluginRegistry";

const raw = {
  manifest: "strata-plugin",
  version: 1,
  id: "com.test.tools",
  name: "测试工具",
  author: "tester",
  pluginVersion: "1.0.0",
  permissions: ["document.read", "document.modify", "file.write"],
  menus: [
    { id: "info", label: "文档信息", actions: [{ command: "document.info" }] },
    {
      id: "scale",
      label: "放大两倍",
      actions: [{ command: "document.scale", params: { percent: 200 } }],
    },
  ],
};

describe("插件会话注册表", () => {
  it("同名插件拒绝覆盖，不会抢菜单命名空间", () => {
    const first = { path: "C:/a.json", parsed: parseManifest(raw) };
    const second = { path: "C:/b.json", parsed: parseManifest(raw) };
    const list = registerPlugin([], first);
    expect(list).toHaveLength(1);
    expect(() => registerPlugin(list, second)).toThrow(/com\.test\.tools/);
  });

  it("卸载只移除指定插件", () => {
    const a = { path: "C:/a.json", parsed: parseManifest(raw) };
    const b = {
      path: "C:/b.json",
      parsed: parseManifest({ ...raw, id: "com.test.other", name: "另一个" }),
    };
    const list = registerPlugin(registerPlugin([], a), b);
    expect(unregisterPlugin(list, "com.test.tools").map((p) => p.parsed.manifest.id)).toEqual([
      "com.test.other",
    ]);
    expect(unregisterPlugin(list, "com.missing")).toHaveLength(2);
  });

  it("菜单 id 唯一且权限显示走本地化文案", () => {
    const plugin = { path: "C:/a.json", parsed: parseManifest(raw) };
    expect(pluginActionId(plugin, "com.test.tools:info")).toBe("plugin.com.test.tools.com.test.tools:info");
    expect(pluginPermissionLabel("document.read")).not.toBe("document.read");
    expect(pluginPermissionLabel("file.write")).not.toBe("file.write");
  });
});
