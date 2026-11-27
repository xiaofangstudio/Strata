import { describe, expect, it } from "vitest";
import { decodeTiff } from "../../src/engine/tiff";
import {
  pngBitDepth,
  sourceBitDepth,
  tiffBitsPerSample,
} from "../../src/core/bitDepth";

/** 手构一张 16bit 无压缩灰度 TIFF（小端 II、黑为零），喂给自研解码器。 */
function buildTiff16Gray(samples: number[], w: number, h: number): Uint8Array {
  const entries = 10;
  const ifdOffset = 8;
  const ifdSize = 2 + entries * 12 + 4;
  const dataOffset = ifdOffset + ifdSize;
  const out = new Uint8Array(dataOffset + samples.length * 2);
  const view = new DataView(out.buffer);

  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);

  const put = (i: number, tag: number, type: number, count: number, value: number) => {
    const p = ifdOffset + 2 + i * 12;
    view.setUint16(p, tag, true);
    view.setUint16(p + 2, type, true);
    view.setUint32(p + 4, count, true);
    view.setUint32(p + 8, value, true);
  };
  view.setUint16(ifdOffset, entries, true);
  put(0, 256, 4, 1, w); // ImageWidth
  put(1, 257, 4, 1, h); // ImageLength
  put(2, 258, 3, 1, 16); // BitsPerSample（内联 SHORT）
  put(3, 259, 3, 1, 1); // Compression = 无压缩
  put(4, 262, 3, 1, 1); // Photometric = 黑为零灰度
  put(5, 273, 4, 1, dataOffset); // StripOffsets
  put(6, 277, 3, 1, 1); // SamplesPerPixel = 灰度
  put(7, 278, 4, 1, h); // RowsPerStrip
  put(8, 279, 4, 1, samples.length * 2); // StripByteCounts
  put(9, 284, 3, 1, 1); // PlanarConfiguration
  view.setUint32(ifdOffset + 2 + entries * 12, 0, true);

  for (let i = 0; i < samples.length; i += 1) view.setUint16(dataOffset + i * 2, samples[i], true);
  return out;
}

/** 手构 PNG 头：签名 + IHDR（bit depth 在 offset 24）。 */
function buildPngHeader(depth: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13);
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, 4); // width
  view.setUint32(20, 4); // height
  out[24] = depth;
  return out;
}

describe("位深探测与 TIFF16", () => {
  it("PNG 头位深：8 / 16 如实读出，坏头返回 null", () => {
    expect(pngBitDepth(buildPngHeader(16))).toBe(16);
    expect(pngBitDepth(buildPngHeader(8))).toBe(8);
    expect(pngBitDepth(new Uint8Array(64))).toBeNull();
    expect(pngBitDepth(buildPngHeader(3))).toBeNull();
  });

  it("TIFF BitsPerSample 轻解析：内联 SHORT 读到 16", () => {
    const bytes = buildTiff16Gray([1024], 1, 1);
    expect(tiffBitsPerSample(bytes)).toBe(16);
    // 不是 TIFF 的字节返回 null。
    expect(tiffBitsPerSample(new Uint8Array(64))).toBeNull();
  });

  it("sourceBitDepth 统一入口：tif/png 各归各位，未知格式按 8", () => {
    expect(sourceBitDepth("tif", buildTiff16Gray([1], 1, 1))).toBe(16);
    expect(sourceBitDepth("png", buildPngHeader(16))).toBe(16);
    expect(sourceBitDepth("png", buildPngHeader(8))).toBe(8);
    expect(sourceBitDepth("jpg", new Uint8Array(16))).toBe(8);
  });

  it("16bit 解码走精确舍入（/257）而不是取高字节，并如实返回 depth=16", async () => {
    // 0→0；257→1（取高字节也是 1，无法区分）；65535→255；32768→128（高字节是 127，能区分）；
    // 32767→127（高字节也是 127）；256→1（高字节是 1）；255→1（高字节是 0，能区分）。
    const samples = [0, 257, 65535, 32768, 32767, 256, 255];
    const img = await decodeTiff(buildTiff16Gray(samples, samples.length, 1));
    expect(img.depth).toBe(16);
    expect(Array.from(img.rgba.slice(0, samples.length * 4))).toEqual(
      samples.flatMap((v) => {
        const g = Math.round((v * 255) / 65535);
        return [g, g, g, 255];
      }),
    );
    // 上面这些样本里至少有一处与「取高字节」不同，防止测试恒真。
    const hiByteOnly = samples.map((v) => (v >> 8) & 0xff);
    expect(hiByteOnly).not.toEqual(samples.map((v) => Math.round((v * 255) / 65535)));
  });

  it("8bit TIFF 仍按原语义解码，depth=8", async () => {
    const entries = 10;
    const ifdOffset = 8;
    const ifdSize = 2 + entries * 12 + 4;
    const dataOffset = ifdOffset + ifdSize;
    const out = new Uint8Array(dataOffset + 2);
    const view = new DataView(out.buffer);
    out[0] = 0x49;
    out[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, ifdOffset, true);
    const put = (i: number, tag: number, type: number, count: number, value: number) => {
      const p = ifdOffset + 2 + i * 12;
      view.setUint16(p, tag, true);
      view.setUint16(p + 2, type, true);
      view.setUint32(p + 4, count, true);
      view.setUint32(p + 8, value, true);
    };
    view.setUint16(ifdOffset, entries, true);
    put(0, 256, 4, 1, 2);
    put(1, 257, 4, 1, 1);
    put(2, 258, 3, 1, 8);
    put(3, 259, 3, 1, 1);
    put(4, 262, 3, 1, 1);
    put(5, 273, 4, 1, dataOffset);
    put(6, 277, 3, 1, 1);
    put(7, 278, 4, 1, 1);
    put(8, 279, 4, 1, 2);
    put(9, 284, 3, 1, 1);
    view.setUint32(ifdOffset + 2 + entries * 12, 0, true);
    out[dataOffset] = 10;
    out[dataOffset + 1] = 250;
    const img = await decodeTiff(out);
    expect(img.depth).toBe(8);
    expect(Array.from(img.rgba.slice(0, 8))).toEqual([10, 10, 10, 255, 250, 250, 250, 255]);
  });
});
