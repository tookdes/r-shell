import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLazyTabs } from '../lib/use-lazy-tabs';

describe('useLazyTabs', () => {
  it('mounts the initial tab and remembers tabs after first activation', () => {
    const { result } = renderHook(() => useLazyTabs('monitor'));

    expect(result.current.active).toBe('monitor');
    expect([...result.current.mounted]).toEqual(['monitor']);

    act(() => result.current.select('logs'));
    expect(result.current.active).toBe('logs');
    expect(result.current.mounted.has('monitor')).toBe(true);
    expect(result.current.mounted.has('logs')).toBe(true);

    act(() => result.current.select('monitor'));
    expect(result.current.mounted.size).toBe(2);
  });
});
