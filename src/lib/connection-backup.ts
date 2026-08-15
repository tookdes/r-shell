/**
 * Automatic backup/restore for connection data.
 *
 * The primary store is WebView2 localStorage (keys `r-shell-connections`,
 * `r-shell-connection-folders`, ...). A stock Tauri NSIS uninstaller used to
 * wipe `%APPDATA%/<bundle-id>` and `%LOCALAPPDATA%/<bundle-id>` on uninstall,
 * and upgrade installs defaulted to "uninstall first" — together that
 * silently destroyed every saved connection. The installer template in
 * `src-tauri/nsis/installer.nsi` fixes that, and this module is the second
 * line of defence: a plain-text snapshot of the connection data lives in
 * `%LOCALAPPDATA%/<bundle-id>/data/connections-backup.json`, so even a
 * WebView2 data reset or an explicit manual uninstall can be recovered.
 */

import { appLocalDataDir } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

export interface ConnectionBackupPayload {
  savedAt: string;
  connections: string | null;
  folders: string | null;
  profiles: string | null;
  settings: string | null;
}

let backupDirPromise: Promise<string> | null = null;

async function getBackupDir(): Promise<string> {
  if (!backupDirPromise) {
    backupDirPromise = appLocalDataDir().then((dir) => `${dir.replace(/[\\/]+$/, '')}/data`);
  }
  return backupDirPromise;
}

/** Snapshot the current connection/settings localStorage keys to disk. */
export async function backupConnectionsNow(): Promise<void> {
  try {
    const dir = await getBackupDir();
    const payload: ConnectionBackupPayload = {
      savedAt: new Date().toISOString(),
      connections: localStorage.getItem('r-shell-connections'),
      folders: localStorage.getItem('r-shell-connection-folders'),
      profiles: localStorage.getItem('r-shell-connection-profiles'),
      settings: localStorage.getItem('sshClientSettings'),
    };
    await writeTextFile(`${dir}/connections-backup.json`, JSON.stringify(payload, null, 2));
  } catch (error) {
    // Non-fatal: backup is best-effort. Running in tests / dev without Tauri
    // APIs just skips.
    console.error('[connection-backup] failed to write backup:', error);
  }
}

/**
 * If localStorage has no connection data but a backup file exists, restore it.
 * Returns true when a restore happened.
 */
export async function restoreConnectionsIfEmpty(): Promise<boolean> {
  try {
    if (localStorage.getItem('r-shell-connections')) return false;
    const dir = await getBackupDir();
    const raw = await readTextFile(`${dir}/connections-backup.json`);
    const payload = JSON.parse(raw) as ConnectionBackupPayload;
    if (!payload || typeof payload !== 'object') return false;
    if (payload.connections) localStorage.setItem('r-shell-connections', payload.connections);
    if (payload.folders) localStorage.setItem('r-shell-connection-folders', payload.folders);
    if (payload.profiles) localStorage.setItem('r-shell-connection-profiles', payload.profiles);
    if (payload.settings) localStorage.setItem('sshClientSettings', payload.settings);
    console.log('[connection-backup] restored connections from backup file');
    return true;
  } catch (error) {
    // No backup exists yet (fresh install) or backup unreadable — not an error.
    console.debug('[connection-backup] no backup to restore:', error);
    return false;
  }
}
