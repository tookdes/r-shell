import { describe, it, expect } from 'vitest';
import { normalizePtyInput } from '../lib/pty-input';

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
