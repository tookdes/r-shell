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

/**
 * Build the binary WebSocket frame used to write bytes to a PTY session.
 *
 * Keeping this separate from text normalization is important for binary
 * terminal protocols such as ZMODEM: protocol octets must reach the remote
 * PTY byte-for-byte, without UTF-8 encoding or newline conversion.
 */
export function buildPtyInputFrame(
  connectionIdBytes: Uint8Array,
  dataBytes: Uint8Array,
): Uint8Array {
  if (connectionIdBytes.length > 0xffff) {
    throw new RangeError('Connection id is too long for a PTY input frame');
  }

  const frame = new Uint8Array(3 + connectionIdBytes.length + dataBytes.length);
  frame[0] = 0x00;
  frame[1] = (connectionIdBytes.length >> 8) & 0xff;
  frame[2] = connectionIdBytes.length & 0xff;
  frame.set(connectionIdBytes, 3);
  frame.set(dataBytes, 3 + connectionIdBytes.length);
  return frame;
}

export interface PtySendBufferOptions {
  highWaterBytes?: number;
  lowWaterBytes?: number;
  pollIntervalMs?: number;
  openReadyState?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const PTY_SEND_HIGH_WATER_BYTES = 1024 * 1024;
const PTY_SEND_LOW_WATER_BYTES = 256 * 1024;
const PTY_SEND_BUFFER_POLL_MS = 4;

/**
 * Apply bounded backpressure to high-volume binary PTY input.
 *
 * The browser WebSocket API queues send() calls in memory. ZMODEM can read a
 * local file much faster than SSH can drain it, so large transfers must pause
 * once the socket queue grows instead of buffering the entire remaining file.
 */
export async function waitForPtySendCapacity(
  socket: { readonly bufferedAmount: number; readonly readyState: number },
  options: PtySendBufferOptions = {},
): Promise<boolean> {
  const highWaterBytes = options.highWaterBytes ?? PTY_SEND_HIGH_WATER_BYTES;
  const lowWaterBytes = options.lowWaterBytes ?? PTY_SEND_LOW_WATER_BYTES;
  const pollIntervalMs = options.pollIntervalMs ?? PTY_SEND_BUFFER_POLL_MS;
  const openReadyState = options.openReadyState ?? 1;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, milliseconds);
      }));

  if (lowWaterBytes < 0 || highWaterBytes < lowWaterBytes) {
    throw new RangeError('Invalid PTY WebSocket send-buffer thresholds');
  }

  if (socket.readyState !== openReadyState) return false;
  if (socket.bufferedAmount <= highWaterBytes) return true;

  while (socket.bufferedAmount > lowWaterBytes) {
    await sleep(pollIntervalMs);
    if (socket.readyState !== openReadyState) return false;
  }

  return true;
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
