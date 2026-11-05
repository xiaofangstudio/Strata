//! 统一的解码与色彩管理 Tauri 命令。
//!
//! 所有命令的错误都是中文短句；返回给前端的图像统一为
//! `{ width, height, rgba, source, warning }`（8bit RGBA，行优先、无填充）。
//! `source` 明确标注像素来自哪里，`warning` 承载任何降级 / 回退的原因，
//! 不再让「内嵌预览」或「显影失败」静默发生。

use serde::Serialize;

use crate::strata_cms::{Builtin, Intent, Profile, Transform};

/// 返回给前端的统一图像结构。
///
/// serde 形态（`#[serde(rename_all = "camelCase")]`）：
/// `{ "width": u32, "height": u32, "rgba": number[],
///    "source": string, "warning": string | null }`
/// 原有 `width` / `height` / `rgba` 三个字段一个不少，新增两个字段均为可选读取。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// 像素来源：
    /// * `"sensor"` = 完整 RAW 传感器显影；
    /// * `"embedded-preview"` = 相机内嵌 JPEG 预览（**不是** RAW 显影）；
    /// * `"image"` = 普通图片（HEIC 等）直接解码。
    pub source: &'static str,
    /// 可展示给用户的告警 / 降级原因；正常路径为 `None`（JSON `null`）。
    /// 带上 `[CODE]` 前缀的短句（如 `CR3_UNSUPPORTED` / `JXL_*`），前端可分流。
    pub warning: Option<String>,
}

/// 解码 HEIC / HEIF 静态图。
#[tauri::command]
pub fn decode_heic(path: String) -> Result<DecodedImage, String> {
    let bytes = std::fs::read(&path)
        .map_err(|_| "读取 HEIC 文件失败，请确认路径有效".to_string())?;
    let img = crate::heif::decode_rgba8(&bytes)?;
    Ok(DecodedImage {
        width: img.width,
        height: img.height,
        rgba: img.rgba,
        source: "image",
        warning: None,
    })
}

/// 解码相机 RAW。优先完整显影，失败时退回内嵌 JPEG 预览并明确告知。
///
/// * `tonemap`：历史参数，实际是**曝光补偿 EV**（clamp ±5），不是 HDR 色调映射
///   曲线；前端一直传 0，这里保持原语义以免破坏兼容（详见 `develop_raw`）。
/// * `hdr_curve`：可选的真 HDR 高光滚降分支，`"reinhard"` / `"filmic"`（或
///   `"aces"`）；不传（前端现状）时完全走原路径，行为不变。
#[tauri::command]
pub fn decode_raw(
    path: String,
    tonemap: Option<f64>,
    hdr_curve: Option<String>,
) -> Result<DecodedImage, String> {
    let bytes = std::fs::read(&path)
        .map_err(|_| "读取 RAW 文件失败，请确认路径有效".to_string())?;
    let fmt = crate::strata_raw::identify(&bytes)
        .ok_or_else(|| "不是可识别的相机 RAW 文件".to_string())?;

    // CR3：传感器数据此版本不支持显影，直接走内嵌预览，并带上明确的、
    // 结构化的 unsupported 原因（不再是「用户拿到 JPEG 却以为是 RAW 显影」）。
    if let Some(reason) = fmt.preview_only_reason() {
        return from_embedded_preview(&bytes, Some(reason.to_string()));
    }

    let curve = parse_hdr_curve(hdr_curve.as_deref());
    match develop_raw(&bytes, tonemap, curve) {
        Ok(img) => Ok(img),
        Err(reason) => {
            // 显影失败不再静默回退：把失败原因带进 warning，连 jxl.rs 的
            // Unsupported / Malformed 分类也一并透传给前端。
            let warning = format!(
                "RAW 传感器显影失败，已回退到相机内嵌 JPEG 预览（并非 RAW 显影结果）。原因：{reason}"
            );
            from_embedded_preview(&bytes, Some(warning.clone()))
                .map_err(|e| format!("{warning} 且回退失败：{e}"))
        }
    }
}

/// 可选的真 HDR 高光滚降曲线，默认不启用（`hdr_curve` 不传时为 `None`）。
#[derive(Clone, Copy)]
enum HdrCurve {
    Reinhard,
    Filmic,
}

fn parse_hdr_curve(s: Option<&str>) -> Option<HdrCurve> {
    match s.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("reinhard") => Some(HdrCurve::Reinhard),
        Some("filmic") | Some("aces") => Some(HdrCurve::Filmic),
        _ => None,
    }
}

