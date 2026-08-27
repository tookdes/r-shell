from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
path = root / "src/components/pty-terminal.tsx"
source = path.read_text()

old = """  // Track whether we need to switch renderers due to background image change
  // This is necessary because WebGL renderer doesn't support transparency
  const hasBackgroundImage = !!appearance.backgroundImage;
  
  // Use a key that only changes when we need to switch renderers
  const terminalKey = React.useMemo(
    () => (hasBackgroundImage ? 'bg' : 'no-bg'),
    [hasBackgroundImage],
  );
  
"""
if old in source:
    source = source.replace(old, "", 1)
elif "const terminalKey = React.useMemo" in source:
    raise SystemExit("unexpected terminalKey block")

old_dep = "connectionId, host, username, terminalKey, reconnectKey"
new_dep = "connectionId, host, username, reconnectKey"
if old_dep in source:
    source = source.replace(old_dep, new_dep, 1)
elif new_dep not in source:
    raise SystemExit("terminal effect dependency pattern not found")

old_comment = """  // NOTE: themeKey, appearanceKey, and connectionName are intentionally NOT
  // in the deps above. Including them would tear down the WebSocket + PTY
"""
new_comment = """  // NOTE: themeKey, appearanceKey, background-image changes, and connectionName
  // are intentionally NOT in the deps above. The DOM renderer supports transparency,
  // so appearance changes must not tear down the WebSocket + PTY
"""
if old_comment in source:
    source = source.replace(old_comment, new_comment, 1)
elif "background-image changes" not in source:
    raise SystemExit("terminal dependency comment pattern not found")

path.write_text(source)
print("terminal post-fixes applied")
