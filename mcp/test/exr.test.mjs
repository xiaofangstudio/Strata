/**
 * EXR 读取器测试：自己写文件 → 自己读回来，逐像素对账。
 *
 * 为什么要在测试里写一个 EXR 写入器：不能只验证「不报错」，必须验证
 * 通道顺序、扫描线分块、半精度解码、sRGB 编码这几处都对 —— 这些地方错了
 * 出来的图是花屏或偏色，但程序会一路"成功"。
 */
import { strict as assert } from "node:assert";
import { deflateSync } from "node:zlib";
import { exrDecode, exrInfo } from "../lib/exr.mjs";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log("  \u2713 " + name);
  } catch (e) {
    fail += 1;
    console.error("  \u2717 " + name + "\n      " + e.message);
  }
}

/* ------------------------------------------------------------ 写入器 */

/** float → half 位模式。 */
function toHalf(v) {
  const f = new Float32Array(1);
  const i = new Int32Array(f.buffer);
  f[0] = v;
  const x = i[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) return sign; // 下溢按 0 处理，测试里用不到极小值
  if (exp >= 0x1f) return sign | 0x7c00; // 上溢按 inf
  mant >>= 13;
  return sign | (exp << 10) | mant;
}

/** 写一个属性：名字、类型、值字节。 */
function attr(name, type, value) {
  const n = Buffer.from(name + "\0", "utf8");
  const t = Buffer.from(type + "\0", "utf8");
  const size = Buffer.alloc(4);
  size.writeInt32LE(value.length, 0);
  return Buffer.concat([n, t, size, value]);
}

function box2i(xMin, yMin, xMax, yMax) {
  const b = Buffer.alloc(16);
  b.writeInt32LE(xMin, 0);
  b.writeInt32LE(yMin, 4);
  b.writeInt32LE(xMax, 8);
  b.writeInt32LE(yMax, 12);
  return b;
}

/**
 * 造一个单部件扫描线 EXR。
 * @param {number} w
 * @param {number} h
 * @param {number} compression 0=NONE 1=RLE 2=ZIPS 3=ZIP
 * @param {(x:number,y:number)=>[number,number,number]} px 线性 RGB（0..1）
 */
function writeExr(w, h, compression, px) {
  const linesPer = [1, 1, 1, 16][compression];

  // chlist：三通道 HALF，按名字字典序 B/G/R
  const chNames = ["B", "G", "R"];
  const parts = [];
  for (const name of chNames) {
    parts.push(Buffer.from(name + "\0", "utf8"));
    const meta = Buffer.alloc(16);
    meta.writeInt32LE(1, 0); // HALF
    meta.writeUInt8(0, 4); // pLinear
    meta.writeInt32LE(1, 8); // xSampling
    meta.writeInt32LE(1, 12); // ySampling
    parts.push(meta);
  }
  parts.push(Buffer.from([0]));
  const chlist = Buffer.concat(parts);

  const comp = Buffer.alloc(1);
  comp.writeUInt8(compression, 0);
  const lineOrder = Buffer.alloc(1);
  lineOrder.writeUInt8(0, 0);
  const aspect = Buffer.alloc(4);
  aspect.writeFloatLE(1, 0);
  const swc = Buffer.alloc(8);
  swc.writeFloatLE(0, 0);
  swc.writeFloatLE(0, 4);
  const sww = Buffer.alloc(4);
  sww.writeFloatLE(1, 0);

  const header = Buffer.concat([
    attr("channels", "chlist", chlist),
    attr("compression", "compression", comp),
    attr("dataWindow", "box2i", box2i(0, 0, w - 1, h - 1)),
    attr("displayWindow", "box2i", box2i(0, 0, w - 1, h - 1)),
    attr("lineOrder", "lineOrder", lineOrder),
    attr("pixelAspectRatio", "float", aspect),
    attr("screenWindowCenter", "v2f", swc),
    attr("screenWindowWidth", "float", sww),
    Buffer.from([0]), // 头结束
  ]);

  // 块数据
  const chunks = [];
  const nChunks = Math.ceil(h / linesPer);
  const rowBytes = w * 2; // 每通道每行
  for (let ci = 0; ci < nChunks; ci += 1) {
    const y0 = ci * linesPer;
    const lines = Math.min(linesPer, h - y0);
    const raw = Buffer.alloc(rowBytes * 3 * lines);
    let o = 0;
    for (const name of chNames) {
      const idx = name === "R" ? 0 : name === "G" ? 1 : 2;
      for (let li = 0; li < lines; li += 1) {
        for (let x = 0; x < w; x += 1) {
          const v = px(x, y0 + li)[idx];
          raw.writeUInt16LE(toHalf(v), o);
          o += 2;
        }
      }
    }
    const payload = compression === 0 ? raw : deflateSync(raw);
    const head = Buffer.alloc(8);
    head.writeInt32LE(y0, 0);
    head.writeInt32LE(payload.length, 4);
    chunks.push(Buffer.concat([head, payload]));
  }

  // 偏移表 + 块
  const tableLen = nChunks * 8;
  const table = Buffer.alloc(tableLen);
  let at = 8 + header.length + tableLen;
  for (let i = 0; i < nChunks; i += 1) {
    table.writeBigUInt64LE(BigInt(at), i * 8);
    at += chunks[i].length;
  }

  const ver = Buffer.alloc(4);
  ver.writeUInt32LE(2, 0); // 版本 2，扫描线，单部件
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(0x01312f76, 0);

  return Buffer.concat([magic, ver, header, table, ...chunks]);
}