/// 可选的真 HDR 高光滚降：把 16bit 编码值还原到线性光（去 ProPhoto gamma 1.8），
/// 在线性域套曲线，再编码回 8bit。默认路径不调用它，行为完全不变。
/// 注意：显影管线的输出已经是 SDR 编码值（0…1），这里提供的是可选的
/// 高光滚降分支，而非替代完整的 HDR 渲染管线。
fn hdr_map(v16: u16, curve: HdrCurve) -> u8 {
    let enc = f32::from(v16) / 65535.0;
    let lin = enc.powf(1.8);
    let mapped = match curve {
        // Reinhard：x/(1+x)，按白点归一化后高光柔和滚降。
        HdrCurve::Reinhard => 2.0 * lin / (1.0 + lin),
        // ACES filmic 近似（Narkowicz 2015）。
        HdrCurve::Filmic => {
            let x = lin;
            (x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0)
        }
    };
    let out = mapped.clamp(0.0, 1.0).powf(1.0 / 1.8);
    (out * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

/// 用 strata_raw 的显影管线得到 16bit ProPhoto RGB，再降到 8bit RGBA。
fn develop_raw(
    bytes: &[u8],
    tonemap: Option<f64>,
    hdr: Option<HdrCurve>,
) -> Result<DecodedImage, String> {
    let mut opts = crate::strata_raw::DevelopOptions::default();
    if let Some(t) = tonemap {
        if t.is_finite() {
            // `tonemap` 是历史遗留的参数名：它实际表示曝光补偿（EV），并不是
            // HDR tonemap 曲线。前端一直传 0（= 不做补偿），此处必须保持原语义
            // 以免破坏兼容；真正的 HDR 高光滚降由 `hdr_curve` 单独选择（见上）。
            opts.exposure = t.clamp(-5.0, 5.0);
        }
    }
    // 保留 RawError 的原始分类（例如 jxl.rs 的 Unsupported/Malformed）作为原因，
    // 不再 `map_err(|_| ...)` 丢成一成不变的短句。
    let d = crate::strata_raw::develop(bytes, &opts)
        .map_err(|e| format!("RAW 传感器数据无法显影（{e}）"))?;
    let pixels = (d.width as usize)
        .checked_mul(d.height as usize)
        .ok_or_else(|| "RAW 图片尺寸过大".to_string())?;
    let n3 = pixels.checked_mul(3).ok_or_else(|| "RAW 图片尺寸过大".to_string())?;
    let n4 = pixels.checked_mul(4).ok_or_else(|| "RAW 图片尺寸过大".to_string())?;
    if pixels == 0 || d.rgb.len() < n3 {
        return Err("RAW 显影输出不完整".to_string());
    }
    // 16bit -> 8bit。默认取高 8 位（与历史行为一致）；可选 HDR 分支走滚降曲线。
    let mut rgb8 = Vec::with_capacity(n3);
    match hdr {
        None => {
            for i in 0..n3 {
                rgb8.push((d.rgb[i] >> 8) as u8);
            }
        }
        Some(c) => {
            for i in 0..n3 {
                rgb8.push(hdr_map(d.rgb[i], c));
            }
        }
    }
    // ProPhoto RGB -> sRGB，让显影结果在普通显示器上颜色正确；
    // 转换失败时保留原始编码值，但不再静默：会把原因放进 warning。
    let color_ok = prophoto_to_srgb(&mut rgb8);
    let mut rgba = Vec::with_capacity(n4);
    for i in 0..pixels {
        rgba.push(rgb8[i * 3]);
        rgba.push(rgb8[i * 3 + 1]);
        rgba.push(rgb8[i * 3 + 2]);
        rgba.push(255);
    }
    let mut notes: Vec<String> = Vec::new();
    if !color_ok {
        notes.push("ProPhoto → sRGB 色彩转换失败，已保留原始编码值，颜色可能有偏差。".to_string());
    }
    if !d.warnings.is_empty() {
        notes.push(format!("RAW 显影提示：{}", d.warnings.join("；")));
    }
    if hdr.is_some() {
        notes.push("已应用可选 HDR 高光滚降曲线。".to_string());
    }
    Ok(DecodedImage {
        width: d.width,
        height: d.height,
        rgba,
        source: "sensor",
        warning: (!notes.is_empty()).then(|| notes.join(" ")),
    })
}

/// 返回是否成功完成转换；失败时 `rgb8` 保持原始编码值。
fn prophoto_to_srgb(rgb8: &mut [u8]) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let src = Builtin::ProPhotoCompat.profile();
        let dst = Builtin::Srgb.profile();
        if let Ok(t) = Transform::new(src, dst, Intent::RelativeColorimetric, true) {
            let mut out = vec![0u8; rgb8.len()];
            t.convert_u8(rgb8, 3, &mut out, 3, false);
            rgb8.copy_from_slice(&out);
            true
        } else {
            false
        }
    }))
    .unwrap_or(false)
}

