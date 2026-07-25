//! TOFU-style host key store (inspired by meatshell's known_hosts module).
//!
//! Policy when verification is enabled:
//!   - unknown host  -> accept and remember (OpenSSH accept-new style)
//!   - known + match -> accept silently
//!   - known + differ -> reject (possible MITM); user must clear the entry
//!
//! File format (one entry per line, next to app data):
//!   host:port algorithm SHA256:base64fingerprint

use russh_keys::key::PublicKey;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Result of checking a server key against the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// No entry for this host:port — first time we've seen it.
    Unknown,
    /// Stored key matches the presented one — trusted.
    Match,
    /// A key is stored for this host:port but it differs (possible MITM).
    Changed,
}

/// Serialize disk access so concurrent connects don't race the known_hosts file.
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

fn host_id(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// App data directory for portable/user config files.
fn data_dir() -> PathBuf {
    if let Some(dir) = dirs::data_dir() {
        return dir.join("r-shell");
    }
    PathBuf::from(".").join("r-shell-data")
}

fn known_hosts_path() -> PathBuf {
    data_dir().join("known_hosts")
}

/// Canonical storage line for a presented key: `algo SHA256:fingerprint`.
fn key_record(key: &PublicKey) -> String {
    let algorithm = key.name();
    let fingerprint = key.fingerprint();
    format!("{algorithm} SHA256:{fingerprint}")
}

/// Human-readable fingerprint for error messages.
pub fn fingerprint_label(key: &PublicKey) -> String {
    format!("SHA256:{}", key.fingerprint())
}

/// Parse the file into `(id, key_record)` entries. Missing file -> empty.
fn load_entries() -> Vec<(String, String)> {
    let path = known_hosts_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let mut parts = line.splitn(2, char::is_whitespace);
            let id = parts.next()?.trim();
            let record = parts.next()?.trim();
            if id.is_empty() || record.is_empty() {
                return None;
            }
            Some((id.to_string(), record.to_string()))
        })
        .collect()
}

/// Check a presented server key against the store.
pub fn verify(host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let want = key_record(key);
    let id = host_id(host, port);
    let mut seen_host = false;
    for (entry_id, entry_record) in load_entries() {
        if entry_id != id {
            continue;
        }
        seen_host = true;
        if entry_record == want {
            return HostKeyStatus::Match;
        }
    }
    if seen_host {
        HostKeyStatus::Changed
    } else {
        HostKeyStatus::Unknown
    }
}

/// Remember (or replace) the key for `host:port`.
pub fn remember(host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = known_hosts_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let id = host_id(host, port);
    let record = key_record(key);
    let mut out = String::new();
    for (entry_id, entry_record) in load_entries() {
        if entry_id == id {
            continue;
        }
        out.push_str(&entry_id);
        out.push(' ');
        out.push_str(&entry_record);
        out.push('\n');
    }
    out.push_str(&id);
    out.push(' ');
    out.push_str(&record);
    out.push('\n');

    let mut file = fs::File::create(&path)?;
    file.write_all(out.as_bytes())?;
    Ok(())
}

/// Remove a stored key for `host:port`.
pub fn forget(host: &str, port: u16) -> std::io::Result<()> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = known_hosts_path();
    if !path.exists() {
        return Ok(());
    }
    let id = host_id(host, port);
    let mut out = String::new();
    for (entry_id, entry_record) in load_entries() {
        if entry_id == id {
            continue;
        }
        out.push_str(&entry_id);
        out.push(' ');
        out.push_str(&entry_record);
        out.push('\n');
    }
    fs::write(&path, out)?;
    Ok(())
}

/// Full host-key check used by SSH/SFTP handlers.
///
/// When `enabled` is false, every key is accepted (legacy behaviour).
/// When enabled: Match accepts; Unknown accepts+remembers; Changed rejects.
pub fn check_or_remember(host: &str, port: u16, key: &PublicKey, enabled: bool) -> bool {
    // Sync path kept for tests / callers that cannot await.
    // Unknown keys are auto-accepted (accept-new). Prefer `check_or_prompt`.
    if !enabled {
        return true;
    }
    match verify(host, port, key) {
        HostKeyStatus::Match => true,
        HostKeyStatus::Unknown => {
            let _ = remember(host, port, key);
            true
        }
        HostKeyStatus::Changed => false,
    }
}

/// Interactive TOFU (CrabPort-style):
/// Match → accept; Changed → hard reject (still prompt so UI can show fingerprint);
/// Unknown → prompt user; on accept, remember.
pub async fn check_or_prompt(host: &str, port: u16, key: &PublicKey, enabled: bool) -> bool {
    if !enabled {
        return true;
    }
    let algo = key.name().to_string();
    let fp = fingerprint_label(key);
    match verify(host, port, key) {
        HostKeyStatus::Match => true,
        HostKeyStatus::Unknown => {
            let accepted = crate::host_key_prompt::prompt_user(host, port, &algo, &fp, false).await;
            if accepted {
                if let Err(e) = remember(host, port, key) {
                    tracing::warn!("accepted host key but failed to persist known_hosts: {e}");
                }
            }
            accepted
        }
        HostKeyStatus::Changed => {
            tracing::error!(
                "HOST KEY CHANGED for {host}:{port} — presented {fp} (possible MITM)"
            );
            // Still prompt so the user sees the fingerprint and can choose to trust
            // the new key (which replaces the stored entry via remember).
            let accepted = crate::host_key_prompt::prompt_user(host, port, &algo, &fp, true).await;
            if accepted {
                if let Err(e) = remember(host, port, key) {
                    tracing::warn!("replaced host key but failed to persist known_hosts: {e}");
                }
            }
            accepted
        }
    }
}

