/**
 * 二次补全工具的单元测试（零依赖，node 直接跑）。
 *
 * 覆盖三块：
 *  1. lib/project.mjs 新增的工程级操作（删除隐藏层 / 反转顺序 / 变换 /
 *     蒙版读写 / 灰度化）—— 语义对齐 src/core/layerOps.ts 与 transform.ts；
 *  2. lib/imageOps.mjs 新增的翻转 / 整倍旋转纯函数；
 *  3. engines.gen.mjs 里此前未暴露、这次接成工具的纯函数
 *     （medianCutPalette / splitChannels / estimateShift / buildPdf）。
 *
 * 运行：node mcp/test/gap-tools.test.mjs
 */
import assert from "node:assert";
import {
  deleteHiddenLayersInFile,
  grayscaleLayersInFile,
  reverseLayersInFile,
  setLayerMaskInFile,
  transformInFile,
} from "../lib/project.mjs";
import { flipImage, quarterRotateImage } from "../lib/imageOps.mjs";
import { decodePngBase64, encodePngBase64 } from "../lib/png.mjs";
import {
  applyPalette,
  buildPdf,
  countPdfPages,
  estimateShift,
  medianCutPalette,
  splitChannels,
} from "../lib/engines.gen.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    process.stderr.write(`FAIL  ${name}\n      ${e.message}\n`);
    process.exitCode = 1;
  }
}

/** 造一段 base64 PNG：宽 w 高 h，每像素颜色由 fill(i=>[r,g,b,a]) 给出。 */
function png(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const [r, g, b, a] = fill(i);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a ?? 255;
  }
  return encodePngBase64(w, h, data);
}

