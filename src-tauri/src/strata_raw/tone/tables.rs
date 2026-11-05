//! `tone.rs` 的清晰度 / 纹理查表数据。
//!
//! 参考 crate 里的 `tables.rs` 是构建期生成的拟合数据表，回收的源码中未附带。
//! 这里用编译期 `const fn` 重新生成一份**真实**的局部对比响应，替代此前
//! 「全零中性」的等价 stub：
//!
//! * **Clarity**：4 个「半径分离」频带（guided 半径 2 / 8 / 32 / 128），每个频带
//!   一张随色调变化的增益表；`tone.rs` 按 `even()` 在节点上线性插值读取，
//!   乘到该频带的细节 `(p - b)` 上，实现「按半径/频率分离的局部对比增益」。
//! * **Texture**：6 个「频率分离」频带（高斯 σ 0.5…16），每个频带一张过原点的
//!   奇对称细节响应表；`tone.rs` 按 `knots()` 在节点上线性插值读取，
//!   减去 `d = 0` 处的响应后叠加，因此平坦区域严格不产生增益。
//!
//! 曲线由单调、连续可导的解析式采样而来（不是逐帧黑盒测量的原表，属合理拟合）：
//! 色调权重用有理 S 型 `½(1 + z/(1+|z|))`，细节响应用 `A·d/(1+|d|/τ)`。
//! 参数 0 时 `tone.rs` 的 `direction` 取权重 `k = 0`，且 `ToneMap::new` 直接
//! 短路返回 `None`，因此**严格恒等、不改任何像素**；正值表提升局部对比，
//! 负值表压平局部对比。类型与常量名保持与原实现一致，`tone.rs` 无需改动。
//!
//! 来源：ArtCraft PhotoCraft `photocraft-raw`，MIT / Apache-2.0。

pub(crate) struct ClarityTable {
    pub bands: [[f32; 8]; 4],
    pub base: [f32; 8],
    pub offset: f32,
}

// ---- 曲线参数（集中放置，便于按实测结果微调） ---------------------------------

/// 色调节点：`x = base_log2_luminance − geo_mean`，单位 stops，8 个节点覆盖 −4…+3。
const CLARITY_LO: f32 = -4.0;
const CLARITY_STEP: f32 = 1.0;
pub(crate) const CLARITY_TONE_LO: f32 = CLARITY_LO;
pub(crate) const CLARITY_TONE_STEP: f32 = CLARITY_STEP;
pub(crate) const CLARITY_BASE_LO: f32 = CLARITY_LO;
pub(crate) const CLARITY_BASE_STEP: f32 = CLARITY_STEP;

/// +100 / −100 在亮部附近的频带增益峰值（实测校准）。
/// `tone.rs` 的 `gain()` 把 log₂ 增益 clamp 到 ±6 stops：增益过大会直接饱和成
/// 方波，正负两个方向反而都被放大。以下取值让 +100 ≈ 2.2× 中间调细节、
/// −100 ≈ 0.53× 细节，与 Camera Raw 的拟合目标同量级，且两侧都留有余量。
const CLARITY_UP_GAIN: f32 = 2.0;
const CLARITY_DOWN_GAIN: f32 = 0.8;
/// 4 个频带的相对权重：细频带权重更高，符合「细节变化强于大尺度变化」。
const CLARITY_BAND_WEIGHT: [f32; 4] = [1.0, 0.92, 0.84, 0.76];

/// 细节响应的饱和尺度 τ（stops）：小细节近似线性，强边缘自动饱和以避免光晕。
const TEXTURE_TAU: f32 = 1.6;
/// 6 个高斯频带（σ 0.5…16）的响应幅度：细频带更强。
const TEXTURE_UP_AMP: [f32; 6] = [0.80, 0.72, 0.62, 0.48, 0.34, 0.24];
const TEXTURE_DOWN_AMP: [f32; 6] = [0.55, 0.50, 0.44, 0.34, 0.24, 0.17];

/// 严格递增的节点，避免 `knots()` 里出现 0/0 的 NaN 污染。
pub(crate) const TEXTURE_KNOTS: [f32; 11] = [-5.0, -4.0, -3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0];

/// 单调递增、连续可导的 S 型色调权重（有理式，避免引入非 const 的 `exp`）。
/// `z → −∞` 时趋于 0、`z → +∞` 时趋于 1；传入 `2·(x + 0.5)` 让过渡落在中间调，
/// 暗部增益小（保护阴影、不放大噪点），亮部增益大。
const fn soft_step(z: f32) -> f32 {
    let a = if z < 0.0 { -z } else { z };
    0.5 * (1.0 + z / (1.0 + a))
}

/// 单调递增、连续可导、过原点的奇对称细节响应：`amp · d / (1 + |d| / τ)`。
/// `d = 0` 时恒为 0（平坦区严格不改像素）；`amp > 0` 放大细节、`amp < 0` 压平。
const fn detail_response(d: f32, amp: f32) -> f32 {
    let a = if d < 0.0 { -d } else { d };
    amp * d / (1.0 + a / TEXTURE_TAU)
}

