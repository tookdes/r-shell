#!/usr/bin/env python3
"""Apply the second group of verified workspace-sync fixes."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one exact match, found {count}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    if re.search(pattern, text, flags=re.DOTALL) is None:
        if replacement in text:
            return
        raise RuntimeError(f"{path}: regex did not match")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.DOTALL)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex replacement, found {count}")
    write(path, updated)


# Stable Rust compatibility for CR/LF validation.
replace_once(
    "src-tauri/src/proxy_stream.rs",
    "    if host.contains(['\\r', '\\n']) {",
    "    if host.contains('\\r') || host.contains('\\n') {",
)

# Edit saved connections using decrypted values, not enc:v1 ciphertext.
regex_once(
    "src/App.tsx",
    r"  const handleEditConnection = useCallback\(\(connection: ConnectionNode\) => \{.*?\n  \}, \[\]\);",
    """  const handleEditConnection = useCallback(async (connection: ConnectionNode) => {
    if (connection.type !== 'connection') return;

    const connectionDataRaw = ConnectionStorageManager.getConnection(connection.id);
    if (!connectionDataRaw) {
      toast.error('Connection Not Found', {
        description: 'The connection data could not be loaded.',
      });
      return;
    }

    try {
      const connectionData = mergeWithSessionCredentials(
        connection.id,
        await decryptConnectionSecrets(connectionDataRaw),
      );
      rememberSessionCredentials(connection.id, connectionData);
      setEditingConnection({
        id: connectionData.id,
        name: connectionData.name,
        protocol: connectionData.protocol as ConnectionConfig['protocol'],
        host: connectionData.host,
        port: connectionData.port,
        username: connectionData.username,
        authMethod: connectionData.authMethod || 'password',
        password: connectionData.password,
        privateKeyPath: connectionData.privateKeyPath,
        privateKeyData: connectionData.privateKeyData,
        passphrase: connectionData.passphrase,
        startupCommand: connectionData.startupCommand,
        proxyType: connectionData.proxyType,
        proxyHost: connectionData.proxyHost,
        proxyPort: connectionData.proxyPort,
        proxyUsername: connectionData.proxyUsername,
        proxyPassword: connectionData.proxyPassword,
        ftpsEnabled: connectionData.ftpsEnabled,
        domain: connectionData.domain,
        rdpResolution: connectionData.rdpResolution as ConnectionConfig['rdpResolution'],
        vncColorDepth: connectionData.vncColorDepth as ConnectionConfig['vncColorDepth'],
      });
      setConnectionDialogOpen(true);
    } catch (error) {
      toast.error('Unable to decrypt connection credentials', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);""",
)

# Quick-connect must preserve all SFTP transport fields.
replace_once(
    "src/App.tsx",
    """        password: connectionData.password,
        privateKeyPath: connectionData.privateKeyPath,
        passphrase: connectionData.passphrase,
        ftpsEnabled: connectionData.ftpsEnabled,""",
    """        password: connectionData.password,
        privateKeyPath: connectionData.privateKeyPath,
        privateKeyData: connectionData.privateKeyData,
        passphrase: connectionData.passphrase,
        startupCommand: connectionData.startupCommand,
        proxyType: connectionData.proxyType,
        proxyHost: connectionData.proxyHost,
        proxyPort: connectionData.proxyPort,
        proxyUsername: connectionData.proxyUsername,
        proxyPassword: connectionData.proxyPassword,
        ftpsEnabled: connectionData.ftpsEnabled,""",
)

# Add an explicit scrub operation for secrets that were saved before the user
# switched Save Passwords off.
replace_once(
    "src/lib/connection-storage.ts",
    """  static getConnection(id: string): ConnectionData | undefined {
    const connections = this.getConnections();
    return connections.find(c => c.id === id);
  }
""",
    """  static getConnection(id: string): ConnectionData | undefined {
    const connections = this.getConnections();
    return connections.find(c => c.id === id);
  }

  /** Remove all persisted authentication material from existing connections. */
  static stripStoredSecrets(): void {
    const connections = this.getConnections().map((connection) => ({
      ...connection,
      password: undefined,
      passphrase: undefined,
      vncPassword: undefined,
      privateKeyData: undefined,
      proxyPassword: undefined,
    }));
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
  }
""",
)

replace_once(
    "src/components/settings-modal.tsx",
    "import { useLayout } from '@/lib/layout-context';",
    """import { useLayout } from '@/lib/layout-context';
import { ConnectionStorageManager } from '@/lib/connection-storage';""",
)
replace_once(
    "src/components/settings-modal.tsx",
    """    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...settings,
      updateProxy: updateProxy ?? '',
    }));
    window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));""",
    """    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...settings,
      updateProxy: updateProxy ?? '',
    }));
    if (!settings.savePasswords) {
      ConnectionStorageManager.stripStoredSecrets();
    }
    window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));""",
)

# Add focused regression coverage for storage stripping and historical cleanup.
test_path = ROOT / "src/__tests__/connection-storage-secrets.test.ts"
test_path.write_text(
    """import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStorageManager } from '../lib/connection-storage';

const SETTINGS_KEY = 'sshClientSettings';
const CONNECTIONS_KEY = 'r-shell-connections';

function saveConnection(id: string) {
  return ConnectionStorageManager.saveConnectionWithId(id, {
    name: 'Server',
    host: 'example.com',
    port: 22,
    username: 'alice',
    protocol: 'SSH',
    authMethod: 'publickey',
    password: 'password-secret',
    passphrase: 'passphrase-secret',
    privateKeyData: 'private-key-secret',
    proxyPassword: 'proxy-secret',
    vncPassword: 'vnc-secret',
  });
}

describe('connection secret persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not persist any secret field when Save Passwords is disabled', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ savePasswords: false }));
    const saved = saveConnection('no-secrets');

    expect(saved.password).toBeUndefined();
    expect(saved.passphrase).toBeUndefined();
    expect(saved.privateKeyData).toBeUndefined();
    expect(saved.proxyPassword).toBeUndefined();
    expect(saved.vncPassword).toBeUndefined();

    const raw = localStorage.getItem(CONNECTIONS_KEY) ?? '';
    expect(raw).not.toContain('password-secret');
    expect(raw).not.toContain('passphrase-secret');
    expect(raw).not.toContain('private-key-secret');
    expect(raw).not.toContain('proxy-secret');
    expect(raw).not.toContain('vnc-secret');
  });

  it('scrubs secrets that were persisted before Save Passwords was disabled', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ savePasswords: true }));
    saveConnection('existing-secrets');

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ savePasswords: false }));
    ConnectionStorageManager.stripStoredSecrets();

    const stored = ConnectionStorageManager.getConnection('existing-secrets');
    expect(stored?.password).toBeUndefined();
    expect(stored?.passphrase).toBeUndefined();
    expect(stored?.privateKeyData).toBeUndefined();
    expect(stored?.proxyPassword).toBeUndefined();
    expect(stored?.vncPassword).toBeUndefined();
  });
});
""",
    encoding="utf-8",
)

print("workspace-sync second-stage fixes applied")
