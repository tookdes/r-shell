#!/usr/bin/env python3
"""Update SFTP public-key tests for optional key path and inline key data."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "src-tauri/src/sftp_client.rs"
text = PATH.read_text(encoding="utf-8")

old = """        match config.auth_method {
            SftpAuthMethod::PublicKey {
                key_path,
                passphrase,
            } => {
                assert_eq!(key_path, "/home/user/.ssh/id_rsa");
                assert!(passphrase.is_none());
            }
            _ => panic!("Expected PublicKey auth method"),
        }
"""
new = """        match config.auth_method {
            SftpAuthMethod::PublicKey {
                key_path,
                key_data,
                passphrase,
            } => {
                assert_eq!(key_path.as_deref(), Some("/home/user/.ssh/id_rsa"));
                assert!(key_data.is_none());
                assert!(passphrase.is_none());
            }
            _ => panic!("Expected PublicKey auth method"),
        }
"""

if new not in text:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one SFTP public-key test match, found {count}")
    text = text.replace(old, new, 1)

PATH.write_text(text, encoding="utf-8")
print("SFTP public-key test updated")
