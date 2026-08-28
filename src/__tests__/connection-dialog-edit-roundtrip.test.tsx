/**
 * Regression tests: editing a saved SSH connection and toggling advanced
 * options (compression, keepalive) must survive a save → re-open round-trip.
 *
 * Uses the real ConnectionStorageManager + localStorage, so it exercises the
 * same storage path as the desktop app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionDialog, type ConnectionConfig } from '../components/connection-dialog';
import { ConnectionStorageManager, type ConnectionData } from '../lib/connection-storage';
import { decryptConnectionSecrets } from '../lib/secrets';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, string>) => {
    const encodeOpaque = (value: string) =>
      Array.from(value)
        .map((char) => char.codePointAt(0)!.toString(16).padStart(6, '0'))
        .join('');
    const decodeOpaque = (value: string) => {
      let plaintext = '';
      for (let offset = 0; offset < value.length; offset += 6) {
        const codePoint = Number.parseInt(value.slice(offset, offset + 6), 16);
        if (Number.isFinite(codePoint)) plaintext += String.fromCodePoint(codePoint);
      }
      return plaintext;
    };

    if (command === 'secrets_encrypt') {
      return `cipher:${encodeOpaque(args?.plaintext ?? '')}`;
    }
    if (command === 'secrets_decrypt') {
      const ciphertext = args?.ciphertext ?? '';
      return ciphertext.startsWith('cipher:')
        ? decodeOpaque(ciphertext.slice('cipher:'.length))
        : '';
    }
    return undefined;
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

/** Mirror of App.tsx's toConnectionConfig: stored ConnectionData → dialog config. */
function toConfig(data: ConnectionData): ConnectionConfig {
  return {
    id: data.id,
    name: data.name,
    protocol: data.protocol as ConnectionConfig['protocol'],
    host: data.host,
    port: data.port,
    username: data.username,
    authMethod: data.authMethod || 'password',
    password: data.password,
    privateKeyPath: data.privateKeyPath,
    privateKeyData: data.privateKeyData,
    passphrase: data.passphrase,
    proxyType: data.proxyType,
    proxyHost: data.proxyHost,
    proxyPort: data.proxyPort,
    proxyUsername: data.proxyUsername,
    proxyPassword: data.proxyPassword,
    compression: data.compression,
    keepAlive: data.keepAlive,
    keepAliveInterval: data.keepAliveInterval,
    serverAliveCountMax: data.serverAliveCountMax,
  };
}

beforeEach(() => {
  localStorage.clear();
});

async function switchToAdvancedTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Advanced' }), { button: 0 });
}

describe('edit advanced options round-trip (real storage)', () => {
  it('compression OFF survives save → re-open as OFF', async () => {
    ConnectionStorageManager.saveConnectionWithId('c1', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      compression: true,
      keepAlive: true,
      keepAliveInterval: 60,
      serverAliveCountMax: 3,
    });

    const editing = toConfig(ConnectionStorageManager.getConnection('c1')!);

    const { unmount } = render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={editing}
      />,
    );
    await switchToAdvancedTab();
    const switches = await screen.findAllByRole('switch');
    expect(switches[0].getAttribute('data-state')).toBe('checked');
    fireEvent.click(switches[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(ConnectionStorageManager.getConnection('c1')?.compression).toBe(false);
    });
    unmount();

    const stored = ConnectionStorageManager.getConnection('c1')!;
    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={toConfig(stored)}
      />,
    );
    await switchToAdvancedTab();
    const switches2 = await screen.findAllByRole('switch');
    expect(switches2[0].getAttribute('data-state')).toBe('unchecked');
  });

  it('keepalive interval edit survives save → re-open', async () => {
    ConnectionStorageManager.saveConnectionWithId('c1', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      compression: true,
      keepAlive: true,
      keepAliveInterval: 60,
      serverAliveCountMax: 3,
    });

    const editing = toConfig(ConnectionStorageManager.getConnection('c1')!);

    const { unmount } = render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={editing}
      />,
    );
    await switchToAdvancedTab();
    const intervalInput = screen.getByLabelText('Interval (seconds)');
    fireEvent.change(intervalInput, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(ConnectionStorageManager.getConnection('c1')?.keepAliveInterval).toBe(30);
    });
    unmount();
  });

  it('encrypts edited secrets on Save without connecting and decrypts to the originals', async () => {
    localStorage.setItem('sshClientSettings', JSON.stringify({ savePasswords: true }));

    ConnectionStorageManager.saveConnectionWithId('c-secret', {
      name: 'Secret Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'publickey',
    });

    const editing: ConnectionConfig = {
      ...toConfig(ConnectionStorageManager.getConnection('c-secret')!),
      password: 'plain-password-515ec6e0',
      passphrase: 'plain-passphrase-515ec6e0',
      privateKeyData: 'PRIVATE KEY DATA 515ec6e0',
      proxyPassword: 'plain-proxy-password-515ec6e0',
    };

    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={editing}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const storedPassword = ConnectionStorageManager.getConnection('c-secret')?.password ?? '';
      expect(storedPassword).toMatch(/^enc:v1:cipher:[0-9a-f]+$/);
      expect(storedPassword).not.toContain('plain-password-515ec6e0');
    });

    const rawStorage = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return key ? localStorage.getItem(key) ?? '' : '';
    }).join('\n');

    expect(rawStorage).not.toContain('plain-password-515ec6e0');
    expect(rawStorage).not.toContain('plain-passphrase-515ec6e0');
    expect(rawStorage).not.toContain('PRIVATE KEY DATA 515ec6e0');
    expect(rawStorage).not.toContain('plain-proxy-password-515ec6e0');

    const stored = ConnectionStorageManager.getConnection('c-secret')!;
    const decrypted = await decryptConnectionSecrets(stored);
    expect(decrypted.password).toBe('plain-password-515ec6e0');
    expect(decrypted.passphrase).toBe('plain-passphrase-515ec6e0');
    expect(decrypted.privateKeyData).toBe('PRIVATE KEY DATA 515ec6e0');
    expect(decrypted.proxyPassword).toBe('plain-proxy-password-515ec6e0');
  });
});
