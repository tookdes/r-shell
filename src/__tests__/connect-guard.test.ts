import { describe, expect, it } from 'vitest';
import { beginConnect, endConnect, nextDuplicateId } from '../lib/connect-guard';

describe('connect guard', () => {
  it('refuses a second in-flight connect for the same id', () => {
    expect(beginConnect('saved-1')).toBe(true);
    expect(beginConnect('saved-1')).toBe(false);
    endConnect('saved-1');
    expect(beginConnect('saved-1')).toBe(true);
    endConnect('saved-1');
  });

  it('keeps duplicate tab ids unique even in the same millisecond', () => {
    const first = nextDuplicateId('saved-1');
    const second = nextDuplicateId('saved-1');
    expect(first).not.toBe(second);
    expect(first.startsWith('saved-1-dup-')).toBe(true);
    expect(second.startsWith('saved-1-dup-')).toBe(true);
  });
});
