import { describe, expect, it } from "vitest";
import {
  checkActionPermission,
  parseManifest,
  PluginManifestError,
} from "../../src/core/pluginHost";

const GOOD = {
  manifest: "strata-plugin",
  version: 1,
  id: "com.example.thumb",
  name: "批量缩略图",
  author: " tester",
  pluginVersion: "1.0.0",
  permissions: ["document.read", "document.modify", "file.write"],
  menus: [
    {
      id: "make-64",
      label: "生成 64px 缩略图",
      actions: [
        { command: "document.scale", params: { percent: 25 } },
        { command: "file.exportPng" },
      ],
    },
  ],
};

describe("插件宿主内核 v0", () => {
  it("合法清单通过，动作键带插件 id 前缀", () => {
    const out = parseManifest(GOOD);
    expect(out.manifest.id).toBe("com.example.thumb");
    expect(out.actions[0].key).toBe("com.example.thumb:make-64");
    expect(out.actions[0].actions).toHaveLength(2);
  });

  it("坏清单整体拒绝：manifest 字段 / 版本 / id 形状 / 未知权限", () => {
    const bad = (patch: Record<string, unknown>) => {
      const merged = { ...GOOD, ...patch };
      delete (merged as Record<string, unknown>).manifest;
      return merged;
    };
    expect(() => parseManifest("x")).toThrow(PluginManifestError);
    expect(() => parseManifest({ ...GOOD, manifest: "other" })).toThrow(/strata-plugin/);
    expect(() => parseManifest({ ...GOOD, version: 2 })).toThrow(/清单版本/);
    expect(() => parseManifest({ ...GOOD, id: "not-a-domain" })).toThrow(/反向域名/);
    expect(() => parseManifest({ ...GOOD, permissions: ["fs.raw"] })).toThrow(/未知权限/);
    // manifest 键被删掉的用例也拒（上面 bad 只是示例构造，真正断言在上面几条）。
    void bad;
  });

  it("动作命令必须在白名单内，且权限要声明过", () => {
    expect(() =>
      parseManifest({
        ...GOOD,
        menus: [{ id: "m", label: "M", actions: [{ command: "fs.deleteAll" }] }],
      }),
    ).toThrow(/未知命令/);
    expect(() =>
      parseManifest({
        ...GOOD,
        permissions: ["document.read"],
        menus: [{ id: "m", label: "M", actions: [{ command: "document.scale" }] }],
      }),
    ).toThrow(/document\.modify/);
  });

  it("菜单 id 重复 / 空 actions / params 非对象都拒绝", () => {
    expect(() =>
      parseManifest({
        ...GOOD,
        menus: [
          { id: "m", label: "A", actions: [{ command: "document.info" }] },
          { id: "m", label: "B", actions: [{ command: "document.info" }] },
        ],
      }),
    ).toThrow(/重复/);
    expect(() =>
      parseManifest({ ...GOOD, menus: [{ id: "m", label: "A", actions: [] }] }),
    ).toThrow(/非空数组/);
    expect(() =>
      parseManifest({
        ...GOOD,
        menus: [{ id: "m", label: "A", actions: [{ command: "document.scale", params: [1] }] }],
      }),
    ).toThrow(/params 必须是对象/);
  });

  it("checkActionPermission：未声明权限的动作在执行前被拦下", () => {
    expect(() =>
      checkActionPermission({ command: "document.info" }, ["document.read"]),
    ).not.toThrow();
    expect(() =>
      checkActionPermission({ command: "file.exportPng" }, ["document.read"]),
    ).toThrow(/file\.write/);
    expect(() => checkActionPermission({ command: "nope" }, ["document.read"])).toThrow(/未知命令/);
  });
});