/// 退回方案：提取 RAW 内嵌的完整 JPEG 预览并用 zune-jpeg 解码。
/// 结果明确标注 `source = "embedded-preview"`，并带上「这不是 RAW 显影」的原因。
fn from_embedded_preview(bytes: &[u8], reason: Option<String>) -> Result<DecodedImage, String> {
    let p = crate::strata_raw::embedded_preview(bytes)
        .ok_or_else(|| "这个 RAW 既不能显影，也没有内嵌预览图".to_string())?;
    let mut img = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        decode_preview_jpeg(p.jpeg)
    }))
    .unwrap_or_else(|_| Err("内嵌预览图解码异常".to_string()))?;
    img.source = "embedded-preview";
    img.warning = Some(reason.unwrap_or_else(|| {
        "当前显示的是相机内嵌 JPEG 预览，并非 RAW 显影结果。".to_string()
    }));
    Ok(img)
}

fn decode_preview_jpeg(jpeg: &[u8]) -> Result<DecodedImage, String> {
    use zune_core::bytestream::ZCursor;
    use zune_core::colorspace::ColorSpace;
    use zune_core::options::DecoderOptions;
    let options = DecoderOptions::default()
        .jpeg_set_out_colorspace(ColorSpace::RGB)
        .set_max_width(1usize << 16)
        .set_max_height(1usize << 16);
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(jpeg), options);
    dec.decode_headers()
        .map_err(|_| "内嵌预览 JPEG 头损坏".to_string())?;
    let info = dec.info()
        .ok_or_else(|| "内嵌预览 JPEG 缺少头信息".to_string())?;
    let w = u32::from(info.width);
    let h = u32::from(info.height);
    let data = dec.decode().map_err(|_| "内嵌预览 JPEG 解码失败".to_string())?;
    let pixels = (w as usize)
        .checked_mul(h as usize)
        .ok_or_else(|| "内嵌预览图尺寸过大".to_string())?;
    if pixels == 0 || data.is_empty() || data.len() % pixels != 0 {
        return Err("内嵌预览图像素数据异常".to_string());
    }
    let per = data.len() / pixels;
    if per == 0 || per > 4 {
        return Err("内嵌预览图像素格式暂不支持".to_string());
    }
    let mut rgba = Vec::with_capacity(pixels.saturating_mul(4));
    for i in 0..pixels {
        let b = i * per;
        match per {
            1 => {
                let v = data[b];
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
            3 => rgba.extend_from_slice(&[data[b], data[b + 1], data[b + 2], 255]),
            4 => rgba.extend_from_slice(&[data[b], data[b + 1], data[b + 2], data[b + 3]]),
            _ => {
                let v = data[b];
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
    }
    Ok(DecodedImage {
        width: w,
        height: h,
        rgba,
        source: "image",
        warning: None,
    })
}

/// 用两个 ICC 配置对 RGBA8 像素做色彩转换。
#[tauri::command]
pub fn cms_transform(
    pixels: Vec<u8>,
    src_profile: Vec<u8>,
    dst_profile: Vec<u8>,
    intent: u8,
    bpc: bool,
) -> Result<Vec<u8>, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        do_cms_transform(&pixels, &src_profile, &dst_profile, intent, bpc)
    }))
    .unwrap_or_else(|_| Err("色彩转换过程中发生异常".to_string()))
}

