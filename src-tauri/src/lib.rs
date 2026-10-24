//! Strata 内核入口。
//!
//! M0 阶段只提供最小可用的文件读写、文件属性查询与运行环境信息，
//! 供前端打通「打开图片 → 显示 → 导出 PNG」这条链路。
//! 后续 M1+ 会把 image / format / engine / export 拆成独立模块。

use std::time::UNIX_EPOCH;

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

/// 取 %LOCALAPPDATA%（Windows）或 $HOME（兜底）。Reelix 联动探测用。
#[tauri::command]
fn local_app_data() -> Result<String, String> {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .map(|v| v.to_string_lossy().into_owned())
        .ok_or_else(|| "定位不到本机数据目录".to_string())
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

/// 单个文件的属性。开始页面「最近文件」用它显示文件真实修改时间与体积。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileStat {
    /// 文件是否存在。最近文件可能已被移动或删除，前端据此提示。
    exists: bool,
    /// 字节数。文件不存在时为 0。
    size: u64,
    /// 最后修改时间（Unix 毫秒）。取不到时为 None。
    modified: Option<u64>,
}

/// 查询单个文件的属性。
///
/// 刻意不返回错误：最近文件列表里出现失效路径是常态，
/// 前端需要的是「存在与否」这个事实，而不是一个异常。
#[tauri::command]
fn files_stat(path: String) -> FileStat {
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            return FileStat {
                exists: false,
                size: 0,
                modified: None,
            }
        }
    };

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok());

    FileStat {
        exists: true,
        size: if meta.is_file() { meta.len() } else { 0 },
        modified,
    }
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

/// 退出应用。开始页面「文件 → 退出 Strata」使用。
///
/// 走内核命令而不是窗口 API：自定义命令在 M0 的权限清单下直接可用，
/// 不必为一次退出再去扩 capabilities。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 启动 Strata。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            write_file_bytes,
            local_app_data,
            files_stat,
            quit_app,
            app_info
        ])
        .run(tauri::generate_context!())
        .expect("Strata 启动失败");
}
