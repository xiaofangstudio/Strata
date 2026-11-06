// Windows 发布版不弹出控制台窗口；调试版保留，方便看日志。
// 加 windows 门控，避免 macOS / Linux 上出现无关的属性告警。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    strata_lib::run()
}
