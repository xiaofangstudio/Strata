//! WIA 扫描支持（文件 > 导入 > WIA 支持）。
//!
//! 走真实的 Windows 图像采集 COM（`windows` crate，`IWiaDevMgr2`）：
//! 采集用 `GetImageDlg` 一步到位 —— 由 WIA 弹出系统的设备选择与扫描对话框
//! （厂商驱动界面），扫好的文件直接落进指定文件夹，再把新出现的文件路径
//! 报回给前端。WiaDevMgr2 的 CLSID 取自本机注册表的 WIA.DeviceManager
//! （windows crate 的元数据里没有生成这个 coclass 常量）。
//!
//! 没接扫描仪时这些都是空操作：枚举到 0 台设备就如实返回，
//! 不会假装扫了一张图出来。
//!
//! **平台边界（三平台「一次成功」的前提）**：WIA 是 Windows 独有的 COM API，
//! `windows` crate 在 Cargo.toml 里按 `cfg(windows)` 门控。macOS / Linux 上
//! 三个命令仍然存在（否则 `generate_handler!` 的注册表会随平台变化），
//! 但一律返回明确的「不支持」错误 —— 不静默降级、不假装扫描成功。
//! macOS / Linux 请用系统自带的「图像捕捉 / SANE」把图片存成文件再打开。

use serde::Serialize;

/// 一台采集设备的概要。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WiaDevice {
    pub name: String,
    pub id: String,
}

#[cfg(not(target_os = "windows"))]
const WIA_UNSUPPORTED: &str = "WIA 扫描仅支持 Windows；macOS / Linux 请用系统扫描工具保存图片后再打开";

/* ------------------------------- Windows：真实现 ------------------------------- */

#[cfg(target_os = "windows")]
use windows::core::BSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Devices::ImageAcquisition::{
    IWiaDevMgr2, WIA_DEVINFO_ENUM_ALL, WIA_DEVINFO_ENUM_LOCAL,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};

/// WIA 2.0 设备管理器的 CLSID（本机注册表 WIA.DeviceManager\CLSID）。
#[cfg(target_os = "windows")]
const CLSID_WIADEVMGR2: windows::core::GUID =
    windows::core::GUID::from_u128(0xE1C5D730_7E97_4D8A_9E42_BBAE87C2059F);

#[cfg(target_os = "windows")]
fn dev_mgr() -> Result<IWiaDevMgr2, String> {
    unsafe {
        // 已按别的模式初始化过 COM 就直接用（RPC_E_CHANGED_MODE），不强求
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        CoCreateInstance(&CLSID_WIADEVMGR2, None, CLSCTX_ALL)
            .map_err(|e| format!("WIA 初始化失败：{e}"))
    }
}

/// 列出本机可用的采集设备（扫描仪 / 相机）。
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn wia_devices() -> Result<Vec<WiaDevice>, String> {
    let mgr = dev_mgr()?;
    unsafe {
        let enumerator = mgr
            .EnumDeviceInfo(WIA_DEVINFO_ENUM_LOCAL as i32)
            .map_err(|e| format!("枚举 WIA 设备失败：{e}"))?;
        let count = enumerator
            .GetCount()
            .map_err(|e| format!("枚举 WIA 设备失败：{e}"))?;
        // 设备名要走 IWiaPropertyStorage 读属性；数量是零时不必折腾，
        // 有设备时给出「设备数量」也够前端判断了 —— 这里如实返回数量，
        // 名字让系统的设备选择对话框展示（那是驱动自己维护的准确列表）。
        Ok((0..count)
            .map(|_| WiaDevice {
                name: "WIA 采集设备".to_string(),
                id: String::new(),
            })
            .collect())
    }
}

/// 检查有没有（本机或网络上的）采集设备。`all = true` 时连同离线设备一起数。
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn wia_device_count(all: Option<bool>) -> Result<u32, String> {
    let mgr = dev_mgr()?;
    unsafe {
        let enumerator = mgr
            .EnumDeviceInfo(if all.unwrap_or(false) { WIA_DEVINFO_ENUM_ALL } else { WIA_DEVINFO_ENUM_LOCAL } as i32)
            .map_err(|e| format!("枚举 WIA 设备失败：{e}"))?;
        enumerator
            .GetCount()
            .map_err(|e| format!("枚举 WIA 设备失败：{e}"))
    }
}

/// 打开 WIA 的采集对话框（设备选择 + 厂商扫描界面），扫好的文件落到 `folder`。
///
/// 返回本次扫描新落到文件夹里的文件路径。用户在对话框里点取消时返回空表。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn wia_acquire(
    window: tauri::WebviewWindow,
    folder: String,
    base_name: String,
) -> Result<Vec<String>, String> {
    // Tauri 的 HWND 与 windows crate 的 HWND 是两个类型，取裸指针转接；
    // HWND 不带 Send，跨线程前先降成 isize 再回来
    let hwnd_val = window.hwnd().map_err(|e| format!("拿不到窗口句柄：{e}"))?.0 as isize;

    // 阻塞式模态对话框放到阻塞线程池里跑，不占 Tauri 的异步执行器
    let folder_cloned = folder.clone();
    let base_cloned = base_name.clone();
    let before = std::fs::read_dir(&folder)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let hwnd = HWND(hwnd_val as *mut core::ffi::c_void);
        let mgr = dev_mgr()?;
        unsafe {
            let device_id = BSTR::new();
            let folder_b = BSTR::from(folder_cloned.as_str());
            let file_b = BSTR::from(base_cloned.as_str());
            let mut num_files: i32 = 0;
            let mut file_paths: *mut BSTR = std::ptr::null_mut();
            let mut item: Option<windows::Win32::Devices::ImageAcquisition::IWiaItem2> = None;
            mgr.GetImageDlg(
                0,
                &device_id,
                hwnd,
                &folder_b,
                &file_b,
                &mut num_files,
                &mut file_paths,
                &mut item,
            )
            .map_err(|e| {
                if e.code().0 & 0xFFFF == 0x0001 {
                    "没有可用的 WIA 设备（或用户取消了选择）".to_string()
                } else {
                    format!("WIA 采集失败：{e}")
                }
            })?;
        }
        Ok(())
    })
    .await
    // 内层是任务自己的 Result，外层是 JoinHandle 的 Result，两层都要拆
    .map_err(|e| format!("采集任务失败：{e}"))??;

    // 对话框写文件用什么名字由驱动决定，这里对比前后快照找出新文件，最可靠
    let after = std::fs::read_dir(&folder)
        .map_err(|e| format!("读不了导出文件夹：{e}"))?
        .flatten()
        .map(|e| e.path().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    Ok(after
        .into_iter()
        .filter(|p| !before.contains(p))
        .collect())
}

/* --------------------- macOS / Linux：明确不支持，不假装有 --------------------- */

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn wia_devices() -> Result<Vec<WiaDevice>, String> {
    Err(WIA_UNSUPPORTED.to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn wia_device_count(_all: Option<bool>) -> Result<u32, String> {
    Err(WIA_UNSUPPORTED.to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn wia_acquire(
    window: tauri::WebviewWindow,
    folder: String,
    base_name: String,
) -> Result<Vec<String>, String> {
    let _ = (window, folder, base_name);
    Err(WIA_UNSUPPORTED.to_string())
}
