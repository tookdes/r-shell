#!/usr/bin/env python3
"""Apply the verified workspace-sync fixes in an idempotent way.

This script is temporary and is removed before the review PR is merged.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one exact match, found {count}")
    write(path, text.replace(old, new, 1))


def replace_all(path: str, old: str, new: str, expected: int) -> None:
    text = read(path)
    if old not in text and new in text:
        return
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} matches, found {count}")
    write(path, text.replace(old, new))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    if re.search(pattern, text, flags=re.DOTALL) is None:
        if replacement in text:
            return
        raise RuntimeError(f"{path}: regex did not match")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.DOTALL)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex replacement, found {count}")
    write(path, updated)


# ---------------------------------------------------------------------------
# Never persist inline private keys or proxy passwords when Save Passwords is off.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/connection-storage.ts",
    """function maybeStripSecrets<T extends { password?: string; passphrase?: string; vncPassword?: string }>(
  connection: T,
): T {
  if (shouldPersistPasswords()) {
    return connection;
  }
  return {
    ...connection,
    password: undefined,
    passphrase: undefined,
    vncPassword: undefined,
  };
}""",
    """function maybeStripSecrets<T extends {
  password?: string;
  passphrase?: string;
  vncPassword?: string;
  privateKeyData?: string;
  proxyPassword?: string;
}>(connection: T): T {
  if (shouldPersistPasswords()) {
    return connection;
  }
  return {
    ...connection,
    password: undefined,
    passphrase: undefined,
    vncPassword: undefined,
    privateKeyData: undefined,
    proxyPassword: undefined,
  };
}""",
)

# Encrypt SFTP/FTP/VNC credentials before writing connection records.
replace_once(
    "src/components/connection-dialog.tsx",
    """    if (isSftpOrFtp || isDesktop) {
      try {
        // Save connection if requested""",
    """    if (isSftpOrFtp || isDesktop) {
      try {
        const secretsForStorage = await encryptConnectionSecrets({
          password: config.password,
          passphrase: config.passphrase,
          privateKeyData: config.privateKeyData,
          proxyPassword: config.proxyPassword,
        });

        // Save connection if requested""",
)
replace_all(
    "src/components/connection-dialog.tsx",
    """            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
            ftpsEnabled: config.ftpsEnabled,""",
    """            password: secretsForStorage.password,
            privateKeyPath: config.privateKeyPath,
            privateKeyData: secretsForStorage.privateKeyData,
            passphrase: secretsForStorage.passphrase,
            proxyType: config.proxyType,
            proxyHost: config.proxyHost,
            proxyPort: config.proxyPort,
            proxyUsername: config.proxyUsername,
            proxyPassword: secretsForStorage.proxyPassword,
            startupCommand: config.startupCommand,
            ftpsEnabled: config.ftpsEnabled,""",
    expected=2,
)

# Pass inline key/proxy/startup fields through both SFTP connection paths in App.
replace_all(
    "src/App.tsx",
    """                key_path: config.privateKeyPath || null,
                passphrase: config.passphrase || null,
                    ...buildTransportInvokeFields(),""",
    """                key_path: config.privateKeyPath || null,
                key_data: config.privateKeyData || null,
                passphrase: config.passphrase || null,
                ...buildTransportInvokeFields(),
                proxy_type: config.proxyType && config.proxyType !== 'none' ? config.proxyType : null,
                proxy_host: config.proxyHost || null,
                proxy_port: config.proxyPort || null,
                proxy_username: config.proxyUsername || null,
                proxy_password: config.proxyPassword || null,
                startup_command: config.startupCommand || null,""",
    expected=2,
)

# ---------------------------------------------------------------------------
# Close desktop clients during global shutdown and fix accidental indentation.
# ---------------------------------------------------------------------------
replace_once(
    "src-tauri/src/connection_manager.rs",
    """        // Cancel any leftover PTY sessions not paired with a connection entry.
        let mut pty_sessions = self.pty_sessions.write().await;""",
    """        let desktop_ids: Vec<String> = {
            let desktop = self.desktop_connections.read().await;
            desktop.keys().cloned().collect()
        };
        for connection_id in desktop_ids {
            if let Err(error) = self.close_desktop_connection(&connection_id).await {
                tracing::warn!("Failed to close desktop {}: {}", connection_id, error);
            }
        }

        // Cancel any leftover PTY sessions not paired with a connection entry.
        let mut pty_sessions = self.pty_sessions.write().await;""",
)
replace_once(
    "src-tauri/src/connection_manager.rs",
    "        pub async fn list_connections(&self) -> Vec<String> {",
    "    pub async fn list_connections(&self) -> Vec<String> {",
)

# ---------------------------------------------------------------------------
# Make transfer cancellation functional at every unified transfer entry point.
# Dropping the selected transfer future stops the active I/O operation.
# ---------------------------------------------------------------------------
regex_once(
    "src-tauri/src/commands.rs",
    r"#\[tauri::command\]\npub async fn download_remote_file\(.*?\n\}\n\n#\[tauri::command\]\npub async fn upload_remote_file",
    """#[tauri::command]
pub async fn download_remote_file(
    connection_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<FileTransferResponse, String> {
    let cancel = state.transfer_token(&connection_id).await;
    let conn_type = state.get_connection_type(&connection_id).await;

    let transfer = async {
        match conn_type.as_deref() {
            Some("SFTP") => {
                let sftp_map = state.get_sftp_connection().await;
                let connections = sftp_map.read().await;
                let client = connections
                    .get(&connection_id)
                    .ok_or_else(|| anyhow::anyhow!("SFTP connection not found"))?;
                client.download_file(&remote_path, &local_path).await
            }
            Some("FTP") => {
                let ftp_map = state.get_ftp_connection().await;
                let mut connections = ftp_map.write().await;
                let client = connections
                    .get_mut(&connection_id)
                    .ok_or_else(|| anyhow::anyhow!("FTP connection not found"))?;
                client.download_file(&remote_path, &local_path).await
            }
            Some(other) => Err(anyhow::anyhow!("Unsupported protocol: {}", other)),
            None => {
                let connection = state
                    .get_connection(&connection_id)
                    .await
                    .ok_or_else(|| anyhow::anyhow!("No connection found for '{}'", connection_id))?;
                let client = connection.read().await;
                client.download_file(&remote_path, &local_path).await
            }
        }
    };

    let result = tokio::select! {
        _ = cancel.cancelled() => Err(anyhow::anyhow!("Transfer cancelled")),
        result = transfer => result,
    };

    match result {
        Ok(bytes) => Ok(FileTransferResponse {
            success: true,
            bytes_transferred: Some(bytes),
            data: None,
            error: None,
        }),
        Err(error) => Ok(FileTransferResponse {
            success: false,
            bytes_transferred: None,
            data: None,
            error: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn upload_remote_file""",
)
regex_once(
    "src-tauri/src/commands.rs",
    r"#\[tauri::command\]\npub async fn upload_remote_file\(.*?\n\}\n\n#\[tauri::command\]\npub async fn delete_remote_item",
    """#[tauri::command]
pub async fn upload_remote_file(
    connection_id: String,
    local_path: String,
    remote_path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<FileTransferResponse, String> {
    let cancel = state.transfer_token(&connection_id).await;
    let conn_type = state.get_connection_type(&connection_id).await;

    let transfer = async {
        match conn_type.as_deref() {
            Some("SFTP") => {
                let sftp_map = state.get_sftp_connection().await;
                let connections = sftp_map.read().await;
                let client = connections
                    .get(&connection_id)
                    .ok_or_else(|| anyhow::anyhow!("SFTP connection not found"))?;
                client.upload_file(&local_path, &remote_path).await
            }
            Some("FTP") => {
                let ftp_map = state.get_ftp_connection().await;
                let mut connections = ftp_map.write().await;
                let client = connections
                    .get_mut(&connection_id)
                    .ok_or_else(|| anyhow::anyhow!("FTP connection not found"))?;
                client.upload_file(&local_path, &remote_path).await
            }
            Some(other) => Err(anyhow::anyhow!("Unsupported protocol: {}", other)),
            None => {
                let connection = state
                    .get_connection(&connection_id)
                    .await
                    .ok_or_else(|| anyhow::anyhow!("No connection found for '{}'", connection_id))?;
                let client = connection.read().await;
                client.upload_file(&local_path, &remote_path).await
            }
        }
    };

    let result = tokio::select! {
        _ = cancel.cancelled() => Err(anyhow::anyhow!("Transfer cancelled")),
        result = transfer => result,
    };

    match result {
        Ok(bytes) => Ok(FileTransferResponse {
            success: true,
            bytes_transferred: Some(bytes),
            data: None,
            error: None,
        }),
        Err(error) => Ok(FileTransferResponse {
            success: false,
            bytes_transferred: None,
            data: None,
            error: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn delete_remote_item""",
)

# ---------------------------------------------------------------------------
# Stream SFTP/SSH transfers instead of buffering whole files in memory.
# ---------------------------------------------------------------------------
regex_once(
    "src-tauri/src/sftp_client.rs",
    r"    /// Download a remote file to a local path\. Returns bytes downloaded\.\n    pub async fn download_file\(.*?\n    \}\n\n    /// Upload a local file",
    """    /// Download a remote file to a local path. Returns bytes downloaded.
    pub async fn download_file(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))?;

        let mut remote_file = sftp
            .open(remote_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to open remote file '{}': {}", remote_path, e))?;
        let mut local_file = tokio::fs::File::create(local_path).await?;
        let mut buffer = vec![0u8; 32768];
        let mut total_bytes = 0u64;

        loop {
            let count = remote_file.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            local_file.write_all(&buffer[..count]).await?;
            total_bytes += count as u64;
        }
        local_file.flush().await?;
        Ok(total_bytes)
    }

    /// Upload a local file""",
)
regex_once(
    "src-tauri/src/sftp_client.rs",
    r"    /// Upload a local file to a remote path\. Returns bytes uploaded\.\n    pub async fn upload_file\(.*?\n    \}\n\n    /// Create a directory",
    """    /// Upload a local file to a remote path. Returns bytes uploaded.
    pub async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))?;

        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to read local file '{}': {}", local_path, e))?;
        let mut remote_file = sftp.create(remote_path).await.map_err(|e| {
            anyhow::anyhow!("Failed to create remote file '{}': {}", remote_path, e)
        })?;
        let mut buffer = vec![0u8; 32768];
        let mut total_bytes = 0u64;

        loop {
            let count = local_file.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            remote_file.write_all(&buffer[..count]).await?;
            total_bytes += count as u64;
        }
        remote_file.flush().await?;
        Ok(total_bytes)
    }

    /// Create a directory""",
)

regex_once(
    "src-tauri/src/ssh/mod.rs",
    r"    pub async fn download_file\(&self, remote_path: &str, local_path: &str\) -> Result<u64> \{.*?\n    \}\n\n    pub async fn download_file_to_memory",
    """    pub async fn download_file(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        if let Some(session) = &self.session {
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;
            let mut remote_file = sftp.open(remote_path).await?;
            let mut local_file = tokio::fs::File::create(local_path).await?;
            let mut buffer = vec![0u8; 32768];
            let mut total_bytes = 0u64;

            loop {
                let count = remote_file.read(&mut buffer).await?;
                if count == 0 {
                    break;
                }
                local_file.write_all(&buffer[..count]).await?;
                total_bytes += count as u64;
            }
            local_file.flush().await?;
            Ok(total_bytes)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn download_file_to_memory""",
)
regex_once(
    "src-tauri/src/ssh/mod.rs",
    r"    pub async fn upload_file\(&self, local_path: &str, remote_path: &str\) -> Result<u64> \{.*?\n    \}\n\n    pub async fn upload_file_from_bytes",
    """    pub async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        if let Some(session) = &self.session {
            let mut local_file = tokio::fs::File::open(local_path).await?;
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;
            let mut remote_file = sftp.create(remote_path).await?;
            let mut buffer = vec![0u8; 32768];
            let mut total_bytes = 0u64;

            loop {
                let count = local_file.read(&mut buffer).await?;
                if count == 0 {
                    break;
                }
                remote_file.write_all(&buffer[..count]).await?;
                total_bytes += count as u64;
            }
            remote_file.flush().await?;
            Ok(total_bytes)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn upload_file_from_bytes""",
)

# FTP can stream directly from/to async-std files supported by suppaftp.
replace_once(
    "src-tauri/src/ftp_client.rs",
    "use async_std::io::ReadExt;",
    "use async_std::io::{ReadExt, WriteExt};",
)
regex_once(
    "src-tauri/src/ftp_client.rs",
    r"    /// Download a remote file to a local path\. Returns bytes downloaded\.\n    pub async fn download_file\(.*?\n    \}\n\n    /// Upload a local file",
    """    /// Download a remote file to a local path. Returns bytes downloaded.
    pub async fn download_file(&mut self, remote_path: &str, local_path: &str) -> Result<u64> {
        let mut local_file = async_std::fs::File::create(local_path).await?;
        let total_bytes: u64 = ftp_stream!(self, stream => {
            let mut data_stream = stream.retr_as_stream(remote_path).await.map_err(|e| {
                anyhow::anyhow!("Failed to download file '{}': {}", remote_path, e)
            })?;
            let mut buffer = vec![0u8; 32768];
            let mut transferred = 0u64;
            loop {
                let count = data_stream.read(&mut buffer).await.map_err(|e| {
                    anyhow::anyhow!("Failed to read download stream: {}", e)
                })?;
                if count == 0 {
                    break;
                }
                local_file.write_all(&buffer[..count]).await?;
                transferred += count as u64;
            }
            local_file.flush().await?;
            stream.finalize_retr_stream(data_stream).await.map_err(|e| {
                anyhow::anyhow!("Failed to finalize download: {}", e)
            })?;
            transferred
        });
        Ok(total_bytes)
    }

    /// Upload a local file""",
)
regex_once(
    "src-tauri/src/ftp_client.rs",
    r"    /// Upload a local file to a remote path\. Returns bytes uploaded\.\n    pub async fn upload_file\(.*?\n    \}\n\n    /// Create a directory",
    """    /// Upload a local file to a remote path. Returns bytes uploaded.
    pub async fn upload_file(&mut self, local_path: &str, remote_path: &str) -> Result<u64> {
        let mut local_file = async_std::fs::File::open(local_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to read local file '{}': {}", local_path, e))?;
        let total_bytes = local_file.metadata().await?.len();

        ftp_stream!(self, stream => {
            stream.put_file(remote_path, &mut local_file).await.map_err(|e| {
                anyhow::anyhow!("Failed to upload file '{}': {}", remote_path, e)
            })?
        });

        Ok(total_bytes)
    }

    /// Create a directory""",
)

print("workspace-sync fixes applied")
