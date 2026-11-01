//! OpenEXR 读取（文件 > 打开 EXR 部件）。
//!
//! 用纯 Rust 的 `exr` crate（BSD-3，MSRV 与本工程红线一致）解码，
//! 不引 C++ 的 OpenEXR。EXR 是 HDR 格式，而 Strata 的文档管线是 8 位 sRGB，
//! 所以这里的转换是真实且有损的：线性值经 sRGB 伽马编码、超过 1.0 的亮度裁到白、
//! Alpha 保持线性只做裁剪。多个部件（multipart / AOV）逐个读出，前端各自成层。

use exr::prelude::*;
use serde::Serialize;

/// 线性值 → 8 位 sRGB。超亮裁到白（HDR → LDR 的有损一步，界面上如实说明）。
fn to_srgb8(v: f32) -> u8 {
    let c = v.clamp(0.0, 1.0);
    let srgb = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (srgb * 255.0 + 0.5) as u8
}

/// 线性 Alpha → 8 位。Alpha 不做伽马编码。
fn to_lin8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// 一个部件的概要信息（打开前先列出来给用户挑）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExrPartInfo {
    pub name: String,
    pub width: usize,
    pub height: usize,
    pub channels: Vec<String>,
}

/// 列出 EXR 的全部部件（multipart 文件会有多个，单部件文件只有一个）。
#[tauri::command]
pub fn exr_part_info(path: String) -> std::result::Result<Vec<ExrPartInfo>, String> {
    let meta =
        MetaData::read_from_file(&path, false).map_err(|e| format!("读不了这个 EXR：{e}"))?;
    Ok(meta
        .headers
        .iter()
        .enumerate()
        .map(|(i, h)| ExrPartInfo {
            name: h
                .own_attributes
                .layer_name
                .as_ref()
                .map(|t| t.to_string())
                .unwrap_or_else(|| format!("部件 {}", i + 1)),
            width: h.data_window().size.width(),
            height: h.data_window().size.height(),
            channels: h
                .channels
                .list
                .iter()
                .map(|c| c.name.to_string())
                .collect(),
        })
        .collect())
}

/// 解出的一个部件：8 位 RGBA（已按 sRGB 编码）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExrPartPixels {
    pub name: String,
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

/// 把全部部件逐个解码成 8 位 RGBA。
///
/// `rgba` 是行优先、每像素 4 字节；大文件会慢（并行解压已由 crate 负责），
/// 前端在打开期间显示进度提示即可。
#[tauri::command]
pub fn exr_read_all(path: String) -> std::result::Result<Vec<ExrPartPixels>, String> {
    let image = read_all_rgba_layers_from_file(
        &path,
        |resolution, _channels| {
            vec![vec![[0.0f32; 4]; resolution.width()]; resolution.height()]
        },
        |pixels, position, (r, g, b, a): (f32, f32, f32, f32)| {
            pixels[position.y()][position.x()] = [r, g, b, a];
        },
    )
    .map_err(|e| format!("解码 EXR 失败：{e}"))?;

    Ok(image
        .layer_data
        .iter()
        .map(|layer| {
            let (w, h) = (layer.size.width(), layer.size.height());
            let mut rgba = Vec::with_capacity(w * h * 4);
            for row in &layer.channel_data.pixels {
                for px in row {
                    let [r, g, b, a] = *px;
                    rgba.push(to_srgb8(r));
                    rgba.push(to_srgb8(g));
                    rgba.push(to_srgb8(b));
                    rgba.push(to_lin8(a));
                }
            }
            ExrPartPixels {
                name: layer
                    .attributes
                    .layer_name
                    .as_ref()
                    .map(|t| t.to_string())
                    .unwrap_or_default(),
                width: w,
                height: h,
                rgba,
            }
        })
        .collect())
}
