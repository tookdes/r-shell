import { describe, it, expect } from 'vitest';
import { encodeModifiedEnterCsiU, normalizePtyInput } from '../lib/pty-input';

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
