//! AES-256-GCM encryption for credentials stored by the frontend.
//!
//! Key material lives at `{data_dir}/r-shell/.secrets_key` (32 random bytes).
//! Blob format: base64(nonce[12] || ciphertext+tag).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

static KEY_LOCK: Mutex<()> = Mutex::new(());

fn data_dir() -> PathBuf {
    if let Some(dir) = dirs::data_dir() {
        return dir.join("r-shell");
    }
    PathBuf::from(".").join("r-shell-data")
}

fn key_path() -> PathBuf {
    data_dir().join(".secrets_key")
}

fn load_or_create_key() -> Result<[u8; KEY_LEN], String> {
    let _guard = KEY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = key_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create data dir: {e}"))?;
    }
    if path.exists() {
        let bytes = fs::read(&path).map_err(|e| format!("read secrets key: {e}"))?;
        if bytes.len() != KEY_LEN {
            return Err("secrets key file is corrupted".into());
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }
    let mut key = [0u8; KEY_LEN];
    getrandom::fill(&mut key).map_err(|e| format!("rng failed: {e}"))?;
    fs::write(&path, key).map_err(|e| format!("write secrets key: {e}"))?;
    // Best-effort restrictive permissions on Unix; no-op on Windows.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

/// Encrypt plaintext; returns base64 blob.
pub fn encrypt_string(plaintext: &str) -> Result<String, String> {
    let key = load_or_create_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("aes init: {e}"))?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).map_err(|e| format!("rng failed: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("encrypt failed: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}

/// Decrypt a blob produced by [`encrypt_string`].
pub fn decrypt_string(blob_b64: &str) -> Result<String, String> {
    let key = load_or_create_key()?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(blob_b64.trim())
        .map_err(|e| format!("invalid ciphertext: {e}"))?;
    if blob.len() < NONCE_LEN + 1 {
        return Err("ciphertext too short".into());
    }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("aes init: {e}"))?;
    let nonce = Nonce::from_slice(&blob[..NONCE_LEN]);
    let plain = cipher
        .decrypt(nonce, &blob[NONCE_LEN..])
        .map_err(|_| "decrypt failed (wrong key or corrupted data)".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("utf8: {e}"))
}
