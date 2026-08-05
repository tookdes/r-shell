import { describe, expect, it } from 'vitest';
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
