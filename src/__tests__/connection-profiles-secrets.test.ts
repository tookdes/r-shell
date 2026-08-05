import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionProfileManager } from '../lib/connection-profiles';

const STORAGE_KEY = 'r-shell-connection-profiles';

describe('connection profile secret handling', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not persist a password supplied to saveProfile', () => {
    const saved = ConnectionProfileManager.saveProfile({
      name: 'Server',
      host: 'example.com',
      port: 22,
      username: 'alice',
      authMethod: 'password',
      password: 'plaintext-secret',
    });

    expect(saved.password).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('plaintext-secret');
  });

  it('scrubs legacy plaintext passwords when profiles are loaded', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          host: 'example.com',
          port: 22,
          username: 'alice',
          authMethod: 'password',
          password: 'legacy-secret',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );

    const profiles = ConnectionProfileManager.getProfiles();
    expect(profiles[0]?.password).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('legacy-secret');
  });

  it('strips passwords from imported and exported profiles', () => {
    ConnectionProfileManager.importProfiles(
      JSON.stringify([
        {
          id: 'imported',
          name: 'Imported',
          host: 'example.com',
          port: 22,
          username: 'alice',
          authMethod: 'password',
          password: 'import-secret',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );

    expect(ConnectionProfileManager.exportProfiles()).not.toContain('import-secret');
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('import-secret');
  });
});