/// 生成一张 Clarity 表：4 个频带的色调增益 + 最粗 base 的色调项。
const fn gen_clarity(up: bool) -> ClarityTable {
    let mut base = [0.0f32; 8];
    let mut j = 0;
    while j < 8 {
        let x = CLARITY_LO + (j as f32) * CLARITY_STEP;
        let s = soft_step(2.0 * (x + 0.5));
        // 色调项随 x 单调：+100 压暗暗部（负偏置），−100 轻微提亮暗部。
        base[j] = if up { -0.45 * (1.0 - s) } else { 0.30 * s };
        j += 1;
    }
    let mut bands = [[0.0f32; 8]; 4];
    let amp = if up { CLARITY_UP_GAIN } else { -CLARITY_DOWN_GAIN };
    let mut b = 0;
    while b < 4 {
        let mut k = 0;
        while k < 8 {
            let x = CLARITY_LO + (k as f32) * CLARITY_STEP;
            bands[b][k] = amp * CLARITY_BAND_WEIGHT[b] * soft_step(2.0 * (x + 0.5));
            k += 1;
        }
        b += 1;
    }
    ClarityTable { bands, base, offset: 0.0 }
}

/// 生成一张 Texture 表：6 个频带各 11 个节点上的细节响应。
const fn gen_texture(up: bool) -> [[f32; 11]; 6] {
    let mut out = [[0.0f32; 11]; 6];
    let mut b = 0;
    while b < 6 {
        let amp = if up { TEXTURE_UP_AMP[b] } else { -TEXTURE_DOWN_AMP[b] };
        let mut j = 0;
        while j < 11 {
            out[b][j] = detail_response(TEXTURE_KNOTS[j], amp);
            j += 1;
        }
        b += 1;
    }
    out
}

pub(crate) const CLARITY_UP: ClarityTable = gen_clarity(true);
pub(crate) const CLARITY_DOWN: ClarityTable = gen_clarity(false);
pub(crate) const TEXTURE_UP: [[f32; 11]; 6] = gen_texture(true);
pub(crate) const TEXTURE_DOWN: [[f32; 11]; 6] = gen_texture(false);

// 编译期自检：表的关键性质随 `cargo check` 强制执行，不依赖测试套件能否运行。
// （本工程移植副本的 lib test 因缺 `image` 依赖无法编译，见交付报告。）
const _: () = {
    let mut b = 0usize;
    while b < 4 {
        let mut k = 1usize;
        while k < 8 {
            assert!(CLARITY_UP.bands[b][k] >= CLARITY_UP.bands[b][k - 1]);
            assert!(CLARITY_DOWN.bands[b][k] <= CLARITY_DOWN.bands[b][k - 1]);
            k += 1;
        }
        assert!(CLARITY_UP.bands[b][7] > 0.0);
        assert!(CLARITY_DOWN.bands[b][7] < 0.0);
        b += 1;
    }
    let mut k = 1usize;
    while k < 11 {
        assert!(TEXTURE_KNOTS[k] > TEXTURE_KNOTS[k - 1]);
        k += 1;
    }
    let mut b = 0usize;
    while b < 6 {
        // d = 0 处响应恒为 0：平坦区域严格不改像素。
        assert!(TEXTURE_UP[b][5] == 0.0 && TEXTURE_DOWN[b][5] == 0.0);
        let mut k = 1usize;
        while k < 11 {
            assert!(TEXTURE_UP[b][k] > TEXTURE_UP[b][k - 1]);
            assert!(TEXTURE_DOWN[b][k] < TEXTURE_DOWN[b][k - 1]);
            k += 1;
        }
        b += 1;
    }
};

#[cfg(test)]
mod tests {
    use super::*;
    // `tests` 的父是 `tables`，父的父才是 `tone`；Tone / ToneMap 定义在那里。
    // （用相对路径而非 `crate::strata_raw::tone::`，便于独立 harness 复用。）
    use super::super::{Tone, ToneMap};

    /// log₂ 亮度条纹：`base` 加一条 `amp` stops、周期 `period` px 的竖向正弦。
    fn stripes(w: usize, h: usize, base: f32, amp: f32, period: f32) -> Vec<f32> {
        (0..w * h)
            .map(|i| (base + amp * ((i % w) as f32 * std::f32::consts::TAU / period).sin()).exp2())
            .collect()
    }

    fn gains(y: &[f32], w: usize, h: usize, tone: Tone) -> Vec<f32> {
        let Some(m) = ToneMap::new(w, h, |i| y[i], tone, 0.0) else {
            return vec![1.0; w * h];
        };
        (0..w * h).map(|i| m.gain(i % w, i / w, y[i])).collect()
    }

