/**
 * Credential encryption helpers backed by Tauri AES-256-GCM commands.
 * Plaintext is only held briefly in memory while connecting.
 */

import { invoke } from '@tauri-apps/api/core';

const ENC_PREFIX = 'enc:v1:';

export function isEncryptedSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  if (!plaintext) return plaintext;
  if (isEncryptedSecret(plaintext)) return plaintext;
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
