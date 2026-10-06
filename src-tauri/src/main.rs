// Windows 发布版不弹出控制台窗口；调试版保留，方便看日志
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    strata_lib::run()
}
