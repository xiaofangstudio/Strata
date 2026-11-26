import { describe, expect, it } from "vitest";
import {
  TIP_MASK_SIZE,
  decodeTipMask,
  encodeTipMask,
  tipAlphaAt,
  validateTipFile,
} from "../../src/core/brushImport";

const fullMask = () => new Uint8Array(TIP_MASK_SIZE * TIP_MASK_SIZE).fill(180);

describe("笔尖图片导入", () => {
  it("只接受真实图像文件，坏文件给出原因", () => {
    expect(validateTipFile({ type: "image/png", size: 1024 })).toBeNull();
    expect(validateTipFile({ type: "text/plain", size: 1024 })).toContain("只支持");
    expect(validateTipFile({ type: "image/png", size: 0 })).toContain("空");
    expect(validateTipFile({ type: "image/png", size: 9 * 1024 * 1024 })).toContain("8 MB");
  });

  it("遮罩编码往返无损，边界值保留", () => {
    const bytes = fullMask();
    bytes[0] = 0;
    bytes[bytes.length - 1] = 255;
    const encoded = encodeTipMask(bytes);
    const decoded = decodeTipMask(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(bytes);
  });

  it("遮罩真的改变笔尖形状，硬度改变边界对比", () => {
    const mask = new Uint8Array(TIP_MASK_SIZE * TIP_MASK_SIZE);
    for (let y = 0; y < TIP_MASK_SIZE; y += 1) {
      for (let x = 0; x < TIP_MASK_SIZE; x += 1) {
        mask[y * TIP_MASK_SIZE + x] = x < TIP_MASK_SIZE / 2 ? 255 : 0;
      }
    }
    expect(tipAlphaAt(mask, 4, 32, 64, 100)).toBe(255);
    expect(tipAlphaAt(mask, 60, 32, 64, 100)).toBe(0);
    const softMask = fullMask().fill(128);
    expect(tipAlphaAt(softMask, 32, 32, 64, 100)).toBeGreaterThan(
      tipAlphaAt(softMask, 32, 32, 64, 0),
    );
  });

  it("坏 base64 / 长度不对 / 尺寸不对一律退回 null", () => {
    expect(decodeTipMask(null)).toBeNull();
    expect(decodeTipMask("")).toBeNull();
    expect(decodeTipMask("!!!not-base64!!!")).toBeNull();
    expect(decodeTipMask(btoa("short"))).toBeNull();
    expect(decodeTipMask("A".repeat(100000))).toBeNull();
    expect(() => encodeTipMask(new Uint8Array(4))).toThrow("尺寸不对");
  });
});
