from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Session restore: once the overall deadline fires, stop starting new backend
# connections and suppress the stale success/failure summary from the still-
# unwinding restore loop. This adapts upstream #99 to the fork's existing
# restoreCancelRef design.
app = "src/App.tsx"
replace_once(
    app,
    "    const restoreCancelledRef = restoreCancelRef;\n\n    const restoreConnections = async () => {",
    "    const restoreCancelledRef = restoreCancelRef;\n    let restoreTimedOut = false;\n\n    const restoreConnections = async () => {",
)
replace_once(
    app,
    "      if (restoredCount > 0) {\n",
    "      if (restoreCancelledRef.current || restoreTimedOut) {\n"
    "        // The user or the overall deadline stopped restoration. Keep the\n"
    "        // persisted active-connection list intact and avoid a contradictory\n"
    "        // success/all-failed toast while an in-flight attempt unwinds.\n"
    "      } else if (restoredCount > 0) {\n",
)
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

# Screen-reader live region from upstream #133.
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

# Keyboard reorder announcements. Phase 2 supplies moveActiveTab.
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

# Pointer/context-menu reorder announcements in the tab bar.
tabs = "src/components/terminal/group-tab-bar.tsx"
replace_once(
    tabs,
    "import { DEFAULT_APP_KEYBOARD_SHORTCUTS, formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';\n",
    "import { DEFAULT_APP_KEYBOARD_SHORTCUTS, formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';\n"
    "import { announce } from '@/lib/live-announcer';\n",
)
# Pointer drag final dispatch.
replace_once(
    tabs,
    "          dispatch({ type: 'REORDER_TAB', groupId, fromIndex: originalIndex, toIndex: targetIndex });\n",
    "          dispatch({ type: 'REORDER_TAB', groupId, fromIndex: originalIndex, toIndex: targetIndex });\n"
    "          const title = tabs[originalIndex]?.name ?? 'Tab';\n"
    "          announce(`${title} moved to position ${targetIndex + 1} of ${tabs.length}`);\n",
)
# Context menu left/right are compact inline handlers from phase 2; replace with blocks.
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

# Focused tests for the live region. Restore cancellation is covered by existing
# integration behavior and the build/typecheck; avoid timers tied to App mount.
Path("src/__tests__/live-announcer.test.ts").write_text('''import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../lib/live-announcer';

describe('live-announcer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
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

Path("scripts/apply-upstream-2.9.2-phase3.py").unlink(missing_ok=True)
Path(".github/workflows/apply-upstream-phase3.yml").unlink(missing_ok=True)
