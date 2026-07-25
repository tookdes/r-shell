#!/usr/bin/env python3
"""Align secure defaults and remove unsupported proxy choices."""

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


replace_once(
    "src/lib/connection-storage.ts",
    """    if (!raw) return true;
    const parsed = JSON.parse(raw) as { savePasswords?: unknown };
    // Default true for backward compatibility when key is absent; explicit false strips secrets.
    return parsed.savePasswords !== false;
  } catch {
    return true;""",
    """    if (!raw) return false;
    const parsed = JSON.parse(raw) as { savePasswords?: unknown };
    // Secrets are persisted only after the user explicitly enables the setting.
    return parsed.savePasswords === true;
  } catch {
    return false;""",
)

# Keep the stored-data union compatible with legacy profiles, but do not expose
# an option that the backend cannot establish.
replace_once(
    "src/components/connection-dialog.tsx",
    "                       <SelectItem value=\"socks4\">{t('connectionDialog.proxy.socks4')}</SelectItem>\n",
    "",
)

print("secure defaults and proxy options updated")
