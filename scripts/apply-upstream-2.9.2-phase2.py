from pathlib import Path
import json


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


# Passwordless SSH: an explicit empty password is a valid credential. Try
# password auth first, then RFC-style "none" auth only for the empty case.
ssh = "src-tauri/src/ssh/mod.rs"
replace_once(
    ssh,
    '''            AuthMethod::Password { password } => ssh_session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| anyhow::anyhow!("Password authentication failed: {}", e))?,''',
    '''            AuthMethod::Password { password } => {
                let mut authenticated = ssh_session
                    .authenticate_password(&config.username, password)
                    .await
                    .map_err(|e| anyhow::anyhow!("Password authentication failed: {}", e))?;
                if !authenticated && password.is_empty() {
                    authenticated = ssh_session
                        .authenticate_none(&config.username)
                        .await
                        .map_err(|e| anyhow::anyhow!("Passwordless authentication failed: {}", e))?;
                }
                authenticated
            },''',
)

# Default SSH key resolution, preserving the fork's inline/pasted-key support.
os_keypath = Path("src-tauri/src/os_keypath.rs")
os_keypath.write_text(r'''use std::path::Path;

/// Resolve an explicit private-key path, or fall back to the conventional
/// default keys. Keep id_rsa first to match upstream v2.9.2 behaviour.
pub fn resolve_private_key_path(key_path: Option<&str>) -> Result<String, String> {
    if let Some(path) = key_path.map(str::trim).filter(|path| !path.is_empty()) {
        if !path.starts_with("~/") && !path.starts_with("~\\") {
            return Ok(path.to_string());
        }
    }

    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    resolve_private_key_path_with_home(key_path, &home)
}

fn resolve_private_key_path_with_home(key_path: Option<&str>, home: &Path) -> Result<String, String> {
    if let Some(path) = key_path.map(str::trim).filter(|path| !path.is_empty()) {
        return Ok(expand_tilde_with_home(path, home));
    }

    let ssh_dir = home.join(".ssh");
    for filename in ["id_rsa", "id_ed25519"] {
        let candidate = ssh_dir.join(filename);
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }

    Err(format!(
        "No default SSH private key found. Checked {} and {}",
        ssh_dir.join("id_rsa").display(),
        ssh_dir.join("id_ed25519").display(),
    ))
}

fn expand_tilde_with_home(key_path: &str, home: &Path) -> String {
    if key_path.starts_with("~/") || key_path.starts_with("~\\") {
        return key_path.replacen('~', &home.to_string_lossy(), 1);
    }
    key_path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn test_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("r-shell-keypath-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_key(home: &Path, filename: &str) -> PathBuf {
        let path = home.join(".ssh").join(filename);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "test key").unwrap();
        path
    }

    #[test]
    fn explicit_path_is_trimmed_and_tilde_expanded() {
        let home = test_home("explicit");
        assert_eq!(resolve_private_key_path_with_home(Some(" /abs/key "), &home).unwrap(), "/abs/key");
        assert_eq!(resolve_private_key_path_with_home(Some("~/keys/k1"), &home).unwrap(), format!("{}/keys/k1", home.to_string_lossy()));
    }

    #[test]
    fn blank_input_prefers_rsa_then_ed25519() {
        let home = test_home("defaults");
        let rsa = write_key(&home, "id_rsa");
        write_key(&home, "id_ed25519");
        assert_eq!(resolve_private_key_path_with_home(None, &home).unwrap(), rsa.to_string_lossy());

        let home2 = test_home("ed25519");
        let ed = write_key(&home2, "id_ed25519");
        assert_eq!(resolve_private_key_path_with_home(Some("  "), &home2).unwrap(), ed.to_string_lossy());
    }

    #[test]
    fn missing_defaults_reports_both_candidates() {
        let home = test_home("missing");
        let err = resolve_private_key_path_with_home(None, &home).unwrap_err();
        assert!(err.contains("id_rsa"));
        assert!(err.contains("id_ed25519"));
    }
}
''')

