import { describe, expect, it } from "vitest";
import { readPsd, writePsd } from "ag-psd";
import { linkedToSmart, smartToLinked } from "../../src/engine/psd";

describe("PSD 智能对象往返（SoLd/lnk2）", () => {
  const GUID = "20953ddb-9391-11ec-b4f1-c15674f50bc4";

  it("smartToLinked：smartRaw 的原始字节按 mime 还原为 lnk2 条目", () => {
    const bytes = new Uint8Array([0x38, 0x42, 0x49, 0x4d, 0x00, 0xff, 0x10, 0x20]);
    const b64 = Buffer.from(bytes).toString("base64");
    const out = smartToLinked(
      { name: "徽标", smartRaw: `data:application/x-photoshop;base64,${b64}` },
      128,
      64,
      GUID,
    );
    expect(out).not.toBeNull();
    expect(out!.placedLayer.id).toBe(GUID);
    expect(out!.placedLayer.type).toBe("raster");
    expect(out!.placedLayer.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(out!.placedLayer.width).toBe(128);
    expect(out!.linkedFile.type).toBe("imgx");
    expect(out!.linkedFile.name).toBe("徽标.psd");
    expect(Array.from(out!.linkedFile.data!)).toEqual(Array.from(bytes));
  });

  it("没有 smartRaw 时回退 smart 的 PNG 快照，什么都没有返回 null", () => {
    const b64 = Buffer.from([1, 2, 3]).toString("base64");
    const out = smartToLinked({ name: "A", smart: `data:image/png;base64,${b64}` }, 8, 8, GUID);
    expect(out!.linkedFile.type).toBe("png");
    expect(out!.linkedFile.name).toBe("A.png");
    expect(smartToLinked({ name: "B" }, 8, 8, GUID)).toBeNull();
    expect(smartToLinked({ name: "C", smart: "data:image/png;base64," }, 8, 8, GUID)).toBeNull();
  });

  it("linkedToSmart：lnk2 字节 → data URL → 再解码逐位一致", () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 250, 100]);
    const file = { data: bytes, type: "png" as const };
    const out = linkedToSmart(file);
    expect(out).not.toBeNull();
    expect(out!.smartRaw.startsWith("data:image/png;base64,")).toBe(true);
    const back = Buffer.from(out!.smartRaw.split(",")[1], "base64");
    expect(Array.from(back)).toEqual(Array.from(bytes));
    // 空数据不落库。
    expect(linkedToSmart({ data: new Uint8Array(0), type: "png" })).toBeNull();
    expect(linkedToSmart({ data: undefined, type: "png" })).toBeNull();
  });

  it("ag-psd 真字节往返：writePsd → readPsd 后 placedLayer 与 lnk2 原始字节都在", () => {
    const original = new Uint8Array([0x50, 0x53, 0x44, 0x21, 1, 2, 3, 254]);
    const psd = writePsd({
      width: 16,
      height: 16,
      children: [
        {
          name: "SO",
          opacity: 1,
          placedLayer: {
            id: GUID,
            type: "raster",
            transform: [1, 0, 0, 1, 0, 0],
            width: 16,
            height: 16,
          },
        },
      ],
      linkedFiles: [{ id: GUID, name: "so.psd", type: "imgx", data: original }],
    });
    const back = readPsd(psd, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    });
    const so = back.children?.[0];
    expect(so?.placedLayer?.id).toBe(GUID);
    const file = (back.linkedFiles ?? []).find((f) => f.id === GUID);
    expect(file).toBeTruthy();
    expect(Array.from(file!.data!)).toEqual(Array.from(original));
    // 走 Strata 的转换链：lnk2 字节 → smartRaw → smartToLinked → 字节，全程逐位一致。
    const raw = linkedToSmart({ data: file!.data, type: file!.type });
    const relinked = smartToLinked({ name: "SO", smartRaw: raw!.smartRaw }, 16, 16, GUID);
    expect(Array.from(relinked!.linkedFile.data!)).toEqual(Array.from(original));
  });
});
