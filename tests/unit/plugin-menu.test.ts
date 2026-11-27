import { describe, expect, it, vi } from "vitest";
import { zh } from "../../src/i18n";
import { parseManifest } from "../../src/core/pluginHost";
import type { LoadedPlugin } from "../../src/core/pluginRegistry";
import { buildPluginMenuGroup } from "../../src/ui/pluginMenu";
import type { MenuAction } from "../../src/ui/components/AppMenuBar";

const raw = {
  manifest: "strata-plugin",
  version: 1,
  id: "com.test.tools",
  name: "测试工具",
  author: "tester",
  pluginVersion: "1.0.0",
  permissions: ["document.read", "document.modify"],
  menus: [
    { id: "info", label: "文档信息", actions: [{ command: "document.info" }] },
    {
      id: "scale",
      label: "放大两倍",
      actions: [{ command: "document.scale", params: { percent: 200 } }],
    },
  ],
};

const handlers = () => ({
  onLoad: vi.fn(),
  onManage: vi.fn(),
  onRun: vi.fn(),
});

describe("插件动态菜单", () => {
  it("没有插件时保留入口但禁用，不做假按钮", () => {
    const h = handlers();
    const group = buildPluginMenuGroup([], h);
    expect(group.key).toBe("plugins");
    expect(group.items[0].kind).toBe("item");
    expect((group.items[0] as MenuAction).disabled).toBe(true);
    const actions = group.items.filter((it) => it.kind === "item") as MenuAction[];
    const load = actions.find((it) => it.label === String(zh.plugin.load));
    const manage = actions.find((it) => it.label === String(zh.plugin.manage));
    expect(load).toBeDefined();
    expect(manage).toBeDefined();
    load?.onSelect?.();
    manage?.onSelect?.();
    expect(h.onLoad).toHaveBeenCalledOnce();
    expect(h.onManage).toHaveBeenCalledOnce();
  });

  it("已加载插件生成子菜单，点击回传真实动作", () => {
    const h = handlers();
    const plugin: LoadedPlugin = { path: "C:/a.json", parsed: parseManifest(raw) };
    const group = buildPluginMenuGroup([plugin], h);
    const pluginRoot = group.items[0] as MenuAction;
    expect(pluginRoot.label).toBe("测试工具");
    expect(pluginRoot.children).toHaveLength(2);

    const info = pluginRoot.children?.[0] as MenuAction;
    expect(info.label).toBe("文档信息");
    info.onSelect?.();
    expect(h.onRun).toHaveBeenCalledOnce();
    expect(h.onRun.mock.calls[0][0]).toBe(plugin);
    expect(h.onRun.mock.calls[0][1].command).toBe("document.info");
    expect(h.onRun.mock.calls[0][2]).toBe("文档信息");
  });
});
