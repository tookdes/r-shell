import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { open as openFile, SeekMode, stat, type FileHandle } from '@tauri-apps/plugin-fs';
import i18n from './i18n';
import type {
  Detection,
  ReceiveTransfer,
  Session,
  Sentry,
} from 'zmodem.js';

const SEND_CHUNK_SIZE = 64 * 1024;

export interface ZmodemTransferCallbacks {
  send(bytes: Uint8Array): boolean;
  writeTerminal(bytes: Uint8Array): void;
  setActive(active: boolean): void;
  notifySuccess(message: string): void;
  notifyError(message: string): void;
  notifyInfo(message: string): void;
}

export interface ZmodemTransferController {
  consume(bytes: Uint8Array): boolean;
  isActive(): boolean;
  abort(silent?: boolean): void;
}

function zmodemBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-1) || '';
}

function safeReceivedFilename(name: string): string {
  const leaf = Array.from(zmodemBasename(name), (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || '<>:"/\\|?*'.includes(character) ? '_' : character;
  }).join('').trim();
  if (!leaf || leaf === '.' || leaf === '..') return 'download';
  return leaf;
}

export const zmodemFilename = {
  basename: zmodemBasename,
  safeReceived: safeReceivedFilename,
};

async function writeChunk(file: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const written = await file.write(chunk.subarray(offset));
    if (written <= 0) throw new Error('Unable to write received file data');
    offset += written;
  }
}

async function receiveFile(offer: ReceiveTransfer): Promise<boolean> {
  const details = offer.get_details();
  const name = safeReceivedFilename(details.name);
  const destination = await saveDialog({
    title: i18n.t('ptyTerminal.zmodem.saveTitle'),
    defaultPath: name,
  });

  if (!destination) {
    await offer.skip();
    return false;
  }

  const file = await openFile(destination, { write: true, create: true, truncate: true });
  let writeChain = Promise.resolve();
  try {
    await offer.accept({
      on_input(bytes) {
        const chunk = Uint8Array.from(bytes);
        writeChain = writeChain.then(() => writeChunk(file, chunk));
      },
    });
    await writeChain;
    return true;
  } finally {
    await writeChain.catch(() => undefined);
    await file.close();
  }
}

async function sendOneFile(
  session: Session,
  path: string,
  filesRemaining: number,
  bytesRemaining: number,
): Promise<boolean> {
  const info = await stat(path);
  const transfer = await session.send_offer({
    name: zmodemBasename(path),
    size: info.size,
    mtime: info.mtime,
    files_remaining: filesRemaining,
    bytes_remaining: bytesRemaining,
  });
  if (!transfer) return false;

  const file = await openFile(path, { read: true });
  const start = Math.min(transfer.get_offset(), info.size);
  try {
    if (start > 0) await file.seek(start, SeekMode.Start);
    let offset = start;
    while (offset < info.size) {
      const buffer = new Uint8Array(Math.min(SEND_CHUNK_SIZE, info.size - offset));
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;
      const chunk = buffer.subarray(0, bytesRead);
      offset += bytesRead;
      if (offset >= info.size) {
        await transfer.end(chunk);
      } else {
        transfer.send(chunk);
      }
    }
    if (offset < info.size) throw new Error(`Unexpected end of file while reading ${path}`);
    if (start === info.size) await transfer.end();
  } finally {
    await file.close();
  }
  return true;
}

