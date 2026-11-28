import { describe, expect, it } from "vitest";
import { installContextMenuGuard } from "../../src/ui/contextMenuGuard";

class FakeTarget {
  readonly handlers: Array<{
    type: string;
    listener: (e: Event) => void;
    capture: boolean;
  }> = [];

  addEventListener(type: string, listener: (e: Event) => void, capture?: boolean) {
    this.handlers.push({ type, listener, capture: Boolean(capture) });
  }

  removeEventListener(type: string, listener: (e: Event) => void, capture?: boolean) {
    const i = this.handlers.findIndex(
      (h) => h.type === type && h.listener === listener && h.capture === Boolean(capture),
    );
    if (i >= 0) this.handlers.splice(i, 1);
  }

  fire(type: string, e: Event) {
    for (const h of [...this.handlers]) {
      if (h.type === type) h.listener(e);
    }
  }
}

describe("全局右键守卫", () => {
  it("window 和 document 捕获阶段都拦截，且不阻止事件继续传播", () => {
    const win = new FakeTarget();
    const doc = new FakeTarget();
    const dispose = installContextMenuGuard(win, doc);

    expect(win.handlers).toHaveLength(1);
    expect(doc.handlers).toHaveLength(1);
    expect(win.handlers[0].capture).toBe(true);
    expect(doc.handlers[0].capture).toBe(true);

    let defaultPrevented = false;
    const event = {
      type: "contextmenu",
      preventDefault() {
        defaultPrevented = true;
      },
      stopPropagation() {
        throw new Error("不许吞掉事件，否则我们自己的右键菜单也弹不出来");
      },
    } as unknown as Event;

    win.fire("contextmenu", event);
    doc.fire("contextmenu", event);
    expect(defaultPrevented).toBe(true);

    dispose();
    expect(win.handlers).toHaveLength(0);
    expect(doc.handlers).toHaveLength(0);
  });
});
