use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const MAX_DIAGNOSTICS_BYTES: u64 = 5 * 1024 * 1024;
const FILE_NAME: &str = "terminal-diagnostics.jsonl";
const ROTATED_FILE_NAME: &str = "terminal-diagnostics.jsonl.1";
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDiagnosticEvent {
    pub timestamp: String,
    pub event: String,
    #[serde(default)]
    pub connection_hash: Option<String>,
    #[serde(default)]
    pub renderer: Option<String>,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub cols: Option<u32>,
    #[serde(default)]
    pub rows: Option<u32>,
    #[serde(default)]
    pub websocket_state: Option<String>,
    #[serde(default)]
    pub pty_generation: Option<u64>,
    #[serde(default)]
    pub frames_received: Option<u64>,
    #[serde(default)]
    pub bytes_received: Option<u64>,
    #[serde(default)]
    pub wrong_connection_frames_dropped: Option<u64>,
    #[serde(default)]
    pub fit: Option<bool>,
    #[serde(default)]
    pub resize: Option<bool>,
    #[serde(default)]
    pub dispose: Option<bool>,
    #[serde(default)]
    pub reconnect: Option<bool>,
    #[serde(default)]
    pub renderer_context_loss: Option<bool>,
    #[serde(default)]
    pub output_watermark: Option<u64>,
}

fn diagnostics_paths(log_dir: &Path) -> (PathBuf, PathBuf) {
    (log_dir.join(FILE_NAME), log_dir.join(ROTATED_FILE_NAME))
}

fn rotate_if_needed(path: &Path, rotated_path: &Path, incoming_bytes: u64) -> Result<(), String> {
    let current_bytes = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(format!("failed to stat terminal diagnostics: {error}")),
    };

    if current_bytes.saturating_add(incoming_bytes) <= MAX_DIAGNOSTICS_BYTES {
        return Ok(());
    }

    match fs::remove_file(rotated_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to remove rotated terminal diagnostics: {error}"
            ))
        }
    }

    match fs::rename(path, rotated_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to rotate terminal diagnostics: {error}")),
    }
}

#[tauri::command]
pub fn append_terminal_diagnostics(
    app: tauri::AppHandle,
    events: Vec<TerminalDiagnosticEvent>,
) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }

    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "terminal diagnostics write lock poisoned".to_string())?;

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed to resolve app log dir: {error}"))?;
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("failed to create app log dir: {error}"))?;

    let mut serialized = Vec::new();
    for event in events {
        serde_json::to_writer(&mut serialized, &event)
            .map_err(|error| format!("failed to serialize terminal diagnostic: {error}"))?;
        serialized.push(b'\n');
    }

    let (path, rotated_path) = diagnostics_paths(&log_dir);
    rotate_if_needed(&path, &rotated_path, serialized.len() as u64)?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open terminal diagnostics: {error}"))?;
    file.write_all(&serialized)
        .map_err(|error| format!("failed to write terminal diagnostics: {error}"))?;
    file.flush()
        .map_err(|error| format!("failed to flush terminal diagnostics: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_event_contains_only_declared_metadata_fields() {
        let event = TerminalDiagnosticEvent {
            timestamp: "2026-08-27T00:00:00.000Z".into(),
            event: "frame_batch".into(),
            connection_hash: Some("deadbeef".into()),
            renderer: Some("dom".into()),
            active: Some(true),
            cols: Some(120),
            rows: Some(40),
            websocket_state: Some("open".into()),
            pty_generation: Some(7),
            frames_received: Some(10),
            bytes_received: Some(4096),
            wrong_connection_frames_dropped: Some(1),
            fit: None,
            resize: None,
            dispose: None,
            reconnect: None,
            renderer_context_loss: None,
            output_watermark: Some(8192),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("deadbeef"));
        assert!(!json.contains("password"));
        assert!(!json.contains("privateKey"));
        assert!(!json.contains("terminalText"));
    }
}
