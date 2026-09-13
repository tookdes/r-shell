import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../lib/live-announcer';

describe('live-announcer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
  });

  it('creates a polite status region and publishes reorder text', () => {
    announce('Server tab moved to position 2 of 3');
    const region = document.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('Server tab moved to position 2 of 3');
  });
});
