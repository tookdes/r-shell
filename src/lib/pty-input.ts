/**
 * Normalize keyboard/paste data before it is written to a remote PTY.
 *
 * Interactive shells expect CR (`\r`) as the line terminator. Browsers and
 * some paste paths emit LF or CRLF. After a trailing backslash, bash treats
 * "backslash + single newline" as line continuation; CRLF becomes *two*
 * terminators (continue, then empty submit), so a follow-up line like `-a`
 * runs as a separate command (upstream #37).
 */
export function normalizePtyInput(data: string): string {
  return data.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
}

/** Modifier bitmask used by CSI u (kitty keyboard protocol) key sequences. */
export interface KeyModifiers {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Encode a modified Enter press as its CSI u key sequence, e.g. Shift+Enter
 * → `ESC[13;2u`, Ctrl+Enter → `ESC[13;5u`.
 *
 * xterm.js folds every modified Enter into a plain `\r`, so terminal apps
 * like opencode cannot distinguish "insert newline" (Shift+Enter) from
 * "send message" (Enter). Sending the standard CSI u sequence lets them.
 * The modifier value is `1 + shift(1) + alt(2) + ctrl(4) + meta(8)`.
 */
export function encodeModifiedEnterCsiU(event: KeyModifiers): string {
  const modifier =
    1 +
    (event.shiftKey ? 1 : 0) +
    (event.altKey ? 2 : 0) +
    (event.ctrlKey ? 4 : 0) +
    (event.metaKey ? 8 : 0);
  return `\x1b[13;${modifier}u`;
}
