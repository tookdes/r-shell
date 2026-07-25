//! Interactive host-key confirmation during SSH handshake.
//!
//! When known_hosts has no entry, `check_server_key` emits a Tauri event and
//! waits for the frontend to call `host_key_respond`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
pub struct HostKeyPromptPayload {
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    /// true when a stored key exists but differs (MITM risk).
    pub changed: bool,
}

struct Pending {
    tx: oneshot::Sender<bool>,
}

struct State {
    app: Mutex<Option<AppHandle>>,
    pending: Mutex<HashMap<String, Pending>>,
}

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| State {
        app: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
    })
}

/// Called once from app setup so prompts can emit frontend events.
pub fn set_app_handle(app: AppHandle) {
    if let Ok(mut guard) = state().app.lock() {
        *guard = Some(app);
    }
}

/// Ask the UI to confirm an unknown (or changed) host key.
/// Returns true if the user accepts within the timeout.
pub async fn prompt_user(
    host: &str,
    port: u16,
    algorithm: &str,
    fingerprint: &str,
    changed: bool,
) -> bool {
    let app = {
        let guard = match state().app.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match guard.clone() {
            Some(a) => a,
            None => {
                tracing::error!("host key prompt: AppHandle not set — rejecting");
                return false;
            }
        }
    };

    let prompt_id = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("hk-{nanos}-{}", host.replace(":", "_"))
    };
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = match state().pending.lock() {
            Ok(p) => p,
            Err(_) => return false,
        };
        pending.insert(prompt_id.clone(), Pending { tx });
    }

    let payload = HostKeyPromptPayload {
        prompt_id: prompt_id.clone(),
        host: host.to_string(),
        port,
        algorithm: algorithm.to_string(),
        fingerprint: fingerprint.to_string(),
        changed,
    };

    if let Err(e) = app.emit("host-key-prompt", &payload) {
        tracing::error!("failed to emit host-key-prompt: {e}");
        let mut pending = state().pending.lock().unwrap_or_else(|p| p.into_inner());
        pending.remove(&prompt_id);
        return false;
    }

    // 2 minutes — user may be reading the fingerprint carefully.
    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(accept)) => accept,
        Ok(Err(_)) => false, // sender dropped
        Err(_) => {
            tracing::warn!("host key prompt timed out for {host}:{port}");
            let mut pending = state().pending.lock().unwrap_or_else(|p| p.into_inner());
            pending.remove(&prompt_id);
            false
        }
    }
}

/// Frontend calls this after the user accepts or rejects.
pub fn respond(prompt_id: &str, accept: bool) -> bool {
    let mut pending = match state().pending.lock() {
        Ok(p) => p,
        Err(_) => return false,
    };
    if let Some(entry) = pending.remove(prompt_id) {
        let _ = entry.tx.send(accept);
        true
    } else {
        false
    }
}
