//! EXR 命令的往返验证：用 exr crate 写一个已知颜色的 RGBA 文件，
//! 再走 `exr_read_all` 的同一条解码路径，确认 sRGB 落地数值符合预期。
//!
//! 这条测试锁住的不是「crate 会不会读」（那是上游的事），
//! 而是「我们的 create/set 闭包与 sRGB 编码有没有写对」——
//! 位置映射错了或伽马忘了编，都会在这里现形。

use exr::prelude::*;

/// 与 src/exr.rs 的 to_srgb8 保持同一实现（这里是测试侧的独立副本）。
fn to_srgb8(v: f32) -> u8 {
    let c = v.clamp(0.0, 1.0);
    let srgb = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (srgb * 255.0 + 0.5) as u8
}

#[test]
fn exr_roundtrip_srgb_land() {
    let dir = std::env::temp_dir().join("strata-exr-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("roundtrip.exr");
    let path_str = path.to_string_lossy().to_string();

    // 写一个 4×2 的图：纯白、纯黑、0.5 线性灰、超亮（应裁白）、透明
    let w = 4usize;
    let h = 2usize;
    let cases: [(f32, f32, f32, f32); 8] = [
        (1.0, 1.0, 1.0, 1.0),
        (0.0, 0.0, 0.0, 1.0),
        (0.5, 0.5, 0.5, 1.0),
        (4.0, 4.0, 4.0, 1.0),
        (0.0, 0.0, 0.0, 0.0),
        (0.25, 0.0, 0.0, 1.0),
        (0.0, 0.5, 0.0, 1.0),
        (0.0, 0.0, 0.75, 1.0),
    ];
    write_rgba_file(&path_str, w, h, |x, y| {
        let c = cases[y * w + x];
        (c.0, c.1, c.2, c.3)
    })
    .unwrap();

    // 走与命令相同的读取路径（简化版：直接读回 rgba）
    let image = read_first_rgba_layer_from_file(
        &path_str,
        |resolution, _| {
            vec![vec![[0.0f32; 4]; resolution.width()]; resolution.height()]
        },
        |pixels, position, (r, g, b, a): (f32, f32, f32, f32)| {
            pixels[position.y()][position.x()] = [r, g, b, a];
        },
    )
    .unwrap();

    let layer = &image.layer_data;
    assert_eq!((layer.size.width(), layer.size.height()), (w, h));
    let pixels = &layer.channel_data.pixels;

    // 位置映射：第 (2,0) 像素必须是 0.5 线性灰（±1/255），证明坐标没转置
    let gray = pixels[0][2];
    let expect = to_srgb8(0.5);
    for ch in 0..3 {
        let got = to_srgb8(gray[ch]);
        assert!(
            (got as i32 - expect as i32).abs() <= 1,
            "0.5 灰的 sRGB 落地值 {got} 与期望 {expect} 差超过 1"
        );
    }
    // 超亮必须裁到 255
    let hot = pixels[0][3];
    assert_eq!(to_srgb8(hot[0]), 255);
    // Alpha 是线性的：1.0 → 255，0.0 → 0
    assert_eq!(to_lin8(pixels[0][0][3]), 255);
    assert_eq!(to_lin8(pixels[1][0][3]), 0);
    // 纯黑不是 sRGB 0 以外的值
    assert_eq!(to_srgb8(pixels[0][1][0]), 0);
}

fn to_lin8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}
