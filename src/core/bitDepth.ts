/**
 * 源文件位深探测（纯函数，不碰 DOM）。
 *
 * 16bit PNG 被浏览器解码时会静默压成 8bit —— 数据没了但用户不知道，
 * 这正是「不做静默降级」要拦的事。这里从文件头直接读真实位深，
 * 打开管线据此在 doc.depth 上标 16，让界面明确告诉用户源是什么深度。
 */

/** PNG 签名：89 50 4E 47 0D 0A 1A 0A。 */
function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

/**
 * PNG IHDR 的位深字段：8 字节签名 + 4 字节长度 + 4 字节 "IHDR" 之后，
 * 数据区第 8 字节（宽 4 + 高 4）就是 bit depth。
 * 返回 1 / 2 / 4 / 8 / 16；不是 PNG 或头坏了返回 null。
 */
export function pngBitDepth(bytes: Uint8Array): number | null {
  if (!isPng(bytes)) return null;
  const depth = bytes[24];
  return [1, 2, 4, 8, 16].includes(depth) ? depth : null;
}

/** TIFF 的小端字节序标记（II）；大端（MM）返回 false；不是 TIFF 返回 null。 */
export function tiffIsLittleEndian(bytes: Uint8Array): boolean | null {
  if (bytes.length < 8) return null;
  if (bytes[0] === 0x49 && bytes[1] === 0x49) return true;
  if (bytes[0] === 0x4d && bytes[1] === 0x4d) return false;
  return null;
}

/**
 * TIFF 第一个 IFD 的 BitsPerSample（tag 258）首值。
 * 读不到返回 null。自研解码器只支持 8/16 常规流，这里同样只做轻解析。
 */
export function tiffBitsPerSample(bytes: Uint8Array): number | null {
  const little = tiffIsLittleEndian(bytes);
  if (little === null || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (off: number) => view.getUint16(off, little);
  const u32 = (off: number) => view.getUint32(off, little);

  const version = u16(2);
  if (version !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const p = ifd + 2 + i * 12;
    if (p + 12 > bytes.length) return null;
    if (u16(p) !== 258) continue;
    const type = u16(p + 2);
    const n = u32(p + 4);
    if (n < 1) return null;
    if (type === 3) {
      // SHORT：总数 ≤2 时内联在条目内（条目偏移 + 8），否则是外部偏移。
      const total = 2 * n;
      const base = total <= 4 ? p + 8 : u32(p + 8);
      if (base + 2 > bytes.length) return null;
      return u16(base);
    }
    if (type === 4) {
      const base = n * 4 <= 4 ? p + 8 : u32(p + 8);
      if (base + 4 > bytes.length) return null;
      return u32(base);
    }
    return null;
  }
  return null;
}

/** 统一入口：源文件位深。识别不了的格式一律按 8。 */
export function sourceBitDepth(ext: string, bytes: Uint8Array): 8 | 16 {
  if (ext === "png") return pngBitDepth(bytes) === 16 ? 16 : 8;
  if (ext === "tif" || ext === "tiff") return tiffBitsPerSample(bytes) === 16 ? 16 : 8;
  return 8;
}
