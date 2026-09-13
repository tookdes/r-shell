from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Session restore: stop launching new attempts after the overall deadline and
# actively cancel the currently pending SSH handshake through the backend's
# existing CancellationToken path. This adapts upstream #99 to the fork's
# restoreCancelRef architecture while preserving SFTP/FTP/desktop behavior.
# ---------------------------------------------------------------------------
app = "src/App.tsx"
replace_once(
    app,
    "    const restoreCancelledRef = restoreCancelRef;\n\n    const restoreConnections = async () => {",
    "    const restoreCancelledRef = restoreCancelRef;\n"
    "    let restoreTimedOut = false;\n"
    "    let currentPendingSshConnectionId: string | null = null;\n\n"
    "    const restoreConnections = async () => {",
)

# Track the SSH request that can be cancelled if the outer restore deadline wins.
replace_once(
    app,
    "          } else {\n"
    "            // SSH restoration (existing behavior)\n"
    "            const result = await withTimeout(\n",
    "          } else {\n"
    "            // SSH restoration (existing behavior)\n"
    "            currentPendingSshConnectionId = activeConn.connectionId;\n"
    "            const result = await withTimeout(\n",
)
replace_once(
    app,
    "              `ssh_connect ${connectionData.name}`,\n"
    "            );\n\n"
    "            if (result.success) {",
    "              `ssh_connect ${connectionData.name}`,\n"
    "            );\n"
    "            currentPendingSshConnectionId = null;\n\n"
    "            if (result.success) {",
)

# If an individual SSH restore fails/times out, clear the tracked pending id.
replace_once(
    app,
    "        } catch (error) {\n"
    "          console.error(`Error restoring connection ${connectionData.name}:`, error);",
    "        } catch (error) {\n"
    "          if (currentPendingSshConnectionId === activeConn.connectionId) {\n"
    "            currentPendingSshConnectionId = null;\n"
    "          }\n"
    "          console.error(`Error restoring connection ${connectionData.name}:`, error);",
)

# Do not emit a contradictory success/failure summary after cancellation.
replace_once(
    app,
    "      if (restoredCount > 0) {\n",
    "      if (restoreCancelledRef.current || restoreTimedOut) {\n"
    "        // Cancellation/timeout already owns the user-facing outcome. Keep\n"
    "        // the persisted active list so the user can retry next launch.\n"
    "      } else if (restoredCount > 0) {\n",
)

# Outer timeout marks the loop cancelled and aborts an in-flight SSH connect.
replace_once(
    app,
    "    withTimeout(restoreConnections(), OVERALL_RESTORE_TIMEOUT_MS, 'Session restore').catch((err) => {\n"
    "      console.error('Session restore timed out:', err);\n"
    "      toast.error(t('app.restoreTimedOut'), {\n"
    "        description: t('app.restoreTimedOutDesc'),\n"
    "      });\n"
    "      setCurrentRestoreTarget(null);\n"
    "      setIsRestoring(false);\n"
    "      setRestoringProgress({ current: 0, total: 0 });\n"
    "      clearAllRestorations();\n"
    "    });",
    "    withTimeout(restoreConnections(), OVERALL_RESTORE_TIMEOUT_MS, 'Session restore').catch((err) => {\n"
    "      const isOverallTimeout = err instanceof Error && err.message.startsWith('Timeout: Session restore');\n"
    "      if (isOverallTimeout) {\n"
    "        restoreTimedOut = true;\n"
    "        restoreCancelledRef.current = true;\n"
    "        const pendingSshId = currentPendingSshConnectionId;\n"
    "        currentPendingSshConnectionId = null;\n"
    "        if (pendingSshId) {\n"
    "          void invoke('ssh_cancel_connect', { connectionId: pendingSshId }).catch((cancelError) => {\n"
    "            console.warn(`Failed to cancel timed-out restore ${pendingSshId}:`, cancelError);\n"
    "          });\n"
    "        }\n"
    "        console.error('Session restore timed out:', err);\n"
    "        toast.error(t('app.restoreTimedOut'), {\n"
    "          description: t('app.restoreTimedOutDesc'),\n"
    "        });\n"
    "      } else {\n"
    "        console.error('Session restore failed:', err);\n"
    "      }\n"
    "      setCurrentRestoreTarget(null);\n"
    "      setIsRestoring(false);\n"
    "      setRestoringProgress({ current: 0, total: 0 });\n"
    "      clearAllRestorations();\n"
    "    });",
)

# ---------------------------------------------------------------------------
# Default public-key path: phase 2 taught load_private_key() to resolve an empty
# path to ~/.ssh/id_rsa then id_ed25519, but the command layer still rejected an
# empty path before reaching it. Remove that stale gate. Inline key data remains
# supported and takes precedence in load_private_key().
# ---------------------------------------------------------------------------
commands = "src-tauri/src/commands.rs"
replace_once(
    commands,
    "        \"publickey\" => {\n"
    "            let has_path = request\n"
    "                .key_path\n"
    "                .as_ref()\n"
    "                .map(|s| !s.trim().is_empty())\n"
    "                .unwrap_or(false);\n"
    "            let has_data = request\n"
    "                .key_data\n"
    "                .as_ref()\n"
    "                .map(|s| !s.trim().is_empty())\n"
    "                .unwrap_or(false);\n"
    "            if !has_path && !has_data {\n"
    "                return Err(\"Key path or key content required\".to_string());\n"
    "            }\n"
    "            AuthMethod::PublicKey {\n",
    "        \"publickey\" => {\n"
    "            // Missing/blank key_path is intentional: load_private_key()\n"
    "            // resolves the user's default ~/.ssh/id_rsa or id_ed25519.\n"
    "            AuthMethod::PublicKey {\n",
)