/** 一份三层的测试工程：隐藏层 a（组）→ 子层 b → 顶层 c。 */
function sampleFile() {
  const surf = png(2, 1, (i) => (i === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const layer = (name, extra = {}) => ({
    name,
    visible: true,
    opacity: 100,
    blend: "normal",
    locked: false,
    kind: "pixel",
    surface: surf,
    ...extra,
  });
  return {
    magic: "STRATA-PROJECT",
    version: 5,
    name: "测试",
    width: 2,
    height: 1,
    active: 2,
    layers: [
      layer("a", { visible: false }),
      layer("b", { parent: 0 }),
      layer("c"),
    ],
  };
}

/* ---------------------------------------------- 工程级：删除隐藏 / 反转 */

check("删除隐藏图层：隐藏组连子层一起删，active 重排", () => {
  const r = deleteHiddenLayersInFile(sampleFile());
  assert.equal(r.ok, true);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.file.layers.map((l) => l.name), ["c"]);
  assert.equal(r.file.active, 0);
});

check("删除隐藏图层：全是隐藏层时拒绝", () => {
  const file = sampleFile();
  file.layers[1].visible = false;
  file.layers[2].visible = false;
  const r = deleteHiddenLayersInFile(file);
  assert.equal(r.ok, false);
});

check("反转图层顺序：组整块搬、parent 重排", () => {
  const r = reverseLayersInFile(sampleFile());
  assert.equal(r.reversed, true);
  assert.deepEqual(r.file.layers.map((l) => l.name), ["c", "a", "b"]);
  // 组 a 从 0 搬到 1，子层 b 的 parent 跟着改
  assert.equal(r.file.layers[2].parent, 1);
});

check("反转图层顺序：顶层少于两层时原样返回", () => {
  const file = sampleFile();
  file.layers = [file.layers[2]];
  const r = reverseLayersInFile(file);
  assert.equal(r.reversed, false);
});

/* ---------------------------------------------- 工程级：变换 */

check("图层水平翻转：像素镜像、尺寸不变", () => {
  const r = transformInFile(sampleFile(), 2, "flipH", "layer");
  assert.equal(r.ok, true);
  const dec = decodePngBase64(r.file.layers[2].surface);
  assert.equal(dec.width, 2);
  assert.equal(dec.height, 1);
  // 原来左红右蓝，翻完左蓝右红
  assert.deepEqual([dec.data[0], dec.data[4]], [0, 255]);
});

check("图层旋转 90 度：画布尺寸不变（越界裁掉，对齐 PS）", () => {
  const r = transformInFile(sampleFile(), 2, "rot90", "layer");
  assert.equal(r.ok, true);
  const dec = decodePngBase64(r.file.layers[2].surface);
  assert.equal(dec.width, 2);
  assert.equal(dec.height, 1);
});

check("文档旋转 90 度：画布宽高互换、蒙版与选区一起转", () => {
  const file = sampleFile();
  file.layers = [file.layers[2]];
  file.selection = png(2, 1, () => [255, 255, 255, 255]);
  const r = transformInFile(file, 0, "rot90", "document");
  assert.equal(r.ok, true);
  assert.deepEqual([r.file.width, r.file.height], [1, 2]);
  const sel = decodePngBase64(r.file.selection);
  assert.deepEqual([sel.width, sel.height], [1, 2]);
});

check("变换拒绝：调整层与锁定层", () => {
  const file = sampleFile();
  file.layers[2].locked = true;
  assert.equal(transformInFile(file, 2, "flipH", "layer").ok, false);
  const file2 = sampleFile();
  file2.layers[2] = { ...file2.layers[2], kind: "adjust", adjust: { id: "invert", params: {} }, surface: undefined };
  assert.equal(transformInFile(file2, 2, "flipH", "layer").ok, false);
});

/* ---------------------------------------------- 工程级：蒙版 */

check("蒙版 reveal/hide：按画布尺寸新建，set 校验 PNG，invert 反 alpha", () => {
  let file = sampleFile();
  let r = setLayerMaskInFile(file, 2, "reveal");
  assert.equal(r.ok, true);
  assert.deepEqual(r.dims, "2×1");
  assert.equal(r.file.layers[2].maskActive, true);
  let mask = decodePngBase64(r.file.layers[2].mask);
  assert.equal(mask.data[3], 255); // 全显

  r = setLayerMaskInFile(r.file, 2, "invert");
  mask = decodePngBase64(r.file.layers[2].mask);
  assert.equal(mask.data[3], 0); // 反相后全遮

  r = setLayerMaskInFile(r.file, 2, "clear");
  assert.equal(r.removed, true);
  assert.equal(r.file.layers[2].mask, undefined);
  assert.equal(r.file.layers[2].maskActive, false);

  // set：非法 base64 拒绝
  assert.equal(setLayerMaskInFile(sampleFile(), 2, "set", "not-png").ok, false);
});

/* ---------------------------------------------- 工程级：灰度 */

check("灰度文档：像素层去色、调整层跳过", () => {
  const file = sampleFile();
  file.layers[1] = { ...file.layers[1], kind: "adjust", adjust: { id: "invert", params: {} }, surface: undefined };
  const r = grayscaleLayersInFile(file);
  assert.equal(r.ok, true);
  assert.equal(r.touched, 2); // a 与 c
  const g = decodePngBase64(r.file.layers[0].surface);
  // 红 (255,0,0) → 0.299*255 ≈ 76
  assert.equal(g.data[0], Math.round(255 * 0.299));
  assert.equal(g.data[1], g.data[0]);
});

/* ---------------------------------------------- imageOps：翻转 / 整倍旋转 */

check("flipImage 水平 / 垂直翻转", () => {
  const img = { width: 2, height: 2, data: new Uint8ClampedArray([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]) };
  const fh = flipImage(img, "h");
  assert.deepEqual([fh.data[0], fh.data[4], fh.data[8], fh.data[12]], [2, 1, 4, 3]);
  const fv = flipImage(img, "v");
  assert.deepEqual([fv.data[0], fv.data[4], fv.data[8], fv.data[12]], [3, 4, 1, 2]);
});

check("quarterRotateImage：90 度宽高互换且坐标精确", () => {
  // 2×1：左红右蓝 → 顺时针转 90°（左上角去右上角）→ 1×2：上红下蓝
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
  const r = quarterRotateImage(img, 90);
  assert.deepEqual([r.width, r.height], [1, 2]);
  assert.deepEqual([r.data[0], r.data[4]], [255, 0]); // 上=红 下=蓝
  // 再转 270 转回来
  const back = quarterRotateImage(r, 270);
  assert.deepEqual([back.width, back.height], [2, 1]);
  assert.deepEqual([back.data[0], back.data[4]], [255, 0]);
  // 180 度：原路颠倒
  const half = quarterRotateImage(img, 180);
  assert.deepEqual([half.data[0], half.data[4]], [0, 255]);
});

/* ---------------------------------------------- engines：新接成工具的纯函数 */

check("medianCutPalette：返回不超过指定数的调色板，applyPalette 按板回涂", () => {
  const img = {
    width: 8,
    height: 8,
    data: (() => {
      const d = new Uint8ClampedArray(8 * 8 * 4);
      for (let i = 0; i < 64; i += 1) {
        // 一半偏红、一半偏蓝，期望量化出两个主色
        const red = i % 2 === 0;
        d[i * 4] = red ? 240 : 10;
        d[i * 4 + 2] = red ? 10 : 240;
        d[i * 4 + 3] = 255;
      }
      return d;
    })(),
  };
  const palette = medianCutPalette(img, 2);
  assert.ok(palette.length <= 2 && palette.length >= 1, `调色板数量异常：${palette.length}`);
  const quantized = applyPalette(img, palette);
  assert.equal(quantized.width, 8);
  // 量化后每个像素都应严格等于调色板中的某一项
  const keys = new Set(palette.map((c) => c.join(",")));
  for (let i = 0; i < 64; i += 1) {
    const key = `${quantized.data[i * 4]},${quantized.data[i * 4 + 1]},${quantized.data[i * 4 + 2]}`;
    assert.ok(keys.has(key), `像素 ${i} 不在调色板内：${key}`);
  }
});

check("splitChannels：拆出 R/G/B/Alpha 四张灰度图", () => {
  const img = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 40]) };
  const { channels, names } = splitChannels(img);
  assert.deepEqual(names, ["红", "绿", "蓝", "Alpha"]);
  assert.equal(channels.length, 4);
  assert.deepEqual(
    channels.map((c) => c.data[0]),
    [10, 20, 30, 40],
  );
});

