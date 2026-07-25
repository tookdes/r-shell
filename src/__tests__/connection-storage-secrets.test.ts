import { beforeEach, describe, expect, it } from 'vitest';
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

  it('does not persist secrets before Save Passwords is explicitly enabled', () => {
    const saved = saveConnection('secure-default');
    expect(saved.password).toBeUndefined();
    expect(saved.passphrase).toBeUndefined();
    expect(saved.privateKeyData).toBeUndefined();
    expect(saved.proxyPassword).toBeUndefined();
    expect(saved.vncPassword).toBeUndefined();
    expect(localStorage.getItem(CONNECTIONS_KEY)).not.toContain('secret');
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

  it('persists encrypted secret fields only when Save Passwords is enabled', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ savePasswords: true }));
    const saved = ConnectionStorageManager.saveConnectionWithId('encrypted-secrets', {
      name: 'Server',
      host: 'example.com',
      port: 22,
      username: 'alice',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'enc:v1:password-ciphertext',
      privateKeyData: 'enc:v1:key-ciphertext',
      proxyPassword: 'enc:v1:proxy-ciphertext',
    });

    expect(saved.password).toBe('enc:v1:password-ciphertext');
    expect(saved.privateKeyData).toBe('enc:v1:key-ciphertext');
    expect(saved.proxyPassword).toBe('enc:v1:proxy-ciphertext');
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
