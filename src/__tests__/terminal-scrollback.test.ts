import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  defaultAppearanceSettings,
  defaultTerminalOptions,
  getTerminalOptions,
  loadAppearanceSettings,
} from '../lib/terminal-config';

describe('terminal scrollback configuration', () => {
  beforeEach(() => {
    localStorage.removeItem('terminalAppearance');
  });

  afterEach(() => {
    localStorage.removeItem('terminalAppearance');
  });

  it('keeps at least 10000 lines in the default xterm scrollback buffer', async () => {
    const term = new Terminal({
      ...defaultTerminalOptions,
      cols: 80,
      rows: 24,
    });

    for (let i = 1; i <= 20000; i += 1) {
      term.writeln(String(i));
    }

    await new Promise<void>((resolve) => term.write('', () => resolve()));

    expect(term.options.scrollback).toBe(10000);
    expect(term.buffer.active.length).toBeGreaterThanOrEqual(10000);

    term.dispose();
  });

  it('leaves PTY line endings to the remote terminal driver', async () => {
    // Full-screen TUIs (Charm Crush, Bubble Tea, vim, htop) can use a bare LF
    // to move down while retaining the cursor column. Rewriting it as CRLF
    // snaps the cursor to column zero and corrupts overlays/dialog layout.
    expect(defaultTerminalOptions.convertEol).toBe(false);
    expect(getTerminalOptions(loadAppearanceSettings()).convertEol).toBe(false);

    const term = new Terminal({
      ...defaultTerminalOptions,
      cols: 20,
      rows: 5,
    });
    const write = (data: string) =>
      new Promise<void>((resolve) => term.write(data, resolve));
    term.write('\x1b[2;10H');
    await write('');
    await write('\n');

    // A bare LF must move down without changing the column.
    expect(term.buffer.active.cursorY).toBe(2);
    expect(term.buffer.active.cursorX).toBe(9);
    term.dispose();
  });

  it('migrates the regressed 500-line saved scrollback value back to the default', () => {
    localStorage.setItem(
      'terminalAppearance',
      JSON.stringify({
        ...defaultAppearanceSettings,
        scrollback: 500,
      }),
    );

    expect(loadAppearanceSettings().scrollback).toBe(10000);
    expect(getTerminalOptions(loadAppearanceSettings()).scrollback).toBe(10000);
  });
});