check("estimateShift：能估出已知平移量", () => {
  // 32×32 确定性伪随机纹理（无周期性，SAD 只在真实位移处取最小），
  // moving = reference 平移 (-3, +2)，估计值应接近 dx=-3、dy=2
  const make = (dx, dy) => {
    const w = 32;
    const h = 32;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const sx = Math.min(w - 1, Math.max(0, x + dx));
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        const v = ((sx * 1836311903) ^ (sy * 2971215073)) & 255;
        const i = (y * w + x) * 4;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    return { width: w, height: h, data: d };
  };
  const ref = make(0, 0);
  // mov(x,y) = ref(x-3, y+2)：约定 ref(x,y) ≈ mov(x-dx, y-dy)，
  // 即 moving 沿 (dx,dy) 平移后与基准重合
  const mov = make(-3, 2);
  const shift = estimateShift(ref, mov);
  assert.ok(Math.abs(shift.dx + 3) <= 2 && Math.abs(shift.dy - 2) <= 2, `偏移估计偏差过大：${JSON.stringify(shift)}`);
});

check("buildPdf：多页合成，页数可数、文件头合法", () => {
  // buildPdf 只按 /DCTDecode 存流，不检查 JPEG 内容，
  // 这里给一段最小 JPEG 头尾字节即可验证对象结构。
  const stubJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const page = { jpeg: stubJpeg, width: 8, height: 8, dpi: 72 };
  const bytes = buildPdf([page, page, page]);
  const head = Buffer.from(bytes.slice(0, 8)).toString("latin1");
  assert.ok(head.startsWith("%PDF-1.4"), `PDF 头异常：${head}`);
  assert.equal(countPdfPages(bytes), 3);
});

process.stdout.write(`\ngap-tools：${passed} 项通过${process.exitCode ? "（有失败）" : ""}\n`);
