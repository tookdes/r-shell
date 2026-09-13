//! AES-256-GCM encryption for credentials stored by the frontend.
//!
//! New writes use a random app master key stored in the OS keychain and the
//! versioned payload `v2:<nonce-b64>:<ciphertext-b64>`. Legacy payloads remain
//! readable with the historical `{data_dir}/r-shell/.secrets_key` so existing
//! saved credentials are not lost during migration.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const V2_PREFIX: &str = "v2:";
const MASTER_KEY_SERVICE: &str = "com.aiden.r-shell.dataprotection";
const MASTER_KEY_USER: &str = "connection-secrets";

static MASTER_KEY_CACHE: Mutex<Option<[u8; KEY_LEN]>> = Mutex::new(None);

fn data_dir() -> PathBuf {
    if let Some(dir) = dirs::data_dir() {
        return dir.join("r-shell");
    }
    PathBuf::from(".").join("r-shell-data")
}

fn legacy_key_path() -> PathBuf {
    data_dir().join(".secrets_key")
}

fn random_fill(buf: &mut [u8]) -> Result<(), String> {
    getrandom::fill(buf).map_err(|e| format!("rng failed: {e}"))
}

fn master_key() -> Result<[u8; KEY_LEN], String> {
    if let Some(key) = *MASTER_KEY_CACHE
        .lock()
        .map_err(|e| format!("key cache lock poisoned: {e}"))?
    {
        return Ok(key);
    }

    let entry = keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_USER)
        .map_err(|e| format!("failed to open OS keychain entry: {e}"))?;

    let key = match entry.get_password() {
        Ok(stored) => {
            let decoded = BASE64
                .decode(stored.trim())
                .map_err(|e| format!("stored master key is corrupt: {e}"))?;
            if decoded.len() != KEY_LEN {
                return Err("stored master key has wrong length".into());
            }
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(&decoded);
            key
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; KEY_LEN];
            random_fill(&mut key)?;
            entry
                .set_password(&BASE64.encode(key))
                .map_err(|e| format!("failed to store master key in OS keychain: {e}"))?;
            key
        }
        Err(e) => return Err(format!("failed to read master key from OS keychain: {e}")),
    };

    *MASTER_KEY_CACHE
        .lock()
        .map_err(|e| format!("key cache lock poisoned: {e}"))? = Some(key);
    Ok(key)
}

fn load_legacy_key() -> Result<[u8; KEY_LEN], String> {
    let path = legacy_key_path();
    let bytes = fs::read(&path).map_err(|e| {
        format!(
            "legacy secrets key is unavailable at {}: {e}",
            path.display()
        )
    })?;
    if bytes.len() != KEY_LEN {
        return Err("legacy secrets key file is corrupted".into());
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn encrypt_v2_with_key(plaintext: &str, key: &[u8; KEY_LEN]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes init: {e}"))?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    random_fill(&mut nonce_bytes)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|e| format!("encrypt failed: {e}"))?;
    Ok(format!(
        "v2:{}:{}",
        BASE64.encode(nonce_bytes),
        BASE64.encode(ciphertext)
    ))
}

fn decrypt_v2_with_key(payload: &str, key: &[u8; KEY_LEN]) -> Result<String, String> {
    let mut parts = payload.splitn(3, ':');
    if parts.next() != Some("v2") {
        return Err("unrecognized sealed secret format".into());
    }
    let nonce_b64 = parts.next().ok_or("missing nonce")?;
    let ciphertext_b64 = parts.next().ok_or("missing ciphertext")?;
    let nonce = BASE64
        .decode(nonce_b64)
        .map_err(|e| format!("invalid nonce: {e}"))?;
    if nonce.len() != NONCE_LEN {
        return Err("invalid nonce length".into());
    }
    let ciphertext = BASE64
        .decode(ciphertext_b64)
        .map_err(|e| format!("invalid ciphertext: {e}"))?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes init: {e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "decrypt failed (wrong key or corrupted data)".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("utf8: {e}"))
}

fn decrypt_legacy_with_key(blob_b64: &str, key: &[u8; KEY_LEN]) -> Result<String, String> {
    let blob = BASE64
        .decode(blob_b64.trim())
        .map_err(|e| format!("invalid legacy ciphertext: {e}"))?;
    if blob.len() < NONCE_LEN + 16 {
        return Err("legacy ciphertext too short".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes init: {e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&blob[..NONCE_LEN]), &blob[NONCE_LEN..])
        .map_err(|_| "legacy decrypt failed (wrong key or corrupted data)".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("utf8: {e}"))
}

pub fn encrypt_string(plaintext: &str) -> Result<String, String> {
    encrypt_v2_with_key(plaintext, &master_key()?)
}

pub fn decrypt_string(payload: &str) -> Result<String, String> {
    let payload = payload.trim();
    if payload.starts_with(V2_PREFIX) {
        decrypt_v2_with_key(payload, &master_key()?)
    } else {
        decrypt_legacy_with_key(payload, &load_legacy_key()?)
    }
}

#[allow(dead_code)]
pub fn looks_encrypted(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with(V2_PREFIX) {
        return true;
    }
    if trimmed.len() < 24 {
        return false;
    }
    BASE64
        .decode(trimmed)
        .map(|raw| raw.len() >= NONCE_LEN + 16)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_round_trip_is_versioned() {
        let key = [7u8; KEY_LEN];
        let sealed = encrypt_v2_with_key("secret-value", &key).unwrap();
        assert!(sealed.starts_with("v2:"));
        assert_eq!(decrypt_v2_with_key(&sealed, &key).unwrap(), "secret-value");
    }

    #[test]
    fn v2_rejects_wrong_key() {
        let sealed = encrypt_v2_with_key("secret-value", &[7u8; KEY_LEN]).unwrap();
        assert!(decrypt_v2_with_key(&sealed, &[8u8; KEY_LEN]).is_err());
    }

    #[test]
    fn legacy_format_remains_readable_with_legacy_key() {
        let key = [9u8; KEY_LEN];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = [3u8; NONCE_LEN];
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), b"legacy".as_ref())
            .unwrap();
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ciphertext);
        let encoded = BASE64.encode(blob);
        assert_eq!(decrypt_legacy_with_key(&encoded, &key).unwrap(), "legacy");
    }
}
