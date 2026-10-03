import { invoke } from '@tauri-apps/api/core';

export interface WebSocketEndpoint {
  port: number;
  token: string;
}

/**
 * Resolve the authenticated local PTY/desktop WebSocket bridge endpoint.
 *
 * There is deliberately no unauthenticated fallback: once the backend requires
 * the per-launch token, guessing port 9001 can only fail and would hide endpoint
 * initialization problems.
 */
export async function getWebSocketUrl(): Promise<string> {
  const { port, token } = await invoke<WebSocketEndpoint>('get_websocket_endpoint');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid WebSocket bridge port');
  }
  if (!token) {
    throw new Error('WebSocket bridge token unavailable');
  }
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}
