import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { getWebSocketUrl } from '../lib/websocket-endpoint';

describe('getWebSocketUrl', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('uses the backend port and per-launch token', async () => {
    invoke.mockResolvedValue({ port: 9004, token: 'abc-DEF_123' });

    await expect(getWebSocketUrl()).resolves.toBe(
      'ws://127.0.0.1:9004/?token=abc-DEF_123',
    );
    expect(invoke).toHaveBeenCalledWith('get_websocket_endpoint');
  });

  it('percent-encodes a non-URL-safe token', async () => {
    invoke.mockResolvedValue({ port: 9001, token: 'a+b/c=' });

    await expect(getWebSocketUrl()).resolves.toBe(
      'ws://127.0.0.1:9001/?token=a%2Bb%2Fc%3D',
    );
  });

  it('rejects invalid endpoint data instead of falling back unauthenticated', async () => {
    invoke.mockResolvedValue({ port: 0, token: '' });

    await expect(getWebSocketUrl()).rejects.toThrow('Invalid WebSocket bridge port');
  });
});
