/**
 * Strata MCP 新增图元（Mark 5）单元测试。
 *
 * 覆盖相册/悬挂/质感链路里新写的纯函数：
 *   imageOps: rotateImage / marchingSquaresContours / polylineArea /
 *             outerContour / strokeRingDashed / glossLayer
 *   draw:     renderPath / renderRadialGlow / renderGlass
 *
 * 运行：node test/primitives.test.mjs （依赖 @napi-rs/canvas，位于 mcp/node_modules）
 *
 * 设计原则：不依赖任何外部素材，全部用合成图像 / 矢量路径在内存里构造，
 * 断言「结构正确 + 数值合理」，不追求像素级完美（像素级留给人工视觉验收）。
 */
import { strict as assert } from "node:assert";
import {
  rotateImage,
  marchingSquaresContours,
  polylineArea,
  outerContour,
  strokeRingDashed,
  glossLayer,
} from "../lib/imageOps.mjs";
import { renderPath, renderRadialGlow, renderGlass } from "../lib/draw.mjs";

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

/** 生成一块纯色 RGBA 图（data 为 Uint8ClampedArray）。 */
function makeImage(w, h, [r, g, b, a]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  }
  return { width: w, height: h, data };
}

/** 生成「实心圆盘 alpha 蒙版」：圆内不透明，圆外透明。用于轮廓/虚线测试。 */
function disk(w, h, r) {
  const data = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const a = dx * dx + dy * dy <= r * r ? 255 : 0;
      const o = (y * w + x) * 4;
      data[o] = 255;
      data[o + 1] = 128;
      data[o + 2] = 64;
      data[o + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

console.log("\nimageOps · 轮廓与虚线");
test("marchingSquaresContours: 圆盘应得到至少一条闭合折线", () => {
  const polys = marchingSquaresContours(disk(100, 100, 30));
  assert.ok(polys.length >= 1, "期望至少一条轮廓");
  for (const p of polys) assert.ok(p.length >= 4, "每条折线至少 4 点");
});
test("outerContour: 最大轮廓面积约等于圆盘面积（π·r²±容差）", () => {
  const ring = outerContour(disk(100, 100, 30), 30);
  assert.ok(ring.length >= 8, "轮廓点应足够多");
  const area = Math.abs(polylineArea(ring));
  // π·30² ≈ 2827，marching squares 在半像素边界，给宽容差。
  assert.ok(area > 1500 && area < 4000, `轮廓面积 ${area.toFixed(0)} 不在合理区间`);
});
test("strokeRingDashed: 沿轮廓画出虚实相间（既有笔墨也有空隙）", () => {
  const ring = outerContour(disk(100, 100, 30), 30);
  const dash = strokeRingDashed(ring, {
    stroke: [60, 40, 30],
    strokeWidth: 3,
    dashOn: 14,
    dashOff: 10,
  });
  assert.ok(dash && dash.width > 0 && dash.height > 0, "虚线画布尺寸有效");
  let opaque = 0;
  let transparent = 0;
  for (let i = 0; i < dash.width * dash.height; i += 1) {
    if (dash.data[i * 4 + 3] > 0) opaque += 1;
    else transparent += 1;
  }
  assert.ok(opaque > 0, "应存在实线段");
  assert.ok(transparent > 0, "应存在空白段（否则就不是虚线了）");
});

console.log("\nimageOps · 质感与变换");
test("glossLayer: 只动 RGB，alpha 原样保留", () => {
  const img = disk(100, 100, 40);
  const out = glossLayer(img, { rim: 0.55, sheen: 0.4, strength: 1 });
  for (let i = 0; i < 100 * 100; i += 1) {
    assert.equal(out.data[i * 4 + 3], img.data[i * 4 + 3], `第 ${i} 像素 alpha 被破坏`);
  }
});
test("glossLayer: 确实改变了像素（不是空操作），且无 NaN", () => {
  const img = disk(100, 100, 40);
  const out = glossLayer(img);
  let diff = 0;
  for (let i = 0; i < 100 * 100 * 4; i += 1) {
    if (out.data[i] !== img.data[i]) diff += 1;
    assert.ok(Number.isFinite(out.data[i]), "出现 NaN/Inf");
  }
  assert.ok(diff > 0, "胶封后像素不应与输入完全一致");
});
test("rotateImage: 45° 时画布扩大且保留半透明过渡", () => {
  const img = disk(60, 40, 15);
  const r = rotateImage(img, 45);
  assert.ok(r.width > img.width && r.height > img.height, "旋转后画布应放大");
  let opaque = false;
  let clear = false;
  for (let i = 0; i < r.width * r.height; i += 1) {
    const a = r.data[i * 4 + 3];
    if (a > 0) opaque = true;
    if (a === 0) clear = true;
  }
  assert.ok(opaque && clear, "应同时存在不透明与透明像素（双线性插值过渡）");
});

console.log("\ndraw · 矢量与光效");
test("polylineArea: 顺时针方块面积为正", () => {
  const sq = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.ok(Math.abs(polylineArea(sq) - 100) < 1e-6, "面积应≈100");
});
test("renderPath: 返回包围盒尺寸并提供 origin 偏移", () => {
  const cmds = [
    { op: "M", x: 10, y: 10 },
    { op: "L", x: 110, y: 60 },
  ];
  const img = renderPath({ commands: cmds, stroke: "#888888", strokeWidth: 6 });
  assert.ok(img.width > 0 && img.height > 0, "画布尺寸有效");
  assert.equal(typeof img.originX, "number");
  assert.equal(typeof img.originY, "number");
  // pad = ceil(strokeWidth)+2 = 8，originX = minX - pad = 10 - 8 = 2
  assert.equal(img.originX, 10 - (Math.ceil(6) + 2), "originX 偏移正确");
});
test("renderRadialGlow: 中心有光、四角透明", () => {
  const g = renderRadialGlow({
    width: 200,
    height: 200,
    cx: 100,
    cy: 100,
    radius: 80,
    color: "#ffe0a0",
    strength: 0.5,
    falloff: 2,
  });
  const center = (100 * 200 + 100) * 4;
  assert.ok(g.data[center + 3] > 0, "中心应有光晕");
  const corner = (0 * 200 + 0) * 4;
  assert.equal(g.data[corner + 3], 0, "四角应完全透明");
});
test("renderGlass: 薄玻璃膜，整体仍以半透明为主（不糊成实底）", () => {
  const gl = renderGlass({ width: 300, height: 400, tint: "#dceef8", strength: 0.22, streaks: 3 });
  let fullyOpaque = 0;
  for (let i = 0; i < 300 * 400; i += 1) {
    if (gl.data[i * 4 + 3] >= 255) fullyOpaque += 1;
  }
  assert.ok(fullyOpaque < 300 * 400 * 0.5, "玻璃膜不应把整张图盖成不透明");
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail > 0 ? 1 : 0);
