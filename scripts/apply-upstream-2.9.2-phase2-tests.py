from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old!r}")
    p.write_text(text.replace(old, new, 1))


credentials_test = "src/__tests__/connection-credentials.test.ts"
replace_once(
    credentials_test,
    "  it('rejects publickey auth with neither path nor data', () => {\n    expect(connectionHasCredentials({ authMethod: 'publickey' })).toBe(false);\n  });",
    "  it('accepts publickey auth with neither path nor data so the backend can resolve default keys', () => {\n    expect(connectionHasCredentials({ authMethod: 'publickey' })).toBe(true);\n  });",
)
replace_once(
    credentials_test,
    "  it('does not resurrect a cached secret when storage contains an explicit empty value', () => {\n    rememberSessionCredentials('profile-1', { password: 'old-secret' });\n    const merged = mergeWithSessionCredentials('profile-1', {\n      authMethod: 'password' as const,\n      password: '',\n    });\n    expect(merged.password).toBe('');\n    expect(connectionHasCredentials(merged)).toBe(false);\n  });",
    "  it('does not resurrect a cached secret when storage contains an explicit passwordless value', () => {\n    rememberSessionCredentials('profile-1', { password: 'old-secret' });\n    const merged = mergeWithSessionCredentials('profile-1', {\n      authMethod: 'password' as const,\n      password: '',\n    });\n    expect(merged.password).toBe('');\n    expect(connectionHasCredentials(merged)).toBe(true);\n  });",
)

keyboard_test = "src/__tests__/keyboard-shortcuts.test.ts"
replace_once(
    keyboard_test,
    "    prevTab: vi.fn(),\n  };",
    "    prevTab: vi.fn(),\n    moveTabLeft: vi.fn(),\n    moveTabRight: vi.fn(),\n  };",
)
replace_once(
    keyboard_test,
    "  it('returns 14 shortcuts total', () => {\n    const actions = createMockActions();\n    const shortcuts = createSplitViewShortcuts(actions);\n    // 1 splitRight + 1 splitDown + 9 focusGroup + 1 closeTab + 1 nextTab + 1 prevTab\n    expect(shortcuts).toHaveLength(14);\n  });",
    "  it('returns 16 shortcuts total', () => {\n    const actions = createMockActions();\n    const shortcuts = createSplitViewShortcuts(actions);\n    // Existing 14 shortcuts + move active tab left/right.\n    expect(shortcuts).toHaveLength(16);\n  });",
)
anchor = "  // Requirement 5.2: Ctrl+1~9 focuses group by index (0-based)\n"
addition = """  it('Ctrl+Shift+PageUp moves the active tab left', () => {
    const actions = createMockActions();
    const shortcuts = createSplitViewShortcuts(actions);
    const shortcut = findShortcut(shortcuts, 'pageup', { ctrlKey: true, shiftKey: true });
    expect(shortcut).toBeDefined();
    shortcut!.handler();
    expect(actions.moveTabLeft).toHaveBeenCalledOnce();
  });

  it('Ctrl+Shift+PageDown moves the active tab right', () => {
    const actions = createMockActions();
    const shortcuts = createSplitViewShortcuts(actions);
    const shortcut = findShortcut(shortcuts, 'pagedown', { ctrlKey: true, shiftKey: true });
    expect(shortcut).toBeDefined();
    shortcut!.handler();
    expect(actions.moveTabRight).toHaveBeenCalledOnce();
  });

"""
replace_once(keyboard_test, anchor, addition + anchor)

Path("scripts/apply-upstream-2.9.2-phase2-tests.py").unlink(missing_ok=True)
