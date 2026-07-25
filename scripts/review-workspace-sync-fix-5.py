#!/usr/bin/env python3
"""Wire legacy SSH transfer commands into the shared cancellation controller."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "src-tauri/src/commands.rs"
text = PATH.read_text(encoding="utf-8")


def replace_regex(pattern: str, replacement: str) -> None:
    global text
    if replacement in text:
        return
    text, count = re.subn(pattern, replacement, text, count=1, flags=re.DOTALL)
    if count != 1:
        raise RuntimeError(f"expected one legacy transfer match, found {count}")


replace_regex(
    r"/// @deprecated Use `download_remote_file` instead\. Kept for backward compatibility\.\n#\[tauri::command\]\npub async fn sftp_download_file\(.*?\n\}\n\n/// @deprecated Use `upload_remote_file` instead\.",
    """/// @deprecated Use `download_remote_file` instead. Kept for backward compatibility.
#[tauri::command]
pub async fn sftp_download_file(
    request: FileTransferRequest,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<FileTransferResponse, String> {
    let cancel = state.transfer_token(&request.connection_id).await;
    let connection = state
        .get_connection(&request.connection_id)
        .await
        .ok_or("Connection not found")?;
    let client = connection.read().await;

    let transfer = async {
        if request.local_path.is_empty() {
            client
                .download_file_to_memory(&request.remote_path)
                .await
                .map(|data| {
                    let bytes = data.len() as u64;
                    (bytes, Some(data))
                })
        } else {
            client
                .download_file(&request.remote_path, &request.local_path)
                .await
                .map(|bytes| (bytes, None))
        }
    };

    let result = tokio::select! {
        _ = cancel.cancelled() => Err(anyhow::anyhow!("Transfer cancelled")),
        result = transfer => result,
    };

    match result {
        Ok((bytes, data)) => Ok(FileTransferResponse {
            success: true,
            bytes_transferred: Some(bytes),
            data,
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

/// @deprecated Use `upload_remote_file` instead.""",
)

replace_regex(
    r"/// @deprecated Use `upload_remote_file` instead\. Kept for backward compatibility\.\n#\[tauri::command\]\npub async fn sftp_upload_file\(.*?\n\}\n\n// File operation commands",
    """/// @deprecated Use `upload_remote_file` instead. Kept for backward compatibility.
#[tauri::command]
pub async fn sftp_upload_file(
    request: FileTransferRequest,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<FileTransferResponse, String> {
    let cancel = state.transfer_token(&request.connection_id).await;
    let connection = state
        .get_connection(&request.connection_id)
        .await
        .ok_or("Connection not found")?;
    let client = connection.read().await;

    let transfer = async {
        if let Some(data) = &request.data {
            client
                .upload_file_from_bytes(data, &request.remote_path)
                .await
        } else {
            client
                .upload_file(&request.local_path, &request.remote_path)
                .await
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

// File operation commands""",
)

PATH.write_text(text, encoding="utf-8")
print("legacy transfer cancellation wired")