const srgbByte = (linear) => {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

/* -------------------------------------------------------------- 测试 */

console.log("EXR 读取器");

test("无压缩：通道顺序与半精度解码都对（线性 0.5 → sRGB 188）", () => {
    const buf = writeExr(3, 2, 0, () => [0.5, 0.5, 0.5]);
    const img = exrDecode(buf, 0);
    assert.equal(img.width, 3);
    assert.equal(img.height, 2);
    assert.equal(img.data[0], srgbByte(0.5));
    assert.equal(img.data[0], 188);
    assert.equal(img.data[3], 255);
  });

test("ZIP 压缩（16 行一块）：跨块边界也不错位", () => {
    // 20 行 → 两块（16 + 4），上块红、下块蓝，错位就会串色
    const buf = writeExr(4, 20, 3, (_x, y) => (y < 16 ? [1, 0, 0] : [0, 0, 1]));
    const img = exrDecode(buf, 0);
    const at = (x, y) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    assert.deepEqual(at(0, 0), [255, 0, 0]);
    assert.deepEqual(at(3, 15), [255, 0, 0]);
    assert.deepEqual(at(0, 16), [0, 0, 255]);
    assert.deepEqual(at(3, 19), [0, 0, 255]);
  });

test("ZIPS 压缩（1 行一块）也能读", () => {
    const buf = writeExr(2, 3, 2, (_x, y) => [y / 4, 0, 0]);
    const img = exrDecode(buf, 0);
    assert.equal(img.data[0], srgbByte(0));
    const i4 = (1 * img.width + 0) * 4;
    assert.equal(img.data[i4], srgbByte(0.25));
  });

test("exrInfo 能列出部件、通道与压缩方式", () => {
    const buf = writeExr(5, 7, 3, () => [0, 0, 0]);
    const info = exrInfo(buf);
    assert.equal(info.multipart, false);
    assert.equal(info.parts.length, 1);
    assert.equal(info.parts[0].width, 5);
    assert.equal(info.parts[0].height, 7);
    assert.equal(info.parts[0].compression, "ZIP");
    assert.equal(info.parts[0].supported, true);
    assert.deepEqual(info.parts[0].channels.map((c) => c.name), ["B", "G", "R"]);
    assert.equal(info.parts[0].channels[0].type, "HALF");
  });

test("PIZ 压缩：明确报不支持，而不是解出花屏", () => {
    const buf = writeExr(2, 2, 0, () => [0, 0, 0]);
    // 手动把 compression 属性改成 4(PIZ)
    const idx = buf.indexOf(Buffer.from("compression\0", "utf8")) + "compression\0".length;
    const typeEnd = buf.indexOf(0, idx) + 1;
    buf[typeEnd + 4] = 4;
    const info = exrInfo(buf);
    assert.equal(info.parts[0].compression, "PIZ");
    assert.equal(info.parts[0].supported, false);
    assert.throws(() => exrDecode(buf, 0), /PIZ/);
  });

test("不是 EXR 时报错清晰", () => {
    assert.throws(() => exrInfo(Buffer.from("not an exr at all")), /魔数/);
  });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
