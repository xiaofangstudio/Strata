//! 会话恢复与项目文件防损。
//!
//! Strata 的正式工程仍然是用户选的 `.strata`；这里只负责**自动恢复稿**：
//! 把编辑中的文档周期性写到应用私有目录，崩溃后能拿回来。所有写入都先落
//! `*.tmp` 再 rename，绝不把用户正式工程或恢复稿写坏一半。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 单条恢复稿元数据。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    key: String,
    name: String,
    width: u32,
    height: u32,
    saved_at: u64,
    #[serde(default)]
    source_path: Option<String>,
}

/// 列表用的只读视图。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    key: String,
    name: String,
    width: u32,
    height: u32,
    saved_at: u64,
    size: u64,
    source_path: Option<String>,
}

/// 恢复稿根目录：`<app local data>/sessions`。
fn session_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("定位会话目录失败：{e}"))?
        .join("sessions");
    fs::create_dir_all(&dir).map_err(|e| format!("创建会话目录失败：{e}"))?;
    Ok(dir)
}

/// key 只允许安全文件名字符；这里就是防路径穿越，不是展示校验。
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(0))
        .unwrap_or(0)
}

/// 原子写小文件：先写同目录 tmp，再 rename 覆盖目标。
fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = target.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        now_ms()
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
    if target.exists() {
        if let Err(e) = fs::remove_file(target) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("移除旧文件失败：{e}"));
        }
    }
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("落盘失败：{e}")
    })
}

/// 写一条恢复稿：`.strata` 是完整工程字节，`*.json` 是列表用的元数据。
#[tauri::command]
pub fn session_write(
    app: AppHandle,
    key: String,
    data: Vec<u8>,
    manifest: SessionManifest,
) -> Result<(), String> {
    if !valid_key(&key) || manifest.key != key {
        return Err("会话 key 不合法".to_string());
    }
    if data.is_empty() {
        return Err("恢复稿内容为空".to_string());
    }
    let dir = session_dir(&app)?;
    let mut m = manifest;
    m.key = key.clone();
    m.saved_at = now_ms();
    let manifest_bytes =
        serde_json::to_vec_pretty(&m).map_err(|e| format!("编码会话信息失败：{e}"))?;
    atomic_write(&dir.join(format!("{key}.strata")), &data)?;
    // 工程字节已经成功落盘；元数据失败只影响列表展示，不算恢复失败。
    if atomic_write(&dir.join(format!("{key}.json")), &manifest_bytes).is_err() {
        return Ok(());
    }
    Ok(())
}

/// 列出全部恢复稿；个别坏条目跳过，不让一条坏文件毁掉整个恢复面板。
#[tauri::command]
pub fn session_list(app: AppHandle) -> Result<Vec<SessionEntry>, String> {
    let dir = session_dir(&app)?;
    let mut out = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|e| format!("读取会话目录失败：{e}"))?;
    for item in rd.flatten() {
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some("strata") {
            continue;
        }
        let key = match path.file_stem().and_then(|s| s.to_str()) {
            Some(k) => k.to_string(),
            None => continue,
        };
        let size = item.metadata().map(|m| m.len()).unwrap_or(0);
        let manifest = fs::read_to_string(dir.join(format!("{key}.json")))
            .ok()
            .and_then(|s| serde_json::from_str::<SessionManifest>(&s).ok());
        let (name, width, height, saved_at, source_path) = match manifest {
            Some(m) => (
                m.name,
                m.width,
                m.height,
                m.saved_at,
                m.source_path,
            ),
            None => (key.clone(), 0, 0, 0, None),
        };
        out.push(SessionEntry {
            key,
            name,
            width,
            height,
            saved_at,
            size,
            source_path,
        });
    }
    out.sort_by_key(|e| std::cmp::Reverse(e.saved_at));
    Ok(out)
}

/// 读取一条完整恢复稿。
#[tauri::command]
pub fn session_read(app: AppHandle, key: String) -> Result<Vec<u8>, String> {
    if !valid_key(&key) {
        return Err("会话 key 不合法".to_string());
    }
    let dir = session_dir(&app)?;
    fs::read(dir.join(format!("{key}.strata"))).map_err(|e| format!("读取恢复稿失败：{e}"))
}

/// 删除一条恢复稿；项目正式保存 / 正常关闭后由前端调用。
#[tauri::command]
pub fn session_delete(app: AppHandle, key: String) -> Result<(), String> {
    if !valid_key(&key) {
        return Err("会话 key 不合法".to_string());
    }
    let dir = session_dir(&app)?;
    let _ = fs::remove_file(dir.join(format!("{key}.strata")));
    let _ = fs::remove_file(dir.join(format!("{key}.json")));
    Ok(())
}

/// 清空全部恢复稿；仅供设置里的手动清理。
#[tauri::command]
pub fn session_clear(app: AppHandle) -> Result<(), String> {
    let dir = session_dir(&app)?;
    let rd = fs::read_dir(&dir).map_err(|e| format!("读取会话目录失败：{e}"))?;
    for item in rd.flatten() {
        let path = item.path();
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if ext == "strata" || ext == "json" || ext.starts_with("tmp-") {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_key_rejects_path_traversal() {
        assert!(valid_key("doc_123-abc"));
        assert!(!valid_key(""));
        assert!(!valid_key("../evil"));
        assert!(!valid_key("a/b"));
        assert!(!valid_key("中文"));
        assert!(!valid_key(&"x".repeat(129)));
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("strata-atomic-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("demo.strata");
        atomic_write(&target, b"first").unwrap();
        atomic_write(&target, b"second").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn manifest_uses_camel_case_for_frontend() {
        let m = SessionManifest {
            key: "k".into(),
            name: "n".into(),
            width: 3,
            height: 4,
            saved_at: 5,
            source_path: Some("p".into()),
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains("\"savedAt\":5"));
        assert!(s.contains("\"sourcePath\":\"p\""));
    }
}
