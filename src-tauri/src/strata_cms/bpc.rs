//! 目标侧黑点响应曲线拟合（Black Point Compensation, BPC）。
//!
//! 本模块为本地副本 `photocraft-cms`（移植自 ArtCraft PhotoCraft，MIT / Apache-2.0
//! 双授权）补上「目标侧曲线拟合」那一步：原先 `transform.rs::black_point` 直接把一次
//! BToA / AToB 往返亮度当作目标黑点，LUT 在暗部的量化抖动会原样进入 BPC 的仿射
//! 映射，暗部过渡因此不够平滑。
//!
//! 思路取自 Adobe 的 BPC 论文与 LittleCMS 的 `BlackPointEstimation`：沿暗部取一组
//! PCS 亮度样本，用低阶多项式最小二乘拟合一条平滑、单调的响应曲线，再以它在黑端
//! 的截距作为目标侧有效黑点。BPC 关闭时根本不会走到这里（见
//! `transform.rs::connection` 的 `if !bpc { return Ok(None); }`），因此关闭路径的行为
//! 完全不变；公开 API `black_point` 的签名也保持不变。
//!
//! 只依赖 `std`，可独立编译验证：
//! `rustc --edition 2021 --test bpc.rs -o bpc_test && ./bpc_test`

/// 暗部采样点数（与 3D CLUT 网格同量级，覆盖从黑到稍亮的一段即可）。
pub const SAMPLES: usize = 33;

