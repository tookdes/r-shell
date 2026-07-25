#!/usr/bin/env python3
"""Repair test fixtures affected by the expanded SSH configuration."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "src-tauri/src/ssh/tests.rs"
text = PATH.read_text(encoding="utf-8")

replacements = [
    (
        """        let config = SshConfig {
            host: TEST_HOST.to_string(),
            port: TEST_PORT,
            username: TEST_USERNAME.to_string(),
            auth_method: AuthMethod::Password {
                password: "wrongpassword".to_string(),
            },
        };""",
        """        let config = SshConfig {
            host: TEST_HOST.to_string(),
            port: TEST_PORT,
            username: TEST_USERNAME.to_string(),
            auth_method: AuthMethod::Password {
                password: "wrongpassword".to_string(),
            },
            connection_timeout_secs: Some(30),
            keepalive_interval_secs: Some(60),
            verify_host_key: false,
            proxy: None,
            startup_command: None,
        };""",
    ),
    (
        """        let config = SshConfig {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: AuthMethod::PublicKey { key_path: Some("/nonexistent/path/id_rsa".to_string()), key_data: None,
                passphrase: None,
            },
        };""",
        """        let config = SshConfig {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: AuthMethod::PublicKey {
                key_path: Some("/nonexistent/path/id_rsa".to_string()),
                key_data: None,
                passphrase: None,
            },
            connection_timeout_secs: Some(1),
            keepalive_interval_secs: Some(0),
            verify_host_key: false,
            proxy: None,
            startup_command: None,
        };""",
    ),
]

for old, new in replacements:
    if new in text:
        continue
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one test fixture match, found {count}")
    text = text.replace(old, new, 1)

PATH.write_text(text, encoding="utf-8")
print("workspace-sync test fixtures repaired")
