#!/usr/bin/env python3
"""Resolve actionable clippy findings while retaining planned compatibility APIs."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    file_path = ROOT / path
    text = file_path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once("src-tauri/src/commands.rs", "use base64::Engine as _;\n", "")
replace_once(
    "src-tauri/src/commands.rs",
    "disk_output.trim().split_whitespace()",
    "disk_output.split_whitespace()",
)
replace_once(
    "src-tauri/src/commands.rs",
    'disk_parts.get(0).unwrap_or(&"0")',
    'disk_parts.first().unwrap_or(&"0")',
)

replace_once("src-tauri/src/sftp_client.rs", "use russh_keys::*;\n", "")
replace_once(
    "src-tauri/src/sftp_client.rs",
    "std::io::Error::new(std::io::ErrorKind::Other, e.to_string())",
    "std::io::Error::other(e.to_string())",
)
replace_once(
    "src-tauri/src/sftp_client.rs",
    "attrs.permissions.map(|p| format_permissions(p))",
    "attrs.permissions.map(format_permissions)",
)
replace_once(
    "src-tauri/src/ssh/mod.rs",
    "std::io::Error::new(std::io::ErrorKind::Other, e.to_string())",
    "std::io::Error::other(e.to_string())",
)
replace_once(
    "src-tauri/src/os_detect.rs",
    "match uname.as_ref() {",
    "match uname {",
)

replace_once(
    "src-tauri/src/connection_manager.rs",
    """use tokio_util::sync::CancellationToken;

pub struct ConnectionManager {""",
    """use tokio_util::sync::CancellationToken;

type DesktopClient = Arc<RwLock<Box<dyn DesktopProtocol>>>;
type DesktopConnectionMap = Arc<RwLock<HashMap<String, DesktopClient>>>;

pub struct ConnectionManager {""",
)
replace_once(
    "src-tauri/src/connection_manager.rs",
    "desktop_connections: Arc<RwLock<HashMap<String, Arc<RwLock<Box<dyn DesktopProtocol>>>>>>",
    "desktop_connections: DesktopConnectionMap",
)

print("actionable clippy findings fixed")
