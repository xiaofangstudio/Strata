//! 与 Groma（小方工作室界面设计工作台）的单向交接。
//!
//! Strata 负责把处理好的画布编成 PNG，这里只做两件事：落到交接目录、
//! 启动 Groma 并告诉它去哪张图。Groma 侧用 `--import-image` 解析路径，
//! 再把图片写进自己的工程资产、生成可编辑的 image 节点。
//!
//! 不做原生工程互转，也不回写选区 —— 两边是各司其职的独立软件。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GromaHandoff {
    /// 交给 Groma 的 PNG 绝对路径。
    pub file: String,
    /// 实际启动的 Groma 可执行文件。
    pub exe: String,
}

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// 只留文件名里的安全字符，避免文档名把路径拼坏。
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .take(48)
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "Strata 图片".to_string()
    } else {
        trimmed.to_string()
    }
}

fn handoff_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "定位不到本机数据目录".to_string())?;
    let dir = PathBuf::from(base).join("Strata").join("Handoff");
    fs::create_dir_all(&dir).map_err(|e| format!("创建交接目录失败：{e}"))?;
    Ok(dir)
}

/// 找 Groma：优先环境变量，其次 Strata 的兄弟项目目录，最后 PATH。
/// 找不到时报的是「怎么配」，不是含糊的「启动失败」。
fn find_groma() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("GROMA_EXE") {
        let p = PathBuf::from(raw.trim().trim_matches('"'));
        if p.is_file() {
            return Ok(p);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("groma.exe"));
            // 开发布局：D:/…/fangwork/Strata/src-tauri/target/release/strata.exe
            // 或根目录 Strata.exe —— 两者向上都能找到 fangwork/Groma。
            let mut up = Some(dir);
            for _ in 0..5 {
                if let Some(d) = up {
                    candidates.push(d.join("Groma/src-tauri/target/release/groma.exe"));
                    candidates.push(d.join("Groma/Groma.exe"));
                    up = d.parent();
                }
            }
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("groma.exe"));
        }
    }
    for p in candidates {
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("没找到 Groma。把 groma.exe 路径写进环境变量 GROMA_EXE 后重启 Strata。".to_string())
}

/// 交接目录只留最近 8 张，免得反复发送把磁盘堆满。
fn prune(dir: &Path) {
    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("png"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => return,
    };
    files.sort_by_key(|p| {
        fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0)
    });
    while files.len() > 8 {
        if let Some(old) = files.first() {
            let _ = fs::remove_file(old);
            files.remove(0);
        } else {
            break;
        }
    }
}

#[tauri::command]
pub fn send_image_to_groma(data: Vec<u8>, name: String) -> Result<GromaHandoff, String> {
    // 魔法数校验：别把坏字节当成图片送出去，到了 Groma 那边更难查。
    let png_magic = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if data.len() < png_magic.len() || !data.starts_with(&png_magic) {
        return Err("要发送的不是 PNG 图片".to_string());
    }

    let exe = find_groma()?;
    let dir = handoff_dir()?;
    let file = dir.join(format!("{}-{}.png", safe_name(&name), stamp()));
    fs::write(&file, &data).map_err(|e| format!("写交接图片失败：{e}"))?;
    prune(&dir);

    let mut command = Command::new(&exe);
    command.arg("--import-image").arg(&file);
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
        .spawn()
        .map_err(|e| format!("启动 Groma 失败：{e}"))?;

    Ok(GromaHandoff {
        file: file.to_string_lossy().into_owned(),
        exe: exe.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_strips_path_characters() {
        assert_eq!(safe_name("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(safe_name("  ...  "), "Strata 图片");
    }

    #[test]
    fn png_magic_check() {
        let good = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2];
        assert!(good.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
        let bad = [0x89, b'P', b'N', b'G'];
        assert!(!bad.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
    }
}
