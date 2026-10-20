import { describe, expect, it, vi } from 'vitest';
import {
  buildPtyInputFrame,
  encodeModifiedEnterCsiU,
  normalizePtyInput,
  waitForPtySendCapacity,
} from '../lib/pty-input';

describe('buildPtyInputFrame', () => {
  it('preserves binary protocol bytes exactly', () => {
    const id = new TextEncoder().encode('session-1');
    const bytes = Uint8Array.from([0x00, 0x0a, 0x0d, 0x18, 0xff]);
    const frame = buildPtyInputFrame(id, bytes);

    expect(Array.from(frame.subarray(0, 3))).toEqual([0x00, 0x00, id.length]);
    expect(new TextDecoder().decode(frame.subarray(3, 3 + id.length))).toBe('session-1');
    expect(Array.from(frame.subarray(3 + id.length))).toEqual(Array.from(bytes));
  });

  it('uses a big-endian two-byte connection id length', () => {
    const id = new Uint8Array(300);
    const frame = buildPtyInputFrame(id, new Uint8Array());
    expect(Array.from(frame.subarray(0, 3))).toEqual([0x00, 0x01, 0x2c]);
  });

  it('rejects ids that cannot fit in the frame header', () => {
    expect(() => buildPtyInputFrame(new Uint8Array(0x10000), new Uint8Array())).toThrow(RangeError);
  });
});

describe('normalizePtyInput (#37 line continuation)', () => {
  it('keeps bare CR unchanged', () => {
    expect(normalizePtyInput('ls \\\r')).toBe('ls \\\r');
  });

  it('converts LF to CR', () => {
    expect(normalizePtyInput('ls \\\n-a\n')).toBe('ls \\\r-a\r');
  });

  it('collapses CRLF to a single CR (not two terminators)', () => {
    // Critical: after `\`, only one line end may reach the shell.
    expect(normalizePtyInput('ls \\\r\n-a\r\n')).toBe('ls \\\r-a\r');
  });

  it('does not invent extra newlines for plain text', () => {
    expect(normalizePtyInput('hello')).toBe('hello');
  });

  it('handles mixed endings', () => {
    expect(normalizePtyInput('a\r\nb\nc\r')).toBe('a\rb\rc\r');
  });
});

describe('encodeModifiedEnterCsiU (CSI u modified-Enter)', () => {
  it('encodes Shift+Enter as ESC[13;2u', () => {
    expect(
      encodeModifiedEnterCsiU({ shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }),
    ).toBe('\x1b[13;2u');
  });

  it('encodes Ctrl+Enter as ESC[13;5u', () => {
    expect(
      encodeModifiedEnterCsiU({ shiftKey: false, altKey: false, ctrlKey: true, metaKey: false }),
    ).toBe('\x1b[13;5u');
  });

  it('encodes Alt+Enter as ESC[13;3u', () => {
    expect(
      encodeModifiedEnterCsiU({ shiftKey: false, altKey: true, ctrlKey: false, metaKey: false }),
    ).toBe('\x1b[13;3u');
  });

  it('encodes Meta+Enter as ESC[13;9u', () => {
    expect(
      encodeModifiedEnterCsiU({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: true }),
    ).toBe('\x1b[13;9u');
  });

  it('encodes Shift+Ctrl+Alt+Meta+Enter as ESC[13;16u', () => {
    expect(
      encodeModifiedEnterCsiU({ shiftKey: true, altKey: true, ctrlKey: true, metaKey: true }),
    ).toBe('\x1b[13;16u');
  });

  it('does not produce a plain Enter for unmodified presses', () => {
    expect(
      encodeModifiedEnterCsiU({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }),
    ).toBe('\x1b[13;1u');
  });
});


describe('waitForPtySendCapacity', () => {
  it('returns immediately while the WebSocket queue is below the high-water mark', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const socket = { readyState: 1, bufferedAmount: 512 };

    await expect(
      waitForPtySendCapacity(socket, {
        highWaterBytes: 1024,
        lowWaterBytes: 256,
        sleep,
      }),
    ).resolves.toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits for a large WebSocket queue to drain to the low-water mark', async () => {
    const socket = { readyState: 1, bufferedAmount: 2048 };
    const sleep = vi.fn().mockImplementation(async () => {
      socket.bufferedAmount = 128;
    });

    await expect(
      waitForPtySendCapacity(socket, {
        highWaterBytes: 1024,
        lowWaterBytes: 256,
        sleep,
      }),
    ).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('stops waiting if the WebSocket closes while draining', async () => {
    const socket = { readyState: 1, bufferedAmount: 2048 };
    const sleep = vi.fn().mockImplementation(async () => {
      socket.readyState = 3;
    });

    await expect(
      waitForPtySendCapacity(socket, {
        highWaterBytes: 1024,
        lowWaterBytes: 256,
        sleep,
      }),
    ).resolves.toBe(false);
  });
});
