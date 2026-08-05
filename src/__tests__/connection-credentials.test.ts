import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSessionCredentials,
  connectionHasCredentials,
  getSessionCredentials,
  mergeWithSessionCredentials,
  rememberSessionCredentials,
} from '../lib/connection-credentials';

describe('connectionHasCredentials', () => {
  it('accepts password auth when password is present', () => {
    expect(connectionHasCredentials({ authMethod: 'password', password: 'secret' })).toBe(true);
  });

  it('rejects password auth when password is missing', () => {
    expect(connectionHasCredentials({ authMethod: 'password' })).toBe(false);
  });

  it('infers password auth when authMethod is missing but password exists', () => {
    expect(connectionHasCredentials({ password: 'secret' })).toBe(true);
  });

  it('accepts publickey auth with privateKeyPath', () => {
    expect(
      connectionHasCredentials({
        authMethod: 'publickey',
        privateKeyPath: '~/.ssh/id_ed25519',
      }),
    ).toBe(true);
  });

  it('accepts publickey auth with privateKeyData only', () => {
    expect(
      connectionHasCredentials({
        authMethod: 'publickey',
        privateKeyData: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----',
      }),
    ).toBe(true);
  });

  it('rejects publickey auth with neither path nor data', () => {
    expect(connectionHasCredentials({ authMethod: 'publickey' })).toBe(false);
  });

  it('accepts anonymous auth without password', () => {
    expect(connectionHasCredentials({ authMethod: 'anonymous' })).toBe(true);
  });

  it('treats encrypted password ciphertext as present', () => {
    expect(
      connectionHasCredentials({
        authMethod: 'password',
        password: 'enc:v1:ciphertext',
      }),
    ).toBe(true);
  });
});

describe('session credential cache', () => {
  beforeEach(() => {
    clearSessionCredentials();
  });

  it('remembers and returns session credentials', () => {
    rememberSessionCredentials('profile-1', {
      authMethod: 'password',
      password: 'live-secret',
    });
    expect(getSessionCredentials('profile-1')).toEqual({
      authMethod: 'password',
      password: 'live-secret',
      privateKeyPath: undefined,
      privateKeyData: undefined,
      passphrase: undefined,
      proxyPassword: undefined,
      vncPassword: undefined,
    });
  });

  it('merges cached secrets into stored connection without overwriting stored values', () => {
    rememberSessionCredentials('profile-1', {
      password: 'from-session',
      privateKeyData: 'PEM',
    });

    const merged = mergeWithSessionCredentials('profile-1', {
      id: 'profile-1',
      name: 'Server',
      host: '1.2.3.4',
      password: undefined,
      privateKeyPath: '~/.ssh/id_rsa',
    });

    expect(merged.password).toBe('from-session');
    expect(merged.privateKeyData).toBe('PEM');
    expect(merged.privateKeyPath).toBe('~/.ssh/id_rsa');
  });

  it('lets duplicate flow succeed when storage stripped password but session has it', () => {
    rememberSessionCredentials('profile-1', { authMethod: 'password', password: 'live' });
    const stored = { authMethod: 'password' as const, password: undefined };
    const merged = mergeWithSessionCredentials('profile-1', stored);
    expect(connectionHasCredentials(merged)).toBe(true);
  });

  it('allows an explicit empty value to clear an older cached secret', () => {
    rememberSessionCredentials('profile-1', { password: 'old-secret' });
    rememberSessionCredentials('profile-1', { password: '' });
    expect(getSessionCredentials('profile-1')?.password).toBe('');
  });

  it('does not resurrect a cached secret when storage contains an explicit empty value', () => {
    rememberSessionCredentials('profile-1', { password: 'old-secret' });
    const merged = mergeWithSessionCredentials('profile-1', {
      authMethod: 'password' as const,
      password: '',
    });
    expect(merged.password).toBe('');
    expect(connectionHasCredentials(merged)).toBe(false);
  });
});
