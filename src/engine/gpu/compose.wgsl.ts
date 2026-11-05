/**
 * compose.wgsl 的 TS 内联副本。
 *
 * 运行时真正使用的是这里导出的模板字符串常量 `COMPOSE_WGSL`：把它内联成字符串，
 * 就不需要 `?raw` 导入、不需要给 `*.wgsl` 补模块声明、也不需要改 tsconfig / vite-env.d.ts，
 * 严格模式下 `tsc --noEmit` 直接通过。
 *
 * `shaders/compose.wgsl` 与本常量是同一份文本（前者便于阅读与离线校验）。
 * 改动时请两处同步：以本文件为准，再覆盖回 shaders/compose.wgsl。
 */
export const COMPOSE_WGSL = `// 语义参考 ArtCraft PhotoCraft gpu crate (crates/gpu/src/compose.wgsl), MIT/Apache-2.0 双授权。
// 本文件是 Strata 的 WebGPU 图层合成 compute 管线：textureLoad 读输入纹理、每像素按
// W3C / Porter-Duff 公式混合、结果写回 RGBA8 累加缓冲，数值语义与 CPU 合成保持一致。
//
// 与 PhotoCraft 的关系：仅借鉴其 blend_channel / composite 的数值语义（mode 编号 1..27、
// EDGE 角点处理、straight-alpha 合成式），不含任何 Rust / wgpu 代码，也不跨 WebView 回传纹理。
//
// 混合模式支持范围（详见 shaders/README.md 与 src/engine/gpu/blendIds.ts）：
//   · 全部 27 种混合模式都逐像素正确实现，不再静默回退 normal：
//     可分离模式走 blend_channel 的 switch；非分离模式（深色 / 浅色 / 色相 / 饱和度 /
//     颜色 / 明度）走 blend_rgb / blend_hsl；溶解在 cs_main 里按确定性哈希逐像素二选一。
//     数值语义对齐 W3C Compositing and Blending Level 1 与 src/engine/blend.ts 的
//     SOFT_BLENDS（11 种软件混合），CPU / GPU 对拍见 tests/unit/gpu-blend.test.ts。
//   · 未知 id 由 blendToShaderId() 映射为 0（= normal）；越界 id（> 27）仍会被
//     diag.fallbackBits 位掩码标注（bit i 置位 = id i 曾回退），诊断通道保留供接线读回。
//
// 本 WGSL 同时以模板字符串常量存于 src/engine/gpu/compose.wgsl.ts，两份文本逐字一致；
// 运行时只用 .ts 版本，避免 ?raw 导入所需的 *.wgsl 模块声明。

struct Params {
    blendMode : u32,
    opacity   : f32,
    width     : u32,
    height    : u32,
};

struct Diag {
    fallbackBits : atomic<u32>,
};

@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var<storage, read_write> accum : array<u32>;
@group(0) @binding(2) var layerTex : texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> diag : Diag;

const EDGE : f32 = 1e-4;

// 累加缓冲按 u32 打包 RGBA8：低字节 R、次字节 G、再次 B、高字节 A（little-endian 下即 RGBA 字节序）。
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

// ---- 逐通道混合（数值语义对齐 PhotoCraft compose.wgsl 的 blend_channel） ------------------

// W3C color-dodge：底层为 0 时优先返回 0（color-dodge 模式用）。
fn color_dodge_f(cb : f32, cs : f32) -> f32 {
    if (cb <= EDGE) { return 0.0; }
    if (cs >= 1.0)  { return 1.0; }
    return min(cb / (1.0 - cs), 1.0);
}

// W3C color-burn：底层为 1 时优先返回 1（color-burn 模式用）。
fn color_burn_f(cb : f32, cs : f32) -> f32 {
    if (cb >= 1.0) { return 1.0; }
    if (cs <= 0.0) { return 0.0; }
    return 1.0 - min((1.0 - cb) / cs, 1.0);
}

// vivid-light 分支用：与 src/engine/blend.ts::colorBurn / colorDodge 同式，
// 角点优先级与 W3C 版本不同（上层为 0 / 1 时优先返回 0 / 1），故单独两式。
fn vivid_burn_f(cb : f32, cs : f32) -> f32 {
    if (cs <= 0.0) { return 0.0; }
    return 1.0 - min((1.0 - cb) / cs, 1.0);
}

fn vivid_dodge_f(cb : f32, cs : f32) -> f32 {
    if (cs >= 1.0) { return 1.0; }
    return min(cb / (1.0 - cs), 1.0);
}

fn hard_light_f(cb : f32, cs : f32) -> f32 {
    if (cs <= 0.5) { return cb * 2.0 * cs; }
    let s = 2.0 * cs - 1.0;
    return cb + s - cb * s;
}

// W3C / Photoshop soft-light（参考 soft_light_ps）：亮部用分段 D(Cb)，与 Canvas2D 一致。
fn soft_light_f(cb : f32, cs : f32) -> f32 {
    if (cs <= 0.5) {
        return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    }
    var d = sqrt(max(cb, 0.0));
    if (cb <= 0.25) {
        d = ((16.0 * cb - 12.0) * cb + 4.0) * cb;
    }
    return cb + (2.0 * cs - 1.0) * (d - cb);
}

fn vivid_light_f(cb : f32, cs : f32) -> f32 {
    if (cs <= 0.5) { return vivid_burn_f(cb, 2.0 * cs); }
    return vivid_dodge_f(cb, 2.0 * cs - 1.0);
}

fn pin_light_f(cb : f32, cs : f32) -> f32 {
    if (cs <= 0.5) { return min(cb, 2.0 * cs); }
    return max(cb, 2.0 * cs - 1.0);
}

fn divide_f(cb : f32, cs : f32) -> f32 {
    if (cs <= 0.0) { return 1.0; }
    return clamp(cb / cs, 0.0, 1.0);
}

// cb = 背景（backdrop），cs = 源（source）；不对称模式以 cs 为条件，与 W3C 一致。
// 溶解(2) 在 cs_main 单独处理；非分离模式(7 / 12 / 24..27) 由 blend_rgb 整像素处理。
fn blend_channel(mode : u32, cb : f32, cs : f32) -> f32 {
    switch mode {
        case 0u, 1u:  { return cs; }                                    // 未知 / normal
        case 3u:      { return min(cb, cs); }                            // darken
        case 4u:      { return cb * cs; }                                // multiply
        case 5u:      { return color_burn_f(cb, cs); }                    // color-burn
        case 6u:      { return clamp(cb + cs - 1.0, 0.0, 1.0); }         // linear-burn
        case 8u:      { return max(cb, cs); }                            // lighten
        case 9u:      { return cb + cs - cb * cs; }                      // screen
        case 10u:     { return color_dodge_f(cb, cs); }                   // color-dodge
        case 11u:     { return clamp(cb + cs, 0.0, 1.0); }                // linear-dodge
        case 13u:     { return hard_light_f(cs, cb); }                    // overlay = hard-light(cs, cb)
        case 14u:     { return soft_light_f(cb, cs); }                    // soft-light
        case 15u:     { return hard_light_f(cb, cs); }                    // hard-light
        case 16u:     { return vivid_light_f(cb, cs); }                   // vivid-light
        case 17u:     { return clamp(cb + 2.0 * cs - 1.0, 0.0, 1.0); }    // linear-light
        case 18u:     { return pin_light_f(cb, cs); }                     // pin-light
        case 19u:     { return select(0.0, 1.0, cb + cs >= 1.0); }        // hard-mix
        case 20u:     { return abs(cb - cs); }                            // difference
        case 21u:     { return cb + cs - 2.0 * cb * cs; }                 // exclusion
        case 22u:     { return clamp(cb - cs, 0.0, 1.0); }                // subtract
        case 23u:     { return divide_f(cb, cs); }                        // divide
        default:      { return cs; }                                      // 越界 id 兜底 normal
    }
}

// ---- 非分离混合（W3C Compositing Level 1，整像素三通道耦合） --------------------------

fn lum(c : vec3<f32>) -> f32 {
    return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
}

fn sat(c : vec3<f32>) -> f32 {
    return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}

fn clip_color(c : vec3<f32>) -> vec3<f32> {
    let l = lum(c);
    let n = min(min(c.r, c.g), c.b);
    let x = max(max(c.r, c.g), c.b);
    var col = c;
    if (n < 0.0) {
        col = vec3<f32>(l) + (col - vec3<f32>(l)) * l / (l - n);
    }
    if (x > 1.0) {
        col = vec3<f32>(l) + (col - vec3<f32>(l)) * (1.0 - l) / (x - l);
    }
    return clamp(col, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn set_lum(c : vec3<f32>, l : f32) -> vec3<f32> {
    return clip_color(c + vec3<f32>(l - lum(c)));
}

// SetSat：最大通道设为 s、最小通道设为 0、中间通道按比例缩放（并列极值也正确）。
fn set_sat_channel(v : f32, mn : f32, mx : f32, midOut : f32, s : f32) -> f32 {
    if (v <= mn) { return 0.0; }
    if (v >= mx) { return s; }
    return midOut;
}

fn set_sat(c : vec3<f32>, s : f32) -> vec3<f32> {
    let mx = max(max(c.r, c.g), c.b);
    let mn = min(min(c.r, c.g), c.b);
    if (mx <= mn) { return vec3<f32>(0.0); }
    let mid = c.r + c.g + c.b - mx - mn;
    let midOut = (mid - mn) * s / (mx - mn);
    return vec3<f32>(
        set_sat_channel(c.r, mn, mx, midOut, s),
        set_sat_channel(c.g, mn, mx, midOut, s),
        set_sat_channel(c.b, mn, mx, midOut, s),
    );
}

fn blend_hsl(mode : u32, cb : vec3<f32>, cs : vec3<f32>) -> vec3<f32> {
    switch mode {
        case 24u: { return set_lum(set_sat(cs, sat(cb)), lum(cb)); }   // hue
        case 25u: { return set_lum(set_sat(cb, sat(cs)), lum(cb)); }   // saturation
        case 26u: { return set_lum(cs, lum(cb)); }                     // color
        case 27u: { return set_lum(cb, lum(cs)); }                     // luminosity
        default:  { return cs; }
    }
}

fn blend_rgb(mode : u32, cb : vec3<f32>, cs : vec3<f32>) -> vec3<f32> {
    // 深色 / 浅色：按视亮度整体二选一，不能逐通道套公式（对齐 SOFT_BLENDS）。
    if (mode == 7u)  { return select(cs, cb, lum(cb) <= lum(cs)); }   // darker-color
    if (mode == 12u) { return select(cs, cb, lum(cb) >= lum(cs)); }   // lighter-color
    if (mode >= 24u && mode <= 27u) { return blend_hsl(mode, cb, cs); }
    return vec3<f32>(
        blend_channel(mode, cb.r, cs.r),
        blend_channel(mode, cb.g, cs.g),
        blend_channel(mode, cb.b, cs.b),
    );
}

// W3C / Porter-Duff 合成：b = 背景（straight alpha），s = 源层，opacity ∈ [0,1]。
fn composite(mode : u32, b : vec4<f32>, s : vec4<f32>, opacity : f32) -> vec4<f32> {
    let ab  = b.a;
    let as_ = s.a * clamp(opacity, 0.0, 1.0);
    if (as_ <= 0.0) { return b; }                        // 源完全透明：背景不动
    let bl = blend_rgb(mode, b.rgb, s.rgb);
    let ao = as_ + ab * (1.0 - as_);
    if (ao <= 0.0) { return vec4<f32>(0.0); }
    let rgb = ((1.0 - as_) * ab * b.rgb
             + (1.0 - ab) * as_ * s.rgb
             + as_ * ab * bl) / ao;
    return vec4<f32>(rgb, ao);
}

// 溶解：与 src/engine/blend.ts::dither 同构的确定性 32 位整数哈希，
// 用 u32 回绕算术实现（WGSL 的 u32 乘加按模 2^32 回绕，语义等价于 JS 的 |0）。
fn dissolve_hash(x : u32, y : u32) -> f32 {
    let n = x * 374761393u + y * 668265263u;
    let m = (n ^ (n >> 13u)) * 1274126177u;
    return f32(((m ^ (m >> 16u)) >> 8u) & 0xffffu) / 65536.0;
}

fn isSupportedBlend(mode : u32) -> bool {
    return mode <= 27u;   // 0..27 都在本文件里正确实现，不再回退 normal
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.width || y >= params.height) { return; }

    let idx = y * params.width + x;
    let backdrop = unpack(accum[idx]);
    let source = textureLoad(layerTex, vec2<i32>(i32(x), i32(y)), 0);
    let mode = params.blendMode;
    let aMul = clamp(params.opacity, 0.0, 1.0);

    var result = backdrop;
    if (mode == 2u) {
        // 溶解：按确定性哈希逐像素二选一 —— 丢弃则保留背景，保留则源以全不透明度
        // 走 normal 合成；与 src/engine/blend.ts::blendInto 的 dissolve 分支同语义。
        if (source.a * aMul <= 0.0 || dissolve_hash(x, y) >= aMul) {
            result = backdrop;
        } else {
            result = composite(1u, backdrop, vec4<f32>(source.rgb, 1.0), 1.0);
        }
    } else {
        result = composite(mode, backdrop, source, aMul);
    }
    accum[idx] = pack(result);

    // 越界 id：上面已由 default 分支按 normal 合成；这里「在结果里标注」——把该
    // shader id 记入诊断位掩码，供 CPU 读回判定是否降级（27 种已实现模式不会命中）。
    if (x == 0u && y == 0u && !isSupportedBlend(mode) && mode < 32u) {
        _ = atomicOr(&diag.fallbackBits, 1u << mode);
    }
}
`;
