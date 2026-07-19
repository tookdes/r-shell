/**
 * App-level connection transport settings (timeout / keepalive / host-key / auto-reconnect).
 * Stored under the same key as other settings (`sshClientSettings`).
 */

import { APP_SETTINGS_STORAGE_KEY } from './keyboard-shortcuts';

export interface ConnectionTransportSettings {
  connectionTimeout: number;
  keepAliveInterval: number;
  hostKeyVerification: boolean;
  autoReconnect: boolean;
}

export const DEFAULT_CONNECTION_TRANSPORT_SETTINGS: ConnectionTransportSettings = {
  connectionTimeout: 30,
  keepAliveInterval: 60,
  hostKeyVerification: true,
  autoReconnect: true,
};

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function loadConnectionTransportSettings(): ConnectionTransportSettings {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_CONNECTION_TRANSPORT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<ConnectionTransportSettings>;
    return {
      connectionTimeout: clampPositiveInt(
        parsed.connectionTimeout,
        DEFAULT_CONNECTION_TRANSPORT_SETTINGS.connectionTimeout,
        5,
        120,
      ),
      keepAliveInterval: clampPositiveInt(
        parsed.keepAliveInterval,
        DEFAULT_CONNECTION_TRANSPORT_SETTINGS.keepAliveInterval,
        0,
        300,
      ),
      hostKeyVerification: parsed.hostKeyVerification !== false,
      autoReconnect: parsed.autoReconnect !== false,
    };
  } catch {
    return { ...DEFAULT_CONNECTION_TRANSPORT_SETTINGS };
  }
}

/**
 * Fields to merge into `ssh_connect` / `sftp_connect` invoke payloads.
 * Keeps backend transport knobs in one place so callers cannot forget them.
 */
export function buildTransportInvokeFields(
  settings: ConnectionTransportSettings = loadConnectionTransportSettings(),
): {
  connection_timeout_secs: number;
  keepalive_interval_secs: number;
  verify_host_key: boolean;
} {
  return {
    connection_timeout_secs: settings.connectionTimeout,
    keepalive_interval_secs: settings.keepAliveInterval,
    verify_host_key: settings.hostKeyVerification,
  };
}
