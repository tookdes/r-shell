/**
 * Credential presence checks and in-memory session cache.
 *
 * Stored secrets may be missing when "Save Passwords" is off. For duplicate/
 * reconnect of an already-authenticated tab we keep plaintext credentials in
 * memory for the app lifetime only (never written to disk here).
 */

export type CredentialFields = {
  authMethod?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyData?: string;
  passphrase?: string;
  proxyPassword?: string;
  vncPassword?: string;
};

/** True when the connection record has enough material to authenticate. */
export function connectionHasCredentials(connection: CredentialFields): boolean {
  const method =
    connection.authMethod ||
    (connection.password
      ? 'password'
      : connection.privateKeyPath || connection.privateKeyData
        ? 'publickey'
        : 'password');

  if (method === 'anonymous') return true;

  if (method === 'publickey') {
    return !!(
      (typeof connection.privateKeyPath === 'string' && connection.privateKeyPath.trim()) ||
      (typeof connection.privateKeyData === 'string' && connection.privateKeyData.trim())
    );
  }

  // password, keyboard-interactive, or unknown — need a password
  return !!(typeof connection.password === 'string' && connection.password.length > 0);
}

const sessionCredentialCache = new Map<string, CredentialFields>();

/** Remember plaintext credentials for a profile for this app session. */
export function rememberSessionCredentials(
  profileId: string,
  credentials: CredentialFields,
): void {
  if (!profileId) return;
  const prev = sessionCredentialCache.get(profileId) ?? {};
  sessionCredentialCache.set(profileId, {
    ...prev,
    authMethod: credentials.authMethod ?? prev.authMethod,
    password: credentials.password || prev.password,
    privateKeyPath: credentials.privateKeyPath || prev.privateKeyPath,
    privateKeyData: credentials.privateKeyData || prev.privateKeyData,
    passphrase: credentials.passphrase || prev.passphrase,
    proxyPassword: credentials.proxyPassword || prev.proxyPassword,
    vncPassword: credentials.vncPassword || prev.vncPassword,
  });
}

export function getSessionCredentials(profileId: string): CredentialFields | undefined {
  return sessionCredentialCache.get(profileId);
}

export function clearSessionCredentials(profileId?: string): void {
  if (profileId) {
    sessionCredentialCache.delete(profileId);
  } else {
    sessionCredentialCache.clear();
  }
}

/**
 * Merge stored connection data with session-cached secrets.
 * Session cache wins for secret fields when storage has them stripped.
 */
export function mergeWithSessionCredentials<T extends CredentialFields>(
  profileId: string,
  stored: T,
): T {
  const cached = sessionCredentialCache.get(profileId);
  if (!cached) return stored;

  return {
    ...stored,
    password: stored.password || cached.password,
    privateKeyPath: stored.privateKeyPath || cached.privateKeyPath,
    privateKeyData: stored.privateKeyData || cached.privateKeyData,
    passphrase: stored.passphrase || cached.passphrase,
    proxyPassword: stored.proxyPassword || cached.proxyPassword,
    vncPassword: stored.vncPassword || cached.vncPassword,
    authMethod: stored.authMethod || cached.authMethod,
  };
}
