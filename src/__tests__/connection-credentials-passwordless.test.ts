import { describe, expect, it } from 'vitest';
import { connectionHasCredentials } from '../lib/connection-credentials';

describe('connectionHasCredentials passwordless/default-key semantics', () => {
  it('accepts an explicitly configured blank password', () => {
    expect(connectionHasCredentials({ authMethod: 'password', password: '' })).toBe(true);
  });

  it('rejects a password profile whose credential is absent', () => {
    expect(connectionHasCredentials({ authMethod: 'password' })).toBe(false);
  });

  it('allows public-key auth without a stored path so the backend can resolve defaults', () => {
    expect(connectionHasCredentials({ authMethod: 'publickey' })).toBe(true);
  });
});
