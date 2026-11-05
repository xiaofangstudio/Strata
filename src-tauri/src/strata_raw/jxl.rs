//! JPEG XL 压缩的 DNG tile/strip 解码（DNG 1.7，Compression 52546）。
//!
//! 原始实现依赖 `jxl-oxide`；考虑到本 crate 声明的 rust-version 为 1.77，
//! 该依赖会抬高 MSRV 并显著增加编译体积，移植版不引入 JXL 解码器。
//! 现有依赖里的 `zune-jpeg` / `zune-core` 只实现 JPEG（ITU-T T.81），并不含
//! JPEG XL，因此这里**不伪造解码成功**：改为对输入做明确的错误分类，给出
//! 机器可读的状态码与可展示的中文说明，由上层（`decode.rs`）决定是否回退到
//! 内嵌预览，并把分类透传进用户可见的 `warning`。
//! 来源：ArtCraft PhotoCraft `photocraft-raw`，MIT / Apache-2.0。

use crate::strata_raw::error::{RawError, Result};
use crate::strata_raw::Limits;

/// JPEG XL 数据的状态分类：把「压缩方式不支持」与「数据损坏」分开，
/// 避免上层把两者混成同一种静默失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JxlStatus {
    /// 数据是合法的 JXL 码流，但此版本没有解码器（Unsupported）。
    UnsupportedCompression,
    /// 数据为空 / 截断 / 签名无效 / 几何参数异常，即文件损坏或不是 JXL（Malformed）。
    CorruptOrInvalid,
}

impl JxlStatus {
    /// 稳定的机器可读状态码，前端可据此分流提示。
    pub(crate) fn code(self) -> &'static str {
        match self {
            JxlStatus::UnsupportedCompression => "JXL_UNSUPPORTED_COMPRESSION",
            JxlStatus::CorruptOrInvalid => "JXL_CORRUPT_DATA",
        }
    }

    /// 中文、可直接展示给用户的说明。
    pub(crate) fn message(self) -> &'static str {
        match self {
            JxlStatus::UnsupportedCompression => {
                "这张 DNG 使用 JPEG XL 压缩（DNG 1.7），当前版本暂不支持对该传感器数据做 RAW 显影；请改用相机内嵌预览或先转换格式。"
            }
            JxlStatus::CorruptOrInvalid => {
                "DNG 里的 JPEG XL 数据为空、签名无效或尺寸异常，文件可能已损坏。"
            }
        }
    }

    /// `[CODE] 中文说明`：作为 `RawError` 的消息直接透传到前端 `warning`。
    fn raw_message(self) -> String {
        format!("[{}] {}", self.code(), self.message())
    }
}

/// 判断一段 DNG JPEG XL 数据的类别（结构化的、可单独查询的状态）。
///
/// JXL 裸码流以 `FF 0A` 开头；ISO BMFF 容器以
/// `00 00 00 0C 4A 58 4C 20 0D 0A 87 0A`（`JXL ` 签名）开头。
/// 其它字节序列一律按损坏/无效处理，不假装成「可解码」。
pub(crate) fn classify(src: &[u8]) -> JxlStatus {
    let bare = src.len() >= 2 && src[0] == 0xFF && src[1] == 0x0A;
    const CONTAINER: &[u8] = b"\x00\x00\x00\x0cJXL \r\n\x87\n";
    let boxed = src.len() >= 12 && &src[..12] == CONTAINER;
    if bare || boxed {
        JxlStatus::UnsupportedCompression
    } else {
        JxlStatus::CorruptOrInvalid
    }
}

/// 当前移植版不解码 JPEG XL，按数据状态返回分类明确的错误，绝不假装成功。
///
/// 尺寸 / 位深来自 TIFF IFD：明显非法或超出 [`Limits`] 的一律归到
/// `CorruptOrInvalid`，与「合法的 JXL 但不支持解码」明确区分。
pub(crate) fn decode(
    src: &[u8],
    w: usize,
    h: usize,
    samples: usize,
    bits: u32,
    limits: &Limits,
) -> Result<Vec<u16>> {
    let mut status = classify(src);
    if w == 0 || h == 0 || samples == 0 || bits == 0 || bits > 16 {
        status = JxlStatus::CorruptOrInvalid;
    } else {
        let bpp = (samples as u64).saturating_mul(2); // 输出是 u16
        if limits.check(w as u64, h as u64, bpp).is_err() {
            status = JxlStatus::CorruptOrInvalid;
        }
    }
    match status {
        JxlStatus::UnsupportedCompression => Err(RawError::unsupported(status.raw_message())),
        JxlStatus::CorruptOrInvalid => Err(RawError::malformed(status.raw_message())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_unsupported_from_corrupt() {
        // 合法的 JXL 裸码流 / 容器签名 → 「不支持的压缩」，而不是「损坏」。
        assert_eq!(classify(&[0xFF, 0x0A, 0x00]), JxlStatus::UnsupportedCompression);
        let mut boxed = b"\x00\x00\x00\x0cJXL \r\n\x87\n".to_vec();
        boxed.extend_from_slice(&[0u8; 8]);
        assert_eq!(classify(&boxed), JxlStatus::UnsupportedCompression);
        // 空 / 截断 / 乱数据 → 「损坏」。
        assert_eq!(classify(&[]), JxlStatus::CorruptOrInvalid);
        assert_eq!(classify(&[0xFF]), JxlStatus::CorruptOrInvalid);
        assert_eq!(classify(b"not a jxl stream"), JxlStatus::CorruptOrInvalid);
    }

    #[test]
    fn decode_reports_the_classification() {
        let limits = Limits::default();
        let ok = decode(&[0xFF, 0x0A], 4, 4, 1, 12, &limits).unwrap_err();
        assert!(matches!(ok, RawError::Unsupported(_)));
        assert!(ok.to_string().contains("JXL_UNSUPPORTED_COMPRESSION"));
        let bad = decode(&[], 4, 4, 1, 12, &limits).unwrap_err();
        assert!(matches!(bad, RawError::Malformed(_)));
        assert!(bad.to_string().contains("JXL_CORRUPT_DATA"));
        // 几何参数非法，即使数据签名合法也归为损坏。
        let bad_geom = decode(&[0xFF, 0x0A], 0, 4, 1, 12, &limits).unwrap_err();
        assert!(matches!(bad_geom, RawError::Malformed(_)));
    }
}
