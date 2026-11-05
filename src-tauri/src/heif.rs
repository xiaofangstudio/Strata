//! HEIC / HEIF 静态图解码封装。
//!
//! 调用方式参考 ArtCraft PhotoCraft `photocraft-heif`（MIT / Apache-2.0），
//! 底层是纯 Rust 的 `heic-rs = 0.1.4`。该库较年轻，所有进入它的调用都用
//! `std::panic::catch_unwind` 包住，任何内部 panic 都转成中文错误，
//! 不让宿主进程崩溃。
//!
//! 16bit 输出：heic-rs 已把 8/10/12bit 样本线性缩放到 **0…65535 满量程**
//! （见其 `color/fixed.rs` 的 `max_out = 65535`），所以不能再按原始位深或
//! 直接截高 8 位来量化；这里做线性归一化 + 舍入 + 4×4 有序抖动，保留
//! 10/12bit 的低位精度、避免渐变条带。

use std::panic::{catch_unwind, AssertUnwindSafe};

/// 解码后的 8bit RGBA 图像（行优先、无填充）。
pub struct HeifImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// 把 `heic-rs` 里可能发生的 panic 变成中文错误。
fn guarded<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err("HEIF 解码器在本文件上异常退出，已中止解码".to_string()))
}

/// 可选：16bit → 8bit 时启用简单的 Reinhard 高光滚降（默认关闭，保真优先）。
const HIGHLIGHT_ROLLOFF: bool = false;
/// 4×4 有序抖动，默认开启以打散 10/12bit → 8bit 的量化条带。
const ORDERED_DITHER: bool = true;

/// 4×4 Bayer 有序抖动，返回 [-0.5, 0.5)。
fn bayer(x: usize, y: usize) -> f32 {
    const M: [[f32; 4]; 4] = [
        [0.0, 8.0, 2.0, 10.0],
        [12.0, 4.0, 14.0, 6.0],
        [3.0, 11.0, 1.0, 9.0],
        [15.0, 7.0, 13.0, 5.0],
    ];
    (M[y & 3][x & 3] + 0.5) / 16.0 - 0.5
}

/// 16bit 满量程样本 → 8bit：线性归一化（不是截高位）+ 舍入 + 可选抖动 / 滚降。
fn to_u8(v: u16, x: usize, y: usize, dither: bool) -> u8 {
    let mut lin = f32::from(v) / 65535.0;
    if HIGHLIGHT_ROLLOFF {
        // 简单 Reinhard：白点归一化，柔和压缩高光。
        lin = 2.0 * lin / (1.0 + lin);
    }
    let mut q = lin.clamp(0.0, 1.0) * 255.0;
    if dither && ORDERED_DITHER {
        q += bayer(x, y);
    }
    q.round().clamp(0.0, 255.0) as u8
}

/// 解码 HEIF / HEIC 主图，统一输出 8bit RGBA。
pub fn decode_rgba8(bytes: &[u8]) -> Result<HeifImage, String> {
    guarded(|| decode_unguarded(bytes))
}

fn decode_unguarded(bytes: &[u8]) -> Result<HeifImage, String> {
    // 先读容器信息：是否带 alpha、是否 10bit（解码成 16bit）。
    let info = heic_rs::probe(bytes)
        .map_err(|_| "读不出 HEIF 容器信息，文件可能损坏或不是静态照片".to_string())?;
    let has_alpha = info.has_alpha;
    let sixteen = info.bit_depth > 8;
    let layout = match (has_alpha, sixteen) {
        (true, true) => heic_rs::PixelLayout::Rgba16,
        (true, false) => heic_rs::PixelLayout::Rgba8,
        (false, true) => heic_rs::PixelLayout::Rgb16,
        (false, false) => heic_rs::PixelLayout::Rgb8,
    };
    let opts = heic_rs::DecodeOptions::default()
        .with_layout(layout)
        .with_max_pixels(Some(1u64 << 28))
        .with_transforms(true)
        .with_alpha(has_alpha);
    let decoded = heic_rs::decode(bytes, &opts)
        .map_err(|_| "HEIF 像素解码失败，该文件的编码方式可能暂不支持".to_string())?;

    let channels = if has_alpha { 4 } else { 3 };
    let w = decoded.width;
    let h = decoded.height;
    let pixels = (w as usize)
        .checked_mul(h as usize)
        .ok_or_else(|| "HEIF 图片尺寸过大".to_string())?;
    let samples = pixels
        .checked_mul(channels)
        .ok_or_else(|| "HEIF 图片尺寸过大".to_string())?;
    let need = if sixteen {
        samples
            .checked_mul(2)
            .ok_or_else(|| "HEIF 图片尺寸过大".to_string())?
    } else {
        samples
    };
    if w == 0 || h == 0 || decoded.data.len() < need {
        return Err("HEIF 解码输出不完整".to_string());
    }
    let cap = pixels
        .checked_mul(4)
        .ok_or_else(|| "HEIF 图片尺寸过大".to_string())?;

    let data = &decoded.data;
    let sample = |base: usize, k: usize, x: usize, y: usize, dither: bool| -> u8 {
        if sixteen {
            let p = (base + k) * 2;
            let v = u16::from_ne_bytes([data[p], data[p + 1]]);
            // 16bit 满量程 → 8bit：不再 `>> 8` 截高位。
            to_u8(v, x, y, dither)
        } else {
            data[base + k]
        }
    };
    let mut rgba = Vec::with_capacity(cap);
    for i in 0..pixels {
        let x = i % (w as usize);
        let y = i / (w as usize);
        let base = i * channels;
        rgba.push(sample(base, 0, x, y, true));
        rgba.push(sample(base, 1, x, y, true));
        rgba.push(sample(base, 2, x, y, true));
        // alpha 不加抖动，避免半透明边缘出现噪声。
        rgba.push(if has_alpha { sample(base, 3, x, y, false) } else { 255 });
    }
    Ok(HeifImage { width: w, height: h, rgba })
}
