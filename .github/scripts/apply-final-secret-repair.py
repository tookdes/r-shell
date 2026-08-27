from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f"expected {label} block not found")


dialog_path = Path("src/components/connection-dialog.tsx")
dialog = dialog_path.read_text()
old_save = """    } else if (saveAsConnection) {
      ConnectionStorageManager.saveConnectionWithId(connectionId, {
        name: config.name,
        host: config.host,
        port: config.port || 22,
        username: config.username,
        protocol: config.protocol,
        folder: connectionFolder,
        authMethod: config.authMethod,
        password: config.password,
        privateKeyPath: config.privateKeyPath,
        passphrase: config.passphrase,
        proxyType: config.proxyType,
        proxyHost: config.proxyHost,
        proxyPort: config.proxyPort,
        proxyUsername: config.proxyUsername,
        proxyPassword: config.proxyPassword,
        compression: config.compression,
        keepAlive: config.keepAlive,
        keepAliveInterval: config.keepAliveInterval,
        serverAliveCountMax: config.serverAliveCountMax,
      });
    }
"""
new_save = """    } else if (saveAsConnection) {
      const secretsForStorage = await encryptConnectionSecrets({
        password: config.password,
        passphrase: config.passphrase,
        privateKeyData: config.privateKeyData,
        proxyPassword: config.proxyPassword,
      });
      ConnectionStorageManager.saveConnectionWithId(connectionId, {
        name: config.name,
        host: config.host,
        port: config.port || 22,
        username: config.username,
        protocol: config.protocol,
        folder: connectionFolder,
        authMethod: config.authMethod,
        password: secretsForStorage.password,
        privateKeyPath: config.privateKeyPath,
        privateKeyData: secretsForStorage.privateKeyData,
        passphrase: secretsForStorage.passphrase,
        proxyType: config.proxyType,
        proxyHost: config.proxyHost,
        proxyPort: config.proxyPort,
        proxyUsername: config.proxyUsername,
        proxyPassword: secretsForStorage.proxyPassword,
        compression: config.compression,
        keepAlive: config.keepAlive,
        keepAliveInterval: config.keepAliveInterval,
        serverAliveCountMax: config.serverAliveCountMax,
      });
    }
"""
dialog = replace_once(dialog, old_save, new_save, "SSH new-connection persistence")
dialog_path.write_text(dialog)

test_path = Path("src/__tests__/connection-dialog-proxy.test.tsx")
test = test_path.read_text()
test = test.replace(
    "import { fireEvent, render, screen } from '@testing-library/react';",
    "import { fireEvent, render, screen, waitFor } from '@testing-library/react';",
    1,
)
old_before = """beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('sshClientSettings', JSON.stringify({ savePasswords: true }));
  vi.clearAllMocks();
});
"""
new_before = """beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('sshClientSettings', JSON.stringify({ savePasswords: true }));
  vi.clearAllMocks();
  mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'secrets_encrypt') {
      return `cipher:${String(args?.plaintext ?? '')}`;
    }
    if (command === 'secrets_decrypt') {
      const ciphertext = String(args?.ciphertext ?? '');
      return ciphertext.startsWith('cipher:') ? ciphertext.slice('cipher:'.length) : ciphertext;
    }
    if (command === 'ssh_connect') {
      return { success: false, error: 'connection refused' };
    }
    return undefined;
  });
});
"""
test = replace_once(test, old_before, new_before, "proxy test beforeEach")
old_test = """  it('persists proxy config when the edited connection is saved', () => {
    // Seed a connection without proxy (realistic: proxy was never stored before)
    ConnectionStorageManager.saveConnectionWithId('conn-1', baseConnection);

    renderDialog({
      editingConnection: { ...baseConnection, ...proxyConfig },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.proxyType).toBe('http');
    expect(stored?.proxyHost).toBe('proxy.example.com');
    expect(stored?.proxyPort).toBe(3128);
    expect(stored?.proxyUsername).toBe('proxyuser');
    expect(stored?.proxyPassword).toBe('proxypass');
  });
"""
new_test = """  it('persists proxy config when the edited connection is saved', async () => {
    // Seed a connection without proxy (realistic: proxy was never stored before)
    ConnectionStorageManager.saveConnectionWithId('conn-1', baseConnection);

    renderDialog({
      editingConnection: { ...baseConnection, ...proxyConfig },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(ConnectionStorageManager.getConnection('conn-1')?.proxyType).toBe('http');
    });

    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.proxyHost).toBe('proxy.example.com');
    expect(stored?.proxyPort).toBe(3128);
    expect(stored?.proxyUsername).toBe('proxyuser');
    expect(stored?.password).toBe('enc:v1:cipher:secret');
    expect(stored?.proxyPassword).toBe('enc:v1:cipher:proxypass');
  });
"""
test = replace_once(test, old_test, new_test, "edited proxy persistence test")
test = test.replace(
    "    mockInvoke.mockResolvedValueOnce({ success: false, error: 'connection refused' });\n\n",
    "",
    1,
)
test = test.replace(
    "    expect(connections[0].proxyPassword).toBe('proxypass');",
    "    expect(connections[0].password).toBe('enc:v1:cipher:secret');\n    expect(connections[0].proxyPassword).toBe('enc:v1:cipher:proxypass');",
    1,
)
test_path.write_text(test)
