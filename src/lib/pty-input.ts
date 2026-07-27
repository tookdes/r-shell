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
