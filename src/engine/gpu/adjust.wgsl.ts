/**
 * adjust.wgsl 的 TS 内联副本。
 *
 * 与 compose.wgsl.ts 同一套组织方式：运行时真正使用的是这里导出的模板字符串常量
 * `ADJUST_WGSL`，把它内联成字符串就不需要 `?raw` 导入、不需要给 `*.wgsl` 补模块声明，
 * 也不改 tsconfig / vite-env.d.ts，严格模式下 `tsc --noEmit` 直接通过。
 *
 * `shaders/adjust.wgsl` 与本常量是同一份文本（前者便于阅读与离线校验）。
 * 改动时请两处同步：以本文件为准，再覆盖回 shaders/adjust.wgsl。
 *
 * 本模块是「为后续接线做地基」的独立管线，尚未接入编辑器运行时（不碰浏览器 API）。
 */
export const ADJUST_WGSL = `// adjust.wgsl — Strata 的 WebGPU 调整算子 compute 管线（独立模块，为后续接线做地基，尚未接入运行时）。
//
// 语义参考 ArtCraft PhotoCraft（crates/compose/src/adjust.rs、crates/algo/src/tone.rs），
// MIT/Apache-2.0 双授权；数值对齐 src/core/layer.ts::adjustFilter 与
// src/engine/filters.ts 的 srgbToLinear / linearToSrgb / luma01，以及
// src/engine/adjustPixels.ts 的 HSL 换算。仅借鉴数值语义，不含任何 Rust / wgpu 代码。
//
// 与 compose.wgsl 同构：@compute @workgroup_size(8,8)、入口 cs_main、累加缓冲按 u32
// 打包 RGBA8（低字节 R、高字节 A），每像素 unpack → 施加算子 → pack 写回，alpha 原样保留。
// bindings：0=AdjustParams(uniform) / 1=pixels(storage rw，就地读写)。
//
// AdjustParams（48 字节，全部标量，天然 16 字节对齐）：
//   op     : u32  算子编号，见下表；未知编号 = 恒等（不改动像素）
//   width  : u32  图像宽
//   height : u32  图像高
//   p0..p8 : f32  算子参数（含义随 op 变化，见下表；未用到的参数忽略）
//
// 算子表（op → 公式；c 为 0..1 的 RGB）：
//   1 brightness   c·(1+p0)                         p0 = 亮度量 ∈ [-1,1]（对齐 bc 的 1+b/100）
//   2 contrast     (c-0.5)·(1+p0)+0.5              p0 = 对比度量 ∈ [-1,1]（对齐 bc 的 1+c/100）
//   3 exposure     linearToSrgb(pow(max(lin,0),ig)) p0 = EV, p1 = offset, p2 = gamma
//                  lin = srgbToLinear(c)·2^p0 + p1, ig = 1/max(0.01,p2)
//   4 saturation   luma + (1+p0)·(c-luma)           p0 = 饱和度量 ∈ [-1,1]，luma = Rec.709
//   5 hue          HSL 色相旋转                      p0 = 角度（度，正为顺时针）
//   6 temperature  c·(gr,gg,gb)                     p0 = temp/100, p1 = tint/100（对齐 colortemp）
//   7 gamma        pow(c, 1/p0)                      p0 = gamma > 0，1 = 恒等
//   8 levels       输入色阶 + 灰度系数 + 输出色阶    p0..p4 见 adjust_levels 注释（对齐 levels）
//
// 本 WGSL 同时以模板字符串常量 ADJUST_WGSL 存于 src/engine/gpu/adjust.wgsl.ts，
// 两份文本逐字一致；运行时只用 .ts 版本，避免 ?raw 导入所需的 *.wgsl 模块声明。

struct AdjustParams {
    op     : u32,
    width  : u32,
    height : u32,
    p0     : f32,
    p1     : f32,
    p2     : f32,
    p3     : f32,
    p4     : f32,
    p5     : f32,
    p6     : f32,
    p7     : f32,
    p8     : f32,
};

@group(0) @binding(0) var<uniform> params : AdjustParams;
@group(0) @binding(1) var<storage, read_write> pixels : array<u32>;

// 累加缓冲按 u32 打包 RGBA8：低字节 R、次字节 G、再次 B、高字节 A。
fn unpack(c : u32) -> vec4<f32> {
    let r = f32(c & 0xffu);
    let g = f32((c >> 8u) & 0xffu);
    let b = f32((c >> 16u) & 0xffu);
    let a = f32((c >> 24u) & 0xffu);
    return vec4<f32>(r, g, b, a) / 255.0;
}

fn pack(c : vec4<f32>) -> u32 {
    let clamped = clamp(c, vec4<f32>(0.0), vec4<f32>(1.0));
    let q = vec4<u32>(clamped * 255.0 + vec4<f32>(0.5));
    return (q.r & 0xffu)
         | ((q.g & 0xffu) << 8u)
         | ((q.b & 0xffu) << 16u)
         | ((q.a & 0xffu) << 24u);
}

fn clamp01(c : vec3<f32>) -> vec3<f32> {
    return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

// ---- 色彩空间（对齐 src/engine/filters.ts 的 srgbToLinear / linearToSrgb） --------------

fn srgb_to_linear(v : f32) -> f32 {
    let x = clamp(v, 0.0, 1.0);
    return select(pow((x + 0.055) / 1.055, 2.4), x / 12.92, x <= 0.04045);
}

fn linear_to_srgb(v : f32) -> f32 {
    let x = clamp(v, 0.0, 1.0);
    return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, x * 12.92, x <= 0.0031308);
}

// ---- HSL（对齐 src/engine/adjustPixels.ts 的 rgbToHsl / hslToRgb） ----------------------

fn rgb_to_hsl(c : vec3<f32>) -> vec3<f32> {
    let mx = max(max(c.r, c.g), c.b);
    let mn = min(min(c.r, c.g), c.b);
    let l = (mx + mn) * 0.5;
    let d = mx - mn;
    if (d <= 0.0) { return vec3<f32>(0.0, 0.0, l); }
    var s = 0.0;
    if (l > 0.5) { s = d / (2.0 - mx - mn); } else { s = d / (mx + mn); }
    var h = 0.0;
    if (mx == c.r) {
        h = ((c.g - c.b) / d + select(6.0, 0.0, c.g >= c.b)) / 6.0;
    } else if (mx == c.g) {
        h = ((c.b - c.r) / d + 2.0) / 6.0;
    } else {
        h = ((c.r - c.g) / d + 4.0) / 6.0;
    }
    return vec3<f32>(fract(h + 1.0), s, l);
}

fn hue_channel(t0 : f32, p : f32, q : f32) -> f32 {
    var t = t0;
    if (t < 0.0) { t = t + 1.0; }
    if (t > 1.0) { t = t - 1.0; }
    if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
    if (t < 0.5)       { return q; }
    if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
    return p;
}

fn hsl_to_rgb(hsl : vec3<f32>) -> vec3<f32> {
    let s = hsl.y;
    let l = hsl.z;
    if (s <= 0.0) { return vec3<f32>(l); }
    var q = 0.0;
    if (l < 0.5) { q = l * (1.0 + s); } else { q = l + s - l * s; }
    let p = 2.0 * l - q;
    return vec3<f32>(
        hue_channel(hsl.x + 1.0 / 3.0, p, q),
        hue_channel(hsl.x, p, q),
        hue_channel(hsl.x - 1.0 / 3.0, p, q),
    );
}

// ---- 八个算子 ------------------------------------------------------------------------

// 1 brightness：c·(1+p0)
fn adjust_brightness(c : vec3<f32>, amount : f32) -> vec3<f32> {
    return clamp01(c * (1.0 + amount));
}

// 2 contrast：(c-0.5)·(1+p0)+0.5
fn adjust_contrast(c : vec3<f32>, amount : f32) -> vec3<f32> {
    return clamp01((c - vec3<f32>(0.5)) * (1.0 + amount) + vec3<f32>(0.5));
}

fn exposure_channel(v : f32, gain : f32, offset : f32, ig : f32) -> f32 {
    let lin = srgb_to_linear(v) * gain + offset;
    var y = 0.0;
    if (lin > 0.0) { y = pow(lin, ig); }
    return linear_to_srgb(y);
}

// 3 exposure：线性光域乘 2^EV，加 offset，再按 gamma 回写（对齐 layer.ts::adjustFilter exposure）
fn adjust_exposure(c : vec3<f32>, ev : f32, offset : f32, gamma : f32) -> vec3<f32> {
    let gain = pow(2.0, ev);
    let ig = 1.0 / max(0.01, gamma);
    return vec3<f32>(
        exposure_channel(c.r, gain, offset, ig),
        exposure_channel(c.g, gain, offset, ig),
        exposure_channel(c.b, gain, offset, ig),
    );
}

// 4 saturation：以 Rec.709 亮度为轴线性缩放（对齐 CSS saturate 的亮度权重）
fn adjust_saturation(c : vec3<f32>, amount : f32) -> vec3<f32> {
    let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    return clamp01(vec3<f32>(l) + (1.0 + amount) * (c - vec3<f32>(l)));
}

// 5 hue：HSL 色相旋转，饱和度 / 明度不变
fn adjust_hue(c : vec3<f32>, degrees : f32) -> vec3<f32> {
    let hsl = rgb_to_hsl(c);
    let h = fract(hsl.x + degrees / 360.0 + 1.0);
    return hsl_to_rgb(vec3<f32>(h, hsl.y, hsl.z));
}

// 6 temperature：暖抬红压蓝、色调走绿—洋红（对齐 layer.ts::adjustFilter colortemp）
fn adjust_temperature(c : vec3<f32>, temp : f32, tint : f32) -> vec3<f32> {
    let gr = 1.0 + 0.32 * temp + 0.14 * tint;
    let gg = 1.0 - 0.2 * tint;
    let gb = 1.0 - 0.32 * temp + 0.14 * tint;
    return clamp01(c * vec3<f32>(gr, gg, gb));
}

// 7 gamma：pow(c, 1/p0)，p0 = 1 时恒等
fn adjust_gamma(c : vec3<f32>, gamma : f32) -> vec3<f32> {
    let inv = 1.0 / max(gamma, 0.01);
    return clamp01(pow(max(c, vec3<f32>(0.0)), vec3<f32>(inv)));
}

fn levels_channel(
    v : f32, inBlack : f32, inWhite : f32, invGamma : f32,
    outBlack : f32, outWhite : f32,
) -> f32 {
    let span = max(inWhite - inBlack, 1.0 / 255.0);
    let t = clamp((v - inBlack) / span, 0.0, 1.0);
    let w = pow(max(t, 0.0), max(invGamma, 0.001));
    return clamp(outBlack + w * (outWhite - outBlack), 0.0, 1.0);
}

/*
 * 8 levels：对齐 layer.ts::adjustFilter levels。
 * p0 = inBlack/255, p1 = inWhite/255, p2 = 100/gamma（即 pow 的指数），
 * p3 = outBlack/255, p4 = outWhite/255；全中性 p0=0,p1=1,p2=1,p3=0,p4=1 时为恒等。
 */
fn adjust_levels(
    c : vec3<f32>, inBlack : f32, inWhite : f32, invGamma : f32,
    outBlack : f32, outWhite : f32,
) -> vec3<f32> {
    return vec3<f32>(
        levels_channel(c.r, inBlack, inWhite, invGamma, outBlack, outWhite),
        levels_channel(c.g, inBlack, inWhite, invGamma, outBlack, outWhite),
        levels_channel(c.b, inBlack, inWhite, invGamma, outBlack, outWhite),
    );
}

// 算子分派：未知 op 返回原色（恒等），调用方可安全地传未接线的编号。
fn apply_adjust(op : u32, c : vec3<f32>) -> vec3<f32> {
    switch op {
        case 1u: { return adjust_brightness(c, params.p0); }
        case 2u: { return adjust_contrast(c, params.p0); }
        case 3u: { return adjust_exposure(c, params.p0, params.p1, params.p2); }
        case 4u: { return adjust_saturation(c, params.p0); }
        case 5u: { return adjust_hue(c, params.p0); }
        case 6u: { return adjust_temperature(c, params.p0, params.p1); }
        case 7u: { return adjust_gamma(c, params.p0); }
        case 8u: { return adjust_levels(c, params.p0, params.p1, params.p2, params.p3, params.p4); }
        default: { return c; }
    }
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.width || y >= params.height) { return; }
    let idx = y * params.width + x;
    let c = unpack(pixels[idx]);
    let rgb = apply_adjust(params.op, c.rgb);
    pixels[idx] = pack(vec4<f32>(rgb, c.a));   // alpha 通道不参与调整，原样写回
}
`;