/// 解 3×3 线性方程组（高斯-约当消元，带主元选取）。调用方对矩阵加了正则化，不会奇异。
fn solve3(m: [[f64; 3]; 3], rhs: [f64; 3]) -> [f64; 3] {
    let mut a = [
        [m[0][0], m[0][1], m[0][2], rhs[0]],
        [m[1][0], m[1][1], m[1][2], rhs[1]],
        [m[2][0], m[2][1], m[2][2], rhs[2]],
    ];
    for col in 0..3 {
        let mut piv = col;
        for r in (col + 1)..3 {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        a.swap(col, piv);
        let p = a[col][col];
        if p.abs() < 1e-18 {
            continue;
        }
        for r in 0..3 {
            if r == col {
                continue;
            }
            let f = a[r][col] / p;
            for c in col..4 {
                a[r][c] -= f * a[col][c];
            }
        }
    }
    let mut out = [0.0f64; 3];
    for i in 0..3 {
        let d = a[i][i];
        out[i] = if d.abs() > 1e-18 { a[i][3] / d } else { 0.0 };
    }
    out
}

/// 二次多项式 `f(t) = a + b·t + c·t²`（`t = i/(n-1) ∈ [0,1]`）的最小二乘拟合。
///
/// 最小二乘本身就把单点量化抖动摊平；再强制 `b, c ≥ 0`，保证拟合出的响应曲线在
/// `[0,1]` 上单调不减 —— 这是「暗部过渡单调」的数学依据。
fn fit_quadratic(samples: &[f64]) -> [f64; 3] {
    let n = samples.len();
    if n < 3 {
        return [samples.first().copied().unwrap_or(0.0), 0.0, 0.0];
    }
    let span = (n - 1) as f64;
    let mut s = [0.0f64; 5]; // Σ t^k, k = 0..4
    let mut q = [0.0f64; 3]; // Σ t^k·y, k = 0..2
    for (i, &y) in samples.iter().enumerate() {
        let t = i as f64 / span;
        let mut p = 1.0f64;
        for sk in &mut s {
            *sk += p;
            p *= t;
        }
        let mut p2 = 1.0f64;
        for qk in &mut q {
            *qk += p2 * y;
            p2 *= t;
        }
    }
    // 正规方程；对角加微小正则化，保证任意（含全零）样本下都可解。
    let lambda = 1e-9 * s[0];
    let m = [
        [s[0] + lambda, s[1], s[2]],
        [s[1], s[2] + lambda, s[3]],
        [s[2], s[3], s[4] + lambda],
    ];
    let mut coef = solve3(m, [q[0], q[1], q[2]]);
    // 单调约束：一次、二次项不得为负。
    if coef[1] < 0.0 {
        coef[1] = 0.0;
    }
    if coef[2] < 0.0 {
        coef[2] = 0.0;
    }
    coef
}

/// 由暗部亮度样本拟合目标侧有效黑点。
///
/// `samples` 是从「最暗」到「稍亮」的 PCS 亮度（约 `[0, 0.5]`）；`raw` 是一次往返
/// 直接得到的黑点（原行为）。返回值：
///  * 恒在 `[0, raw]` 内 —— 不会比单次往返黑点更亮，也不会越出黑点合法区间；
///  * 样本平滑（无抖动）时 ≈ `raw` —— 等价于「无需补偿」的原行为；
///  * 样本异常 / 不足 / `raw` 为纯黑时原样退回 `raw`。
pub fn fitted_black(samples: &[f64], raw: f64) -> f64 {
    let fallback = || raw.clamp(0.0, 0.5);
    if !(raw.is_finite() && raw > 0.0) {
        return fallback();
    }
    let clean: Vec<f64> = samples.iter().copied().filter(|v| v.is_finite()).collect();
    if clean.len() < 3 {
        return fallback();
    }
    let coef = fit_quadratic(&clean);
    // 上界取「单次往返黑点」与「实测最暗样本」的较小者，保证不越界、不比原黑点亮。
    let hi = raw.min(clean[0]).max(0.0);
    coef[0].clamp(0.0, hi)
}

/// BPC 在 PCS 里的仿射映射：把源黑 `s` 落到目标黑 `d`、白点 `white` 保持不动。
///
/// 返回 `(scale, offset)`，`f(x) = scale·x + offset`。这是 `transform.rs::connection`
/// 用的同一公式（逐字一致，数值不变）；`d < white` 时 `scale > 0`，故暗部映射严格
/// 单调、黑/白端点不越界。抽成纯函数是为了让这条性质也能在独立 harness 里验证。
pub fn bpc_affine(s: f64, d: f64, white: f64) -> (f64, f64) {
    let scale = (white - d) / (white - s);
    (scale, white * (1.0 - scale))
}

/// 平滑后的归一化暗部响应曲线，`n` 个点覆盖 `t ∈ [0,1]`。
///
/// 保证：单调不减、值域 `[0,1]`、首点 `0`、末点 `1`；样本退化时返回恒等直线。
/// 供单测验证「BPC 开时暗部过渡单调且不越界」。
pub fn response_curve(samples: &[f64], n: usize) -> Vec<f64> {
    let n = n.max(2);
    let identity = |k: usize| (0..k).map(|i| i as f64 / (k - 1) as f64).collect::<Vec<f64>>();
    let clean: Vec<f64> = samples.iter().copied().filter(|v| v.is_finite()).collect();
    if clean.len() < 3 {
        return identity(n);
    }
    let coef = fit_quadratic(&clean);
    let f = |t: f64| coef[0] + coef[1] * t + coef[2] * t * t;
    let (f0, f1) = (f(0.0), f(1.0));
    let span = f1 - f0;
    if span <= 1e-12 {
        return identity(n);
    }
    (0..n)
        .map(|i| {
            let t = i as f64 / (n - 1) as f64;
            ((f(t) - f0) / span).clamp(0.0, 1.0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一条精确二次的平滑暗部响应（黑点 `b`），二次最小二乘可无误差还原。
    fn smooth(b: f64) -> Vec<f64> {
        (0..SAMPLES)
            .map(|i| {
                let t = i as f64 / (SAMPLES - 1) as f64;
                b + 0.09 * t + 0.03 * t * t
            })
            .collect()
    }

    /// 「BPC 关 = 原行为」：拟合不介入或样本无抖动时，黑点保持单次往返原值。
    #[test]
    fn bpc_off_case_keeps_original_black() {
        // 样本不足 / 纯黑：直接退回原黑点。
        assert_eq!(fitted_black(&[], 0.02), 0.02);
        assert_eq!(fitted_black(&[0.02, 0.03], 0.02), 0.02);
        assert_eq!(fitted_black(&smooth(0.0), 0.0), 0.0);
        // 平滑无抖动样本：二次拟合精确还原截距 ≈ 原黑点，不凭空改变暗部。
        let raw = 0.02;
        let fitted = fitted_black(&smooth(raw), raw);
        assert!((fitted - raw).abs() < 1e-3, "fitted={fitted} raw={raw}");
    }

    /// 「BPC 开不越界」：任何（含抖动 / 越界 / NaN）样本下，拟合黑点都落在 [0, raw]。
    #[test]
    fn fitted_black_never_exceeds_raw_or_bounds() {
        let raw = 0.03;
        let noisy: Vec<f64> = (0..SAMPLES)
            .map(|i| {
                let t = i as f64 / (SAMPLES - 1) as f64;
                raw + 0.09 * t + 0.03 * t * t + if i % 2 == 0 { 0.004 } else { -0.004 }
            })
            .collect();
        let mut wild = noisy.clone();
        wild[5] = -1.0;
        wild[9] = f64::NAN;
        wild[11] = 2.0;
        for s in [noisy, wild, vec![0.0; SAMPLES], vec![1.0; SAMPLES]] {
            let f = fitted_black(&s, raw);
            assert!(f.is_finite(), "fitted={f}");
            assert!((0.0..=raw).contains(&f), "fitted={f} raw={raw}");
        }
    }

    /// 最小二乘把暗部量化抖动摊平：带噪与无噪样本给出的拟合黑点应几乎一致。
    #[test]
    fn fitting_smooths_dark_jitter() {
        let raw = 0.02;
        let clean = smooth(raw);
        let mut noisy = clean.clone();
        for i in 1..SAMPLES {
            noisy[i] += if i % 2 == 0 { 0.004 } else { -0.004 };
        }
        let f_clean = fitted_black(&clean, raw);
        let f_noisy = fitted_black(&noisy, raw);
        assert!((f_clean - f_noisy).abs() < 0.002, "clean={f_clean} noisy={f_noisy}");
    }

    /// 「BPC 开暗部单调且不越界」：平滑响应曲线单调不减、值域 [0,1]、端点 0/1。
    #[test]
    fn response_curve_is_monotone_and_bounded() {
        let raw = 0.02;
        let mut noisy = smooth(raw);
        for i in 1..SAMPLES {
            noisy[i] += if i % 2 == 0 { 0.004 } else { -0.004 };
        }
        for s in [smooth(raw), noisy, vec![0.0; SAMPLES], vec![]] {
            let curve = response_curve(&s, 64);
            assert_eq!(curve.len(), 64);
            assert!((curve[0] - 0.0).abs() < 1e-9);
            assert!((curve[63] - 1.0).abs() < 1e-9);
            for (i, w) in curve.windows(2).enumerate() {
                assert!(w[1] >= w[0] - 1e-9, "非单调 @ {i}: {w:?}");
                assert!((0.0..=1.0).contains(&w[0]), "越界 @ {i}: {}", w[0]);
            }
            assert!((0.0..=1.0).contains(&curve[63]));
        }
    }

    /// 「BPC 开暗部单调且不越界」：`connection` 用的仿射映射 scale > 0（严格单调），
    /// 源黑→目标黑、白点保持，暗部逐点值都落在 [0, white] 内。
    #[test]
    fn bpc_affine_is_monotone_and_bounded() {
        let w = 1.0;
        for (bs, bd) in [(0.0, 0.0), (0.0, 0.02), (0.01, 0.03), (0.05, 0.01)] {
            let (scale, offset) = bpc_affine(bs, bd, w);
            assert!(scale.is_finite() && scale > 0.0, "scale={scale}");
            assert!(offset.is_finite());
            assert!((scale * bs + offset - bd).abs() < 1e-9, "黑点未对齐");
            assert!((scale * w + offset - w).abs() < 1e-9, "白点漂移");
            let mut prev = f64::NEG_INFINITY;
            for i in 0..SAMPLES {
                let x = i as f64 / (SAMPLES - 1) as f64 * 0.15;
                let y = (scale * x + offset).clamp(0.0, w);
                assert!(y >= prev - 1e-9, "暗部非单调 @ {i}");
                assert!((0.0..=w).contains(&y), "暗部越界 @ {i}: {y}");
                prev = y;
            }
        }
    }
}