replace_once("src-tauri/src/lib.rs", "mod os_detect;\n", "mod os_detect;\nmod os_keypath;\n")
replace_once(
    ssh,
    '''    let key_path = key_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Private key path or key content is required"))?;

    if key_path.contains("BEGIN") && key_path.contains("PRIVATE KEY") {
        let normalized = key_path.replace("\\r\\n", "\\n");
        return decode_secret_key(&normalized, passphrase)
            .map_err(|e| anyhow::anyhow!("Failed to parse pasted private key: {}", e));
    }

    let expanded_path = if key_path.starts_with("~/") || key_path.starts_with("~\\\\") {
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            key_path.replacen('~', &home_str, 1)
        } else {
            key_path.to_string()
        }
    } else {
        key_path.to_string()
    };
''',
    '''    let configured_key_path = key_path.map(str::trim).filter(|s| !s.is_empty());

    // Compatibility: older profiles may contain pasted PEM text in key_path.
    if let Some(pasted_key) = configured_key_path.filter(|value| value.contains("BEGIN") && value.contains("PRIVATE KEY")) {
        let normalized = pasted_key.replace("\\r\\n", "\\n");
        return decode_secret_key(&normalized, passphrase)
            .map_err(|e| anyhow::anyhow!("Failed to parse pasted private key: {}", e));
    }

    let expanded_path = crate::os_keypath::resolve_private_key_path(configured_key_path)
        .map_err(anyhow::Error::msg)?;
''',
)
replace_once(
    ssh,
    '''            key_path
        ));''',
    '''            expanded_path
        ));''',
)
replace_once(
    ssh,
    '''        .map_err(|e| anyhow::anyhow!("Failed to read SSH key file {}: {}", key_path, e))?;''',
    '''        .map_err(|e| anyhow::anyhow!("Failed to read SSH key file {}: {}", expanded_path, e))?;''',
)
replace_once(
    ssh,
    '''                key_path, e
            )''',
    '''                expanded_path, e
            )''',
)

# Credential presence: empty password is intentional; public-key auth can use
# backend default-key discovery when no path/data is stored.
creds = "src/lib/connection-credentials.ts"
replace_once(
    creds,
    '''  if (method === 'publickey') {
    return !!(
      (typeof connection.privateKeyPath === 'string' && connection.privateKeyPath.trim()) ||
      (typeof connection.privateKeyData === 'string' && connection.privateKeyData.trim())
    );
  }

  // password, keyboard-interactive, or unknown — need a password
  return typeof connection.password === 'string' && connection.password.length > 0;''',
    '''  if (method === 'publickey') {
    // An omitted path is valid: the backend resolves ~/.ssh/id_rsa or id_ed25519.
    return true;
  }

  // Empty string is a configured password and enables SSH "none" fallback.
  // Undefined/null means credentials were not saved.
  return typeof connection.password === 'string';''',
)

# Tab reorder shortcuts use the existing in-window keyboard system (not a
# process-global shortcut plugin), preserving the fork's non-hijacking design.
kb = "src/lib/keyboard-shortcuts.ts"
replace_once(
    kb,
    "  previousTab: 'Ctrl+Shift+Tab',\n} as const;",
    "  previousTab: 'Ctrl+Shift+Tab',\n  moveTabLeft: 'Ctrl+Shift+PageUp',\n  moveTabRight: 'Ctrl+Shift+PageDown',\n} as const;",
)
replace_once(
    kb,
    '''  prevTab: () => void;
}, bindings:''',
    '''  prevTab: () => void;
  moveTabLeft: () => void;
  moveTabRight: () => void;
}, bindings:''',
)
replace_once(
    kb,
    '''    createConfiguredShortcut(
      resolvedBindings.prevTab,
      DEFAULT_SPLIT_VIEW_SHORTCUTS.prevTab,
      actions.prevTab,
      'Previous tab in group',
    ),
  ];''',
    '''    createConfiguredShortcut(
      resolvedBindings.prevTab,
      DEFAULT_SPLIT_VIEW_SHORTCUTS.prevTab,
      actions.prevTab,
      'Previous tab in group',
    ),
    createConfiguredShortcut(
      DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabLeft,
      DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabLeft,
      actions.moveTabLeft,
      'Move active tab left',
    ),
    createConfiguredShortcut(
      DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabRight,
      DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabRight,
      actions.moveTabRight,
      'Move active tab right',
    ),
  ];''',
)

app = "src/App.tsx"
replace_once(
    app,
    '''  // Keyboard shortcuts: layout + split view
  const splitViewShortcuts = useMemo(() => {
    const groupIds = Object.keys(state.groups);''',
    '''  // Keyboard shortcuts: layout + split view
  const splitViewShortcuts = useMemo(() => {
    const groupIds = Object.keys(state.groups);
    const moveActiveTab = (delta: -1 | 1) => {
      if (!activeGroup?.activeTabId || activeGroup.tabs.length < 2) return;
      const fromIndex = activeGroup.tabs.findIndex((tab) => tab.id === activeGroup.activeTabId);
      if (fromIndex < 0) return;
      const toIndex = fromIndex + delta;
      if (toIndex < 0 || toIndex >= activeGroup.tabs.length) return;
      dispatch({ type: 'REORDER_TAB', groupId: activeGroup.id, fromIndex, toIndex });
    };''',
)
replace_once(
    app,
    '''        prevTab: () => {
          if (activeGroup && activeGroup.activeTabId && activeGroup.tabs.length > 1) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            const prevIndex = (currentIndex - 1 + activeGroup.tabs.length) % activeGroup.tabs.length;
            dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[prevIndex].id });
          }
        },
      },''',
    '''        prevTab: () => {
          if (activeGroup && activeGroup.activeTabId && activeGroup.tabs.length > 1) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            const prevIndex = (currentIndex - 1 + activeGroup.tabs.length) % activeGroup.tabs.length;
            dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[prevIndex].id });
          }
        },
        moveTabLeft: () => moveActiveTab(-1),
        moveTabRight: () => moveActiveTab(1),
      },''',
)

