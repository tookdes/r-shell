#!/usr/bin/env python3
"""Remove SHA-1 ssh-rsa from the default host-key algorithm list."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "src-tauri/src/ssh/mod.rs"
text = PATH.read_text(encoding="utf-8")

old_comment = """/// Preferred host-key algorithms advertised to the server, ordered from most to
/// least preferred.  RSA variants (including the legacy `ssh-rsa` / SHA-1) are
/// included so that older servers that only offer RSA host keys are still
/// reachable.  The `openssl` feature on `russh` / `russh-keys` must be enabled
/// for the RSA entries to have any effect.
"""
new_comment = """/// Preferred host-key algorithms advertised to the server, ordered from most to
/// least preferred. RSA keys remain supported through rsa-sha2-256/512; the
/// legacy `ssh-rsa` signature algorithm is intentionally excluded because it
/// relies on SHA-1. The `openssl` feature on `russh` / `russh-keys` must be
/// enabled for the RSA-SHA2 entries to have any effect.
"""
if old_comment in text:
    text = text.replace(old_comment, new_comment, 1)
elif new_comment not in text:
    raise RuntimeError("SSH host-key algorithm comment did not match")

old_entry = "    russh_keys::key::SSH_RSA,\n"
if old_entry in text:
    text = text.replace(old_entry, "", 1)
elif "SSH_RSA" in text.split("pub static PREFERRED_HOST_KEY_ALGOS", 1)[1].split("];", 1)[0]:
    raise RuntimeError("unexpected SSH_RSA formatting")

PATH.write_text(text, encoding="utf-8")
print("legacy SHA-1 ssh-rsa removed from defaults")