fn do_cms_transform(
    pixels: &[u8],
    src_profile: &[u8],
    dst_profile: &[u8],
    intent: u8,
    bpc: bool,
) -> Result<Vec<u8>, String> {
    if pixels.is_empty() || pixels.len() % 4 != 0 {
        return Err("像素数据必须是非空的 RGBA8 字节流".to_string());
    }
    let count = pixels.len() / 4;
    let intent = Intent::from_u32(u32::from(intent))
        .ok_or_else(|| "渲染意图取值无效，应为 0 到 3".to_string())?;
    let src = Profile::parse(src_profile)
        .map_err(|_| "源 ICC 配置解析失败".to_string())?;
    let dst = Profile::parse(dst_profile)
        .map_err(|_| "目标 ICC 配置解析失败".to_string())?;
    let in_ch = src.channels();
    let out_ch = dst.channels();
    if in_ch == 0 || in_ch > 4 || out_ch == 0 || out_ch > 4 {
        return Err("暂不支持该 ICC 配置对的通道数组合".to_string());
    }
    let t = Transform::new(&src, &dst, intent, bpc)
        .map_err(|_| "无法建立这两个 ICC 配置之间的色彩转换".to_string())?;

    let s_len = count.checked_mul(in_ch).ok_or_else(|| "像素数量过大".to_string())?;
    let d_len = count.checked_mul(out_ch).ok_or_else(|| "像素数量过大".to_string())?;
    let mut sbuf = vec![0u8; s_len];
    for i in 0..count {
        let p = i * 4;
        if in_ch == 1 {
            let l = (u16::from(pixels[p])
                + u16::from(pixels[p + 1])
                + u16::from(pixels[p + 2]))
                / 3;
            sbuf[i] = l as u8;
        } else {
            for k in 0..in_ch {
                sbuf[i * in_ch + k] = if k < 4 { pixels[p + k] } else { 0 };
            }
        }
    }
    let mut dbuf = vec![0u8; d_len];
    t.convert_u8(&sbuf, in_ch, &mut dbuf, out_ch, false);

    let mut out = Vec::with_capacity(pixels.len());
    for i in 0..count {
        let a = pixels[i * 4 + 3];
        match out_ch {
            1 => {
                let g = dbuf[i];
                out.extend_from_slice(&[g, g, g, a]);
            }
            3 => out.extend_from_slice(&[
                dbuf[i * 3],
                dbuf[i * 3 + 1],
                dbuf[i * 3 + 2],
                a,
            ]),
            4 => out.extend_from_slice(&[
                dbuf[i * 4],
                dbuf[i * 4 + 1],
                dbuf[i * 4 + 2],
                dbuf[i * 4 + 3],
            ]),
            _ => {
                let g = dbuf[i * out_ch];
                out.extend_from_slice(&[g, g, g, a]);
            }
        }
    }
    Ok(out)
}

/// 从 PNG / JPEG 里读出嵌入的 ICC 配置字节。
#[tauri::command]
pub fn cms_read_profile(path: String) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(&path)
        .map_err(|_| "读取图片文件失败，请确认路径有效".to_string())?;
    if let Some(icc) = png_icc(&bytes) {
        return Ok(icc);
    }
    if let Some(icc) = jpeg_icc(&bytes) {
        return Ok(icc);
    }
    Err("这张图片里没有嵌入 ICC 色彩配置".to_string())
}

fn png_icc(b: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    if !b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut pos = 8usize;
    while pos + 8 <= b.len() {
        let len = u32::from_be_bytes([b[pos], b[pos + 1], b[pos + 2], b[pos + 3]]) as usize;
        let typ = &b[pos + 4..pos + 8];
        if pos + 12 + len > b.len() {
            break;
        }
        if typ == b"iCCP" {
            let data = &b[pos + 8..pos + 8 + len];
            let nul = data.iter().position(|&c| c == 0)?;
            if data.len() < nul + 3 || data[nul + 1] != 0 {
                return None;
            }
            let mut dec = flate2::read::ZlibDecoder::new(&data[nul + 2..]);
            let mut out = Vec::new();
            dec.read_to_end(&mut out).ok()?;
            return (out.get(36..40) == Some(&b"acsp"[..])).then_some(out);
        }
        pos += 12 + len;
        if typ == b"IEND" {
            break;
        }
    }
    None
}

fn jpeg_icc(b: &[u8]) -> Option<Vec<u8>> {
    if b.len() < 2 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    let mut pos = 2usize;
    let mut parts: Vec<(u8, Vec<u8>)> = Vec::new();
    while pos + 4 <= b.len() {
        if b[pos] != 0xFF {
            break;
        }
        let marker = b[pos + 1];
        if marker == 0xFF {
            pos += 1;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            break; // EOI / SOS：后面是扫描数据
        }
        let len = u16::from_be_bytes([b[pos + 2], b[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > b.len() {
            break;
        }
        let data = &b[pos + 4..pos + 2 + len];
        if marker == 0xE2 && data.starts_with(b"ICC_PROFILE\0") && data.len() >= 14 {
            parts.push((data[12], data[14..].to_vec()));
        }
        pos += 2 + len;
    }
    if parts.is_empty() {
        return None;
    }
    parts.sort_by_key(|p| p.0);
    let mut out = Vec::new();
    for (_, mut v) in parts {
        out.append(&mut v);
    }
    (out.get(36..40) == Some(&b"acsp"[..])).then_some(out)
}

/// 返回内建 ICC 配置字节（srgb / display-p3 / adobe-rgb / gray）。
#[tauri::command]
pub fn cms_builtin_profile(name: String) -> Result<Vec<u8>, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let b = Builtin::from_id(&name).ok_or_else(|| {
            "未知的内建色彩配置，可选 srgb / display-p3 / adobe-rgb / gray".to_string()
        })?;
        Ok::<Vec<u8>, String>((*b.profile().to_bytes()).clone())
    }))
    .unwrap_or_else(|_| Err("生成内建色彩配置时发生异常".to_string()))
}