# Context-menu equivalents of the keyboard reorder commands.
tabs = "src/components/terminal/group-tab-bar.tsx"
replace_once(
    tabs,
    '''  const formattedCloseTabShortcut = formatKeyboardShortcut(
    closeTabShortcut ?? DEFAULT_APP_KEYBOARD_SHORTCUTS.closeSession,
    navigator.platform.toUpperCase().includes('MAC'),
  );''',
    '''  const formattedCloseTabShortcut = formatKeyboardShortcut(
    closeTabShortcut ?? DEFAULT_APP_KEYBOARD_SHORTCUTS.closeSession,
    navigator.platform.toUpperCase().includes('MAC'),
  );
  const formattedMoveTabLeftShortcut = formatKeyboardShortcut(
    DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabLeft,
    navigator.platform.toUpperCase().includes('MAC'),
  );
  const formattedMoveTabRightShortcut = formatKeyboardShortcut(
    DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabRight,
    navigator.platform.toUpperCase().includes('MAC'),
  );''',
)
replace_once(
    tabs,
    '''                  {/* Close */}
                  <ContextMenuItem onClick={() => handleTabClose(tab.id)}>''',
    '''                  {/* Reorder within the current group */}
                  {index > 0 && (
                    <ContextMenuItem onClick={() => dispatch({ type: 'REORDER_TAB', groupId, fromIndex: index, toIndex: index - 1 })}>
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      {t('contextMenu.moveTabLeft')}
                      <ContextMenuShortcut>{formattedMoveTabLeftShortcut}</ContextMenuShortcut>
                    </ContextMenuItem>
                  )}
                  {index < tabs.length - 1 && (
                    <ContextMenuItem onClick={() => dispatch({ type: 'REORDER_TAB', groupId, fromIndex: index, toIndex: index + 1 })}>
                      <ArrowRight className="mr-2 h-4 w-4" />
                      {t('contextMenu.moveTabRight')}
                      <ContextMenuShortcut>{formattedMoveTabRightShortcut}</ContextMenuShortcut>
                    </ContextMenuItem>
                  )}
                  {(index > 0 || index < tabs.length - 1) && <ContextMenuSeparator />}
                  {/* Close */}
                  <ContextMenuItem onClick={() => handleTabClose(tab.id)}>''',
)

# Add localized labels where this fork has matching locale files. Other locales
# fall back through i18next rather than shipping guessed translations.
for locale_path, left, right in [
    ("src/locales/en.json", "Move Tab Left", "Move Tab Right"),
    ("src/locales/zh-CN.json", "左移标签页", "右移标签页"),
]:
    p = Path(locale_path)
    if p.exists():
        data = json.loads(p.read_text())
        menu = data.setdefault("contextMenu", {})
        menu["moveTabLeft"] = left
        menu["moveTabRight"] = right
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

# Focused regression coverage for credential-presence semantics.
Path("src/__tests__/connection-credentials-passwordless.test.ts").write_text('''import { describe, expect, it } from 'vitest';
import { connectionHasCredentials } from '../lib/connection-credentials';

describe('connectionHasCredentials passwordless/default-key semantics', () => {
  it('accepts an explicitly configured blank password', () => {
    expect(connectionHasCredentials({ authMethod: 'password', password: '' })).toBe(true);
  });

  it('rejects a password profile whose credential is absent', () => {
    expect(connectionHasCredentials({ authMethod: 'password' })).toBe(false);
  });

  it('allows public-key auth without a stored path so the backend can resolve defaults', () => {
    expect(connectionHasCredentials({ authMethod: 'publickey' })).toBe(true);
  });
});
''')

# Remove temporary patch/runner files from the product commit.
Path("scripts/apply-upstream-2.9.2-phase2.py").unlink(missing_ok=True)
Path(".github/workflows/apply-upstream-phase2.yml").unlink(missing_ok=True)
