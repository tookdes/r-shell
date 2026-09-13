/**
 * Credential encryption helpers backed by Tauri AES-256-GCM commands.
 *
 * The outer `enc:v1:` marker remains stable for storage compatibility. New
 * backend payloads start with `v2:` and use an OS-keychain-backed master key.
 * Legacy payloads are decrypted and re-sealed the next time a profile is saved.
 */

import { invoke } from '@tauri-apps/api/core';

const ENC_PREFIX = 'enc:v1:';
const KEYCHAIN_PAYLOAD_PREFIX = 'v2:';

export function isEncryptedSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export function isKeychainEncryptedSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(`${ENC_PREFIX}${KEYCHAIN_PAYLOAD_PREFIX}`);
}

export async function encryptSecret(value: string): Promise<string> {
  if (!value) return value;
  if (isKeychainEncryptedSecret(value)) return value;

  // Legacy encrypted values must be opened with the historical file key and
  // immediately re-sealed with the OS-keychain-backed key. This makes migration
  // incremental and avoids a destructive one-shot conversion at startup.
  const plaintext = isEncryptedSecret(value) ? await decryptSecret(value) : value;
  const cipher = await invoke<string>('secrets_encrypt', { plaintext });
  return `${ENC_PREFIX}${cipher}`;
}

export async function decryptSecret(value: string | undefined | null): Promise<string> {
  if (!value) return '';
  if (!isEncryptedSecret(value)) return value;
  const cipher = value.slice(ENC_PREFIX.length);
  return invoke<string>('secrets_decrypt', { ciphertext: cipher });
}

export async function decryptConnectionSecrets<T extends {
  password?: string;
  passphrase?: string;
  vncPassword?: string;
  privateKeyData?: string;
  proxyPassword?: string;
}>(connection: T): Promise<T> {
  const next = { ...connection };
  if (next.password) next.password = await decryptSecret(next.password);
  if (next.passphrase) next.passphrase = await decryptSecret(next.passphrase);
  if (next.vncPassword) next.vncPassword = await decryptSecret(next.vncPassword);
  if (next.privateKeyData) next.privateKeyData = await decryptSecret(next.privateKeyData);
  if (next.proxyPassword) next.proxyPassword = await decryptSecret(next.proxyPassword);
  return next;
}

export async function encryptConnectionSecrets<T extends {
  password?: string;
  passphrase?: string;
  vncPassword?: string;
  privateKeyData?: string;
  proxyPassword?: string;
}>(connection: T): Promise<T> {
  const next = { ...connection };
  if (next.password) next.password = await encryptSecret(next.password);
  if (next.passphrase) next.passphrase = await encryptSecret(next.passphrase);
  if (next.vncPassword) next.vncPassword = await encryptSecret(next.vncPassword);
  if (next.privateKeyData) next.privateKeyData = await encryptSecret(next.privateKeyData);
  if (next.proxyPassword) next.proxyPassword = await encryptSecret(next.proxyPassword);
  return next;
}
