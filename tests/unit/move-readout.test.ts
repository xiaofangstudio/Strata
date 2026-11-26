import { describe, expect, it } from "vitest";
import { moveReadout, moveReadoutText } from "../../src/core/moveReadout";

describe("移动方向距离读数（移植自 PhotoCraft）", () => {
  it("左右上下按箭头分方向，距离取绝对值并四舍五入", () => {
    expect(moveReadout(10.4, -2.6)).toEqual([
      { arrow: "→", text: "10 px" },
      { arrow: "↑", text: "3 px" },
    ]);
    expect(moveReadout(-10.4, 2.6)).toEqual([
      { arrow: "←", text: "10 px" },
      { arrow: "↓", text: "3 px" },
    ]);
  });

  it("零横 / 纵位移分别按 → / ↓ 显示", () => {
    expect(moveReadout(0, 0)).toEqual([
      { arrow: "→", text: "0 px" },
      { arrow: "↓", text: "0 px" },
    ]);
    expect(moveReadoutText(10, -3)).toBe("→ 10 px  ↑ 3 px");
  });
});
