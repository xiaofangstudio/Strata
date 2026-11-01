/**
 * GIF 编码器（engine/gif.ts）。
 *
 * 编码器写对了没有，光看文件头不够 —— 这里带了一个完整的 GIF-LZW 解码器，
 * 把编码结果逐位解回调色板下标流，与编码前的下标流逐字节对账。
 * 这是「点了就真的有反应」在导出链路上的等价物：解不出来或对不上就是错的。
 */
import { describe, expect, it } from "vitest";
import {
  encodeGif,
  gifHeaderInfo,
  lzwEncode,
  quantizeFrame,
  type GifFrame,
} from "../../src/engine/gif";

/* ---------------- 测试用 GIF-LZW 解码器（只在这一处存在，不进 src） ---------------- */

function lzwDecode(minCodeSize: number, data: number[]): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  for (let i = 0; i < clear; i += 1) dict.push([i]);
  dict.push([]);
  dict.push([]);
  let next = eoi + 1;

  const out: number[] = [];
  let bitPos = 0;
  let prev: number[] | null = null;

  const read = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) throw new Error("码流越界");
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos += 1;
    }
    return code;
  };

  for (;;) {
    const code = read();
    if (code === eoi) break;
    if (code === clear) {
      dict = [];
      for (let i = 0; i < clear; i += 1) dict.push([i]);
      dict.push([]);
      dict.push([]);
      next = eoi + 1;
      codeSize = minCodeSize + 1;
      prev = null;
      continue;
    }
    let entry: number[];
    if (code < dict.length && code < eoi + (next - eoi)) {
      entry = dict[code];
    } else if (prev) {
      entry = [...prev, prev[0]];
    } else {
      throw new Error(`码 ${code} 无法解析`);
    }
    out.push(...entry);
    if (prev) {
      if (next < 4096) {
        dict[next] = [...prev, entry[0]];
        next += 1;
        // 与编码器（先判满再自增的 B 规则）在流上恰好对齐：
        // 解码器加完条目后 next 顶满 2^codeSize，下一个码就要多读一位
        if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
      }
    }
    prev = entry;
  }
  return new Uint8Array(out);
}

/** 从 GIF 文件里取出某帧的 LZW 码流（测试辅助）。 */
function frameLzw(bytes: Uint8Array, frameIndex: number): { min: number; data: number[] } {
  let p = 13;
  let seen = 0;
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3b) break;
    if (b === 0x21) {
      p += 2;
      while (bytes[p] !== 0) p += bytes[p] + 1;
      p += 1;
      continue;
    }
    if (b === 0x2c) {
      const packed = bytes[p + 9];
      p += 10;
      if (packed & 0x80) p += 3 * (2 << (packed & 7));
      const min = bytes[p];
      p += 1;
      const data: number[] = [];
      while (bytes[p] !== 0) {
        const n = bytes[p];
        for (let i = 1; i <= n; i += 1) data.push(bytes[p + i]);
        p += n + 1;
      }
      p += 1;
      if (seen === frameIndex) return { min, data };
      seen += 1;
      continue;
    }
    p += 1;
  }
  throw new Error(`没有第 ${frameIndex} 帧`);
}

/* ------------------------------------------------------------------ 用例 */

function solidFrame(w: number, h: number, rgb: [number, number, number], delay = 0.1): GifFrame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, delay };
}

describe("LZW 往返", () => {
  it("平坦数据：编码后能原样解回", () => {
    const src = new Uint8Array(64).fill(7);
    expect([...lzwDecode(8, lzwEncode(src, 8))]).toEqual([...src]);
  });

  it("重复图案（最考验字典增长）", () => {
    const src = new Uint8Array(256);
    for (let i = 0; i < src.length; i += 1) src[i] = i % 5;
    expect([...lzwDecode(8, lzwEncode(src, 8))]).toEqual([...src]);
  });

  it("伪随机数据 + 走满 12 位码长再重置字典", () => {
    // 4096 个码之后必须发清除码重置；数据量足够大才会走到
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) & 0xff;
    };
    const src = new Uint8Array(20000);
    for (let i = 0; i < src.length; i += 1) src[i] = rnd() % 200;
    expect([...lzwDecode(8, lzwEncode(src, 8))]).toEqual([...src]);
  });

  it("空输入也产出合法码流（清屏 + 结束）", () => {
    const data = lzwEncode(new Uint8Array(0), 8);
    expect([...lzwDecode(8, data)]).toEqual([]);
  });
});

describe("GIF 文件组装", () => {
  it("两帧纯色图：头、帧数、结束符都对", () => {
    const bytes = encodeGif([
      solidFrame(8, 8, [255, 0, 0]),
      solidFrame(8, 8, [0, 128, 255], 0.25),
    ]);
    const magic = String.fromCharCode(...bytes.slice(0, 6));
    expect(magic).toBe("GIF89a");
    const info = gifHeaderInfo(bytes);
    expect(info).toEqual({ w: 8, h: 8, frames: 2 });
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });

  it("解回第 0 帧的下标流，颜色映射到纯红", () => {
    const frame = solidFrame(8, 8, [255, 10, 10]);
    const bytes = encodeGif([frame]);
    const { min, data } = frameLzw(bytes, 0);
    const { indices, palette } = quantizeFrame(frame);
    const decoded = lzwDecode(min, data);
    expect([...decoded]).toEqual([...indices]);
    // 纯红映到色表里的某一项，且那一项就是 (255,10,10) 附近
    const c = palette[decoded[0]];
    expect(Math.abs(c[0] - 255)).toBeLessThanOrEqual(8);
    expect(Math.abs(c[1] - 10)).toBeLessThanOrEqual(8);
  });

  it("延时按 1/100 秒写进控制扩展，且最小 0.02s", () => {
    const bytes = encodeGif([solidFrame(4, 4, [1, 2, 3], 0.005)]);
    // 13(头) + 19(NETSCAPE) = 32 处是第一个控制扩展
    const p = bytes.findIndex((b, i) => b === 0x21 && bytes[i + 1] === 0xf9);
    expect(p).toBeGreaterThan(0);
    const delay = bytes[p + 4] | (bytes[p + 5] << 8);
    expect(delay).toBe(2);
  });

  it("尺寸不一致直接报错，不产出坏文件", () => {
    expect(() =>
      encodeGif([solidFrame(8, 8, [0, 0, 0]), solidFrame(8, 9, [0, 0, 0])]),
    ).toThrow(/尺寸不一致/);
  });

  it("空帧列表报错", () => {
    expect(() => encodeGif([])).toThrow(/没有可导出的帧/);
  });
});