# ---------------------------------------------------------------------------
# Screen-reader live announcements from the stronger upstream tab-reorder UX.
# ---------------------------------------------------------------------------
Path("src/lib/live-announcer.ts").write_text('''/** Screen-reader announcements for tab reordering. */
let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement('div');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.className = 'sr-only';
  document.body.appendChild(region);
  return region;
}

export function announce(message: string): void {
  const el = ensureRegion();
  el.textContent = '';
  window.requestAnimationFrame(() => {
    el.textContent = message;
  });
}
''')

replace_once(
    app,
    "import { dispatchTerminalCommand, type TerminalCommand } from './lib/terminal-commands';\n",
    "import { dispatchTerminalCommand, type TerminalCommand } from './lib/terminal-commands';\n"
    "import { announce } from './lib/live-announcer';\n",
)
replace_once(
    app,
    "      dispatch({ type: 'REORDER_TAB', groupId: activeGroup.id, fromIndex, toIndex });\n    };",
    "      dispatch({ type: 'REORDER_TAB', groupId: activeGroup.id, fromIndex, toIndex });\n"
    "      const tabName = activeGroup.tabs[fromIndex]?.name ?? 'Tab';\n"
    "      announce(`${tabName} moved to position ${toIndex + 1} of ${activeGroup.tabs.length}`);\n"
    "    };",
)

tabs = "src/components/terminal/group-tab-bar.tsx"
replace_once(
    tabs,
    "import { DEFAULT_APP_KEYBOARD_SHORTCUTS, formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';\n",
    "import { DEFAULT_APP_KEYBOARD_SHORTCUTS, formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';\n"
    "import { announce } from '@/lib/live-announcer';\n",
)
replace_once(
    tabs,
    "          const { tabId: dragTabId, sourceGroupId } = activeDrag;\n",
    "          const { tabId: dragTabId, sourceGroupId, tabName: dragTabName } = activeDrag;\n",
)
replace_once(
    tabs,
    "                dispatch({ type: 'REORDER_TAB', groupId: sourceGroupId, fromIndex, toIndex: adjustedTarget });\n",
    "                dispatch({ type: 'REORDER_TAB', groupId: sourceGroupId, fromIndex, toIndex: adjustedTarget });\n"
    "                announce(`${dragTabName} moved to position ${adjustedTarget + 1} of ${tabs.length}`);\n",
)
replace_once(
    tabs,
    "            dispatch({\n"
    "              type: 'MOVE_TAB',\n"
    "              sourceGroupId,\n"
    "              targetGroupId: dropTarget.groupId,\n"
    "              tabId: dragTabId,\n"
    "              targetIndex,\n"
    "            });\n",
    "            dispatch({\n"
    "              type: 'MOVE_TAB',\n"
    "              sourceGroupId,\n"
    "              targetGroupId: dropTarget.groupId,\n"
    "              tabId: dragTabId,\n"
    "              targetIndex,\n"
    "            });\n"
    "            announce(`${dragTabName} moved to another split group`);\n",
)
replace_once(
    tabs,
    "                    <ContextMenuItem onClick={() => dispatch({ type: 'REORDER_TAB', groupId, fromIndex: index, toIndex: index - 1 })}>",
    "                    <ContextMenuItem onClick={() => { dispatch({ type: 'REORDER_TAB', groupId, fromIndex: index, toIndex: index - 1 }); announce(`${tab.name} moved to position ${index} of ${tabs.length}`); }}>",
)
replace_once(
    tabs,
    "                    <ContextMenuItem onClick={() => dispatch({ type: 'REORDER_TAB', groupId, fromIndex: index, toIndex: index + 1 })}>",
    "                    <ContextMenuItem onClick={() => { dispatch({ type: 'REORDER_TAB', groupId, fromIndex: index, toIndex: index + 1 }); announce(`${tab.name} moved to position ${index + 2} of ${tabs.length}`); }}>",
)

# Focused live-region test. Existing connection-credentials/os_keypath tests cover
# blank-password and default-key semantics; the full Rust suite catches command
# layer type/regression issues.
Path("src/__tests__/live-announcer.test.ts").write_text('''import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../lib/live-announcer';

describe('live-announcer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
  });

  it('creates a polite status region and publishes reorder text', () => {
    announce('Server tab moved to position 2 of 3');
    const region = document.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('Server tab moved to position 2 of 3');
  });
});
''')

# The final validation workflow removes all remaining scaffolding after tests.
Path("scripts/apply-upstream-2.9.2-phase3.py").unlink(missing_ok=True)
Path(".github/workflows/apply-upstream-phase3.yml").unlink(missing_ok=True)