async function selectAndSendFiles(session: Session): Promise<{ sent: number; cancelled: boolean }> {
  const selected = await openDialog({
    title: i18n.t('ptyTerminal.zmodem.selectFilesTitle'),
    multiple: true,
    directory: false,
  });
  const paths = typeof selected === 'string' ? [selected] : selected ?? [];
  if (paths.length === 0) return { sent: 0, cancelled: true };

  const infos = await Promise.all(paths.map((path) => stat(path)));
  let bytesRemaining = infos.reduce((total, info) => total + info.size, 0);
  let sent = 0;
  for (let index = 0; index < paths.length; index += 1) {
    if (await sendOneFile(session, paths[index], paths.length - index, bytesRemaining)) sent += 1;
    bytesRemaining -= infos[index].size;
  }
  await session.close();
  return { sent, cancelled: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createZmodemTransferController(
  callbacks: ZmodemTransferCallbacks,
): Promise<ZmodemTransferController> {
  const zmodem = await import('zmodem.js');
  let activeSession: Session | null = null;
  let disposed = false;

  const finish = () => {
    activeSession = null;
    callbacks.setActive(false);
  };

  const fail = (session: Session, error: unknown) => {
    try {
      if (!session.has_ended()) session.abort();
    } catch (_abortError) {
      // The peer may already have ended the session.
    }
    callbacks.notifyError(i18n.t('ptyTerminal.zmodem.failed', { error: errorMessage(error) }));
    finish();
  };

  const handleReceiveSession = (session: Session) => {
    let received = 0;
    const pendingReceives = new Set<Promise<void>>();
    let sessionEnded = false;
    callbacks.notifyInfo(i18n.t('ptyTerminal.zmodem.downloadStarted'));
    session.on('offer', (offer) => {
      const task = receiveFile(offer)
        .then((saved) => {
          if (saved) {
            received += 1;
            callbacks.notifySuccess(i18n.t('ptyTerminal.zmodem.fileReceived', {
              name: safeReceivedFilename(offer.get_details().name),
            }));
          }
        })
        .catch((error: unknown) => fail(session, error));
      pendingReceives.add(task);
      void task.finally(() => pendingReceives.delete(task));
    });
    session.on('session_end', () => {
      if (sessionEnded) return;
      sessionEnded = true;
      void Promise.allSettled(Array.from(pendingReceives)).then(() => {
        if (received > 0) {
          callbacks.notifySuccess(i18n.t('ptyTerminal.zmodem.downloadComplete', { count: received }));
        }
        finish();
      });
    });
    void session.start().catch((error: unknown) => fail(session, error));
  };

  const handleSendSession = (session: Session) => {
    let sessionEnded = false;
    callbacks.notifyInfo(i18n.t('ptyTerminal.zmodem.uploadStarted'));
    session.on('session_end', () => {
      if (sessionEnded) return;
      sessionEnded = true;
      finish();
    });
    void selectAndSendFiles(session)
      .then(({ sent, cancelled }) => {
        if (cancelled) {
          session.abort();
          callbacks.notifyInfo(i18n.t('ptyTerminal.zmodem.cancelled'));
        } else {
          callbacks.notifySuccess(i18n.t('ptyTerminal.zmodem.uploadComplete', { count: sent }));
        }
      })
      .catch((error: unknown) => fail(session, error));
  };

  // True when the current consume() call entered with an active session.
  // When idle (no ZMODEM session), pty-terminal displays the frame directly
  // BEFORE calling consume(), so echoing here would duplicate output. Echoing
  // must still happen for the frame in which a session ends so the trailing
  // bytes after the ZMODEM "OO" marker are not lost.
  let consumeHadActiveSession = false;

  const sentry: Sentry = new zmodem.Sentry({
    to_terminal(octets) {
      if (consumeHadActiveSession && octets.length > 0) {
        callbacks.writeTerminal(Uint8Array.from(octets));
      }
    },
    sender(octets) {
      if (!callbacks.send(Uint8Array.from(octets))) {
        throw new Error(i18n.t('ptyTerminal.zmodem.socketClosed'));
      }
    },
    on_detect(detection: Detection) {
      if (disposed || activeSession) {
        detection.deny();
        return;
      }
      const session = detection.confirm();
      activeSession = session;
      callbacks.setActive(true);
      if (detection.get_session_role() === 'receive') {
        handleReceiveSession(session);
      } else {
        handleSendSession(session);
      }
    },
    on_retract() {},
  });

  return {
    consume(bytes) {
      consumeHadActiveSession = activeSession !== null;
      sentry.consume(bytes);
      return activeSession !== null;
    },
    isActive() {
      return activeSession !== null;
    },
    abort(silent = true) {
      const session = activeSession;
      disposed = silent;
      try {
        if (session && !session.has_ended()) session.abort();
      } catch (_error) {
        // Best-effort cleanup during socket/component teardown.
      }
      activeSession = null;
      callbacks.setActive(false);
      if (!silent && session) callbacks.notifyInfo(i18n.t('ptyTerminal.zmodem.cancelled'));
    },
  };
}
