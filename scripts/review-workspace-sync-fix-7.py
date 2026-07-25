#!/usr/bin/env python3
"""Keep machine-bound or plaintext credentials out of config bundles."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    file_path = ROOT / path
    text = file_path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "src/lib/config-export-import.ts",
    """const SCHEMA_VERSION = 1;
const LANGUAGE_STORAGE_KEY = 'r-shell-language';
""",
    """const SCHEMA_VERSION = 1;
const LANGUAGE_STORAGE_KEY = 'r-shell-language';

/**
 * Authentication material is machine-bound (encrypted with the local app key)
 * or may originate from an older plaintext configuration. Config bundles are
 * portable, so they intentionally contain connection metadata only.
 */
export function stripConnectionSecrets(connection: ConnectionData): ConnectionData {
  const {
    password: _password,
    passphrase: _passphrase,
    vncPassword: _vncPassword,
    privateKeyData: _privateKeyData,
    proxyPassword: _proxyPassword,
    ...safeConnection
  } = connection;
  return safeConnection;
}
""",
)

replace_once(
    "src/lib/config-export-import.ts",
    """    const connections = ConnectionStorageManager.getConnections();
    const folders = ConnectionStorageManager.getFolders();""",
    """    const connections = ConnectionStorageManager.getConnections().map(stripConnectionSecrets);
    const folders = ConnectionStorageManager.getFolders();""",
)

replace_once(
    "src/lib/config-export-import.ts",
    """      const importedCount = ConnectionStorageManager.importConnections(
        JSON.stringify(data.connections),
        merge,
      );""",
    """      const safeConnections = {
        ...data.connections,
        connections: data.connections.connections.map(stripConnectionSecrets),
      };
      const importedCount = ConnectionStorageManager.importConnections(
        JSON.stringify(safeConnections),
        merge,
      );""",
)

test_path = ROOT / "src/__tests__/config-export-secrets.test.ts"
test_path.write_text(
    """import { describe, expect, it } from 'vitest';
import { stripConnectionSecrets } from '../lib/config-export-import';

const connection = {
  id: 'connection-1',
  name: 'Server',
  host: 'example.com',
  port: 22,
  username: 'alice',
  protocol: 'SSH',
  createdAt: '2026-01-01T00:00:00.000Z',
  password: 'enc:v1:password',
  passphrase: 'enc:v1:passphrase',
  privateKeyData: 'enc:v1:key',
  proxyPassword: 'enc:v1:proxy',
  vncPassword: 'enc:v1:vnc',
};

describe('portable config secret handling', () => {
  it('removes every authentication secret while preserving metadata', () => {
    const safe = stripConnectionSecrets(connection);

    expect(safe).toMatchObject({
      id: 'connection-1',
      name: 'Server',
      host: 'example.com',
      port: 22,
      username: 'alice',
      protocol: 'SSH',
    });
    expect(safe.password).toBeUndefined();
    expect(safe.passphrase).toBeUndefined();
    expect(safe.privateKeyData).toBeUndefined();
    expect(safe.proxyPassword).toBeUndefined();
    expect(safe.vncPassword).toBeUndefined();
  });
});
""",
    encoding="utf-8",
)

print("portable config credentials stripped")
