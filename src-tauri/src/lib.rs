//! Strata 内核入口。
//!
//! M0 阶段只提供最小可用的文件读写与运行环境信息，供前端打通
//! 「打开图片 → 显示 → 导出 PNG」这条链路。
//! 后续 M1+ 会把 image / format / engine / export 拆成独立模块。

use serde::Serialize;

/// 运行环境信息，开始页面的「关于」区块使用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    platform: &'static str,
    arch: &'static str,
    /// 界面语言，M0 固定为简体中文
    locale: &'static str,
}

/// 读取本地文件的原始字节。M0 用于把图片交给前端解码。
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))
}

/// 把原始字节写入本地文件。M0 用于导出 PNG。
#[tauri::command]
fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("写入文件失败：{e}"))
}

/// 返回应用与运行环境信息。
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "Strata",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        locale: "zh-CN",
    }
}

/// 启动 Strata。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            write_file_bytes,
            app_info
        ])
        .run(tauri::generate_context!())
        .expect("Strata 启动失败");
}
