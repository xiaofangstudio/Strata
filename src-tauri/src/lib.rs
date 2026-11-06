//! Strata 内核入口。
//!
//! M0 阶段只提供最小可用的文件读写、文件属性查询与运行环境信息，
//! 供前端打通「打开图片 → 显示 → 导出 PNG」这条链路。
//! 后续 M1+ 会把 image / format / engine / export 拆成独立模块。

use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{Emitter, Manager};

mod exr;
mod wia;
// 移植自 ArtCraft PhotoCraft 的纯 Rust RAW 解码与 ICC 色彩管理模块。
// 这两个库自带大量本应用暂未用到的公开 API，抑制移植副本的死代码告警。
#[allow(dead_code, unused_imports)]
mod strata_raw;
#[allow(dead_code, unused_imports)]
mod strata_cms;
// HEIC 解码封装与统一的解码 / 色彩管理命令
mod heif;
mod decode;

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

/// 窗口磨砂（Windows Acrylic）的真实开关。
///
/// 不用 `Window::setEffects` 的原因（Tauri 2.12 源码实证）：
/// `vibrancy::set_window_effects` 在 Windows 分支调用 `apply_acrylic` 后**丢弃**了
/// Result 并一律返回 `Ok(())`，而且只采用 effects 数组里的第一个效果。前端因此
/// 拿不到「系统其实没采纳 Acrylic」这个事实 —— 会出现开关显示已开、窗口却不磨砂。
/// 这里直接调用并把失败真返回给前端，失败时浮出可见降级提示，不假装成功。
/// macOS 走 `setEffects(UnderWindowBackground)`，Linux 官方明确不支持，均由前端分支处理。
#[tauri::command]
fn window_frost_acrylic(
    window: tauri::WebviewWindow,
    enabled: bool,
    color: Option<(u8, u8, u8)>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let (r, g, b) = color.unwrap_or((232, 237, 245));
            // alpha 传 1：window-vibrancy 对 0 会自行改成 1，显式写更清楚。
            window_vibrancy::apply_acrylic(&window, Some((r, g, b, 1)))
                .map_err(|e| format!("系统 Acrylic 不可用：{e}"))?;
        } else {
            // 关闭时把三种系统背景效果都清干净，避免残留一层模糊。
            window_vibrancy::clear_acrylic(&window)
                .map_err(|e| format!("清除 Acrylic 失败：{e}"))?;
            let _ = window_vibrancy::clear_mica(&window);
            let _ = window_vibrancy::clear_blur(&window);
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, enabled, color);
        Err("当前平台没有 Windows Acrylic（macOS / Linux 由各自分支处理）".to_string())
    }
}

/// 启动意图：这次进程到底是「用户主动打开软件」还是「用 Strata 打开某个文件」。
///
/// 两件事在界面上必须分开：前者进欢迎页，后者直接进编辑器。
/// 之前前端只拿到一串命令行参数自己去猜，猜不到就停在欢迎页，
/// 于是「双击图片用 Strata 打开」看起来像是没生效。判定改在内核做，
/// 前端拿到的就是一个已经判好的结论。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchIntent {
    /// "file" = 带文件启动；"home" = 主动打开软件。
    kind: &'static str,
    /// kind == "file" 时的文件绝对路径。
    path: Option<String>,
    /// 排除了程序自身路径的命令行参数，排错时有用。
    args: Vec<String>,
}

/// 判定本次启动的意图。
///
/// 规则与前端 `core/launch.ts` 的兜底实现保持一致：跳过开关参数，
/// 取第一个指向真实存在文件的参数。带引号的路径（Windows 传参常见）先去引号。
/// 找不到就当作主动打开软件 —— 判定不出错最多是让用户自己点。
#[tauri::command]
fn launch_intent() -> LaunchIntent {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let target = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| a.trim().trim_matches('"'))
        .find(|p| !p.is_empty() && std::path::Path::new(p).exists())
        .map(|p| p.to_string());

    match target {
        Some(path) => LaunchIntent {
            kind: "file",
            path: Some(path),
            args,
        },
        None => LaunchIntent {
            kind: "home",
            path: None,
            args,
        },
    }
}

/// 单个文件夹条目。「浏览」（Bridge 式文件浏览）用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

/// 列出一个文件夹的直接子项（不递归）。
///
/// 单个子项读失败就跳过而不是整次失败：浏览一个有几万个文件的目录时，
/// 个别文件被占用/无权限是常态，不该让整个面板因此空白。
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&path).map_err(|e| format!("读不了这个文件夹：{e}"))?;
    for e in rd.flatten() {
        let p = e.path();
        let is_dir = p.is_dir();
        let size = e
            .metadata()
            .map(|m| if m.is_file() { m.len() } else { 0 })
            .unwrap_or(0);
        out.push(DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir,
            size,
        });
    }
    Ok(out)
}

/// 启动 Strata。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 单实例：Strata 已经在跑时再双击一张图，不再新起一个进程，
        // 而是把要打开的文件转给已经在跑的那个窗口。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let target = argv
                .iter()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .map(|a| a.trim().trim_matches('"'))
                .find(|p| !p.is_empty() && std::path::Path::new(p).exists())
                .map(|p| p.to_string());

            if let Some(path) = target {
                let _ = app.emit("strata://launch-open", path);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            write_file_bytes,
            local_app_data,
            files_stat,
            quit_app,
            app_info,
            window_frost_acrylic,
            launch_intent,
            list_dir,
            exr::exr_part_info,
            exr::exr_read_all,
            wia::wia_devices,
            wia::wia_device_count,
            wia::wia_acquire,
            decode::decode_heic,
            decode::decode_raw,
            decode::cms_transform,
            decode::cms_read_profile,
            decode::cms_builtin_profile
        ])
        .run(tauri::generate_context!())
        .expect("Strata 启动失败");
}
