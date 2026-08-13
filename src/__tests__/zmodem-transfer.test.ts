import { describe, expect, it } from 'vitest';
import { zmodemFilename } from '../lib/zmodem-transfer';

describe('ZMODEM filenames', () => {
  it('extracts a leaf name from Windows and Unix paths', () => {
    expect(zmodemFilename.basename(String.raw`C:\temp\archive.tar.gz`)).toBe('archive.tar.gz');
    expect(zmodemFilename.basename('/tmp/archive.tar.gz')).toBe('archive.tar.gz');
  });

  it('prevents a remote sender from choosing local directories', () => {
    expect(zmodemFilename.safeReceived('../../secret.txt')).toBe('secret.txt');
    expect(zmodemFilename.safeReceived(String.raw`..\..\secret.txt`)).toBe('secret.txt');
  });

  it('replaces characters that are invalid in Windows filenames', () => {
    expect(zmodemFilename.safeReceived('bad:name?.txt')).toBe('bad_name_.txt');
  });

  it('provides a safe fallback for empty and dot names', () => {
    expect(zmodemFilename.safeReceived('')).toBe('download');
    expect(zmodemFilename.safeReceived('..')).toBe('download');
  });
});