    /// 中间行中央半段的峰峰 log₂ 亮度（局部对比度量）。
    fn swing(y: &[f32], g: &[f32], w: usize, h: usize) -> f32 {
        let row = (h / 2) * w;
        let v: Vec<f32> = (w / 4..3 * w / 4)
            .map(|x| (y[row + x] * g[row + x]).log2())
            .collect();
        v.iter().cloned().fold(f32::MIN, f32::max) - v.iter().cloned().fold(f32::MAX, f32::min)
    }

    // ---- 表数据本身的形状 ---------------------------------------------------

    #[test]
    fn tables_are_monotone_and_texture_is_odd() {
        for b in 0..4 {
            // 色调增益随 x 单调；UP 恒为正、DOWN 恒为负。
            for k in 1..8 {
                assert!(CLARITY_UP.bands[b][k] >= CLARITY_UP.bands[b][k - 1]);
                assert!(CLARITY_DOWN.bands[b][k] <= CLARITY_DOWN.bands[b][k - 1]);
            }
            assert!(CLARITY_UP.bands[b][7] > 0.0);
            assert!(CLARITY_DOWN.bands[b][7] < 0.0);
        }
        // 节点严格递增，避免 knots() 除零 NaN。
        for k in 1..11 {
            assert!(TEXTURE_KNOTS[k] > TEXTURE_KNOTS[k - 1]);
        }
        for b in 0..6 {
            // 细节响应单调；d = 0 处恒为 0；奇对称。
            for k in 1..11 {
                assert!(TEXTURE_UP[b][k] > TEXTURE_UP[b][k - 1]);
                assert!(TEXTURE_DOWN[b][k] < TEXTURE_DOWN[b][k - 1]);
            }
            assert_eq!(TEXTURE_UP[b][5], 0.0);
            assert_eq!(TEXTURE_DOWN[b][5], 0.0);
            for k in 1..=5 {
                assert!((TEXTURE_UP[b][5 - k] + TEXTURE_UP[b][5 + k]).abs() < 1e-6);
            }
        }
    }

    // ---- 端到端：滑块真正生效 -----------------------------------------------

    #[test]
    fn zero_is_identity() {
        let (w, h) = (600, 120);
        let y = stripes(w, h, -2.5, 0.25, 40.0);
        // 全中性 / 只把 clarity 与 texture 置 0：都严格恒等。
        assert!(gains(&y, w, h, Tone::NEUTRAL).iter().all(|&g| g == 1.0));
        let t = Tone { clarity: 0.0, texture: 0.0, ..Tone::NEUTRAL };
        assert!(gains(&y, w, h, t).iter().all(|&g| g == 1.0));
        // 平坦区任意 Texture 值都不改像素（响应过原点）。
        let flat = vec![0.2f32; w * h];
        assert!(gains(&flat, w, h, Tone { texture: 100.0, ..Tone::NEUTRAL })
            .iter()
            .all(|&g| (g - 1.0).abs() < 1e-6));
    }

    #[test]
    fn clarity_positive_raises_and_negative_flattens_local_contrast() {
        let (w, h) = (1232, 200);
        let y = stripes(w, h, -2.5, 0.25, 40.0);
        let one = vec![1.0f32; w * h];
        let before = swing(&y, &one, w, h);
        let up = swing(&y, &gains(&y, w, h, Tone { clarity: 100.0, ..Tone::NEUTRAL }), w, h);
        let down = swing(&y, &gains(&y, w, h, Tone { clarity: -100.0, ..Tone::NEUTRAL }), w, h);
        assert!(up > before * 1.05, "0 → {before}, +100 → {up}");
        assert!(down < before * 0.95, "0 → {before}, −100 → {down}");
        // 线性：+50 落在 0 与 +100 之间。
        let half = swing(&y, &gains(&y, w, h, Tone { clarity: 50.0, ..Tone::NEUTRAL }), w, h);
        assert!(half > before && half < up, "{before} < {half} < {up}");
    }

    #[test]
    fn texture_positive_raises_and_negative_flattens_fine_detail() {
        let (w, h) = (2464, 160);
        let y = stripes(w, h, -2.5, 0.1, 6.0);
        let one = vec![1.0f32; w * h];
        let before = swing(&y, &one, w, h);
        let up = swing(&y, &gains(&y, w, h, Tone { texture: 100.0, ..Tone::NEUTRAL }), w, h);
        let down = swing(&y, &gains(&y, w, h, Tone { texture: -100.0, ..Tone::NEUTRAL }), w, h);
        assert!(up > before * 1.05, "0 → {before}, +100 → {up}");
        assert!(down < before * 0.95, "0 → {before}, −100 → {down}");
        // 细细节比粗细节提升更多。
        let coarse = stripes(w, h, -2.5, 0.1, 600.0);
        let c0 = swing(&coarse, &one, w, h);
        let c1 = swing(&coarse, &gains(&coarse, w, h, Tone { texture: 100.0, ..Tone::NEUTRAL }), w, h);
        assert!(up / before > c1 / c0, "fine ×{}, coarse ×{}", up / before, c1 / c0);
    }
}
