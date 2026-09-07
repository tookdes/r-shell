import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zmodemFilename } from '../lib/zmodem-transfer';


describe('createZmodemTransferController output routing', () => {
  let onDetectCapture: ((detection: unknown) => void) | undefined;
  let writeTerminal: ReturnType<typeof vi.fn>;
  let sendRaw: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    onDetectCapture = undefined;
    writeTerminal = vi.fn();
    sendRaw = vi.fn().mockReturnValue(true);

    vi.doMock('zmodem.js', () => {
      class MockSentry {
        private toTerminal: (octets: number[]) => void;
        private active = false;
        constructor(options: {
          on_detect: (d: unknown) => void;
          to_terminal: (octets: number[]) => void;
        }) {
          onDetectCapture = (detection: unknown) => {
            // Mirror the real sentry: confirming activates the session and the
            // frame that triggered detection is echoed to the terminal.
            const typed = detection as { confirm(): unknown };
            if (options.on_detect) options.on_detect(detection);
            this.active = true;
            void typed.confirm;
          };
          this.toTerminal = options.to_terminal;
        }
        consume(bytes: Uint8Array) {
          if (this.active) {
            this.toTerminal(Array.from(bytes));
          }
        }
      }
      return { Sentry: MockSentry };
    });

    const { createZmodemTransferController } = await import('../lib/zmodem-transfer');
    controller = await createZmodemTransferController({
      send: sendRaw,
      writeTerminal,
      setActive: vi.fn(),
      notifySuccess: vi.fn(),
      notifyError: vi.fn(),
      notifyInfo: vi.fn(),
    });
  });

  let controller: import('../lib/zmodem-transfer').ZmodemTransferController;

  function createReceiveSession() {
    let sessionEnd: (() => void) | undefined;
    const session = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'session_end') sessionEnd = handler;
      }),
      start: vi.fn().mockResolvedValue(undefined),
      has_ended: vi.fn().mockReturnValue(false),
      abort: vi.fn(),
    };
    return {
      session,
      end() {
        sessionEnd?.();
      },
    };
  }

  function detectReceive(session: ReturnType<typeof createReceiveSession>['session']) {
    const deny = vi.fn();
    onDetectCapture?.({
      get_session_role: () => 'receive',
      confirm: () => session,
      deny,
      is_valid: () => true,
    });
    return deny;
  }

  it('does not echo terminal output while no ZMODEM session is active', () => {
    controller.consume(new Uint8Array([0x1b, 0x5b, 0x48, 0x61]));
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it('routes output through the sentry once a session becomes active', () => {
    expect(onDetectCapture).toBeDefined();
    const session = {
      on: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      get_role: () => 'receive',
      has_ended: () => false,
      abort: vi.fn(),
    };
    onDetectCapture?.({
      get_session_role: () => 'receive',
      confirm: () => session,
      deny: vi.fn(),
      is_valid: () => true,
    });

    // After the session starts, sentry-routed bytes must reach the terminal.
    controller.consume(new Uint8Array([0x1b, 0x5b, 0x48, 0x62]));
    expect(writeTerminal).toHaveBeenCalled();
    expect(Array.from(writeTerminal.mock.calls[0][0] as Uint8Array)).toEqual([0x1b, 0x5b, 0x48, 0x62]);
  });

  it('can start another ZMODEM session after a silent abort', () => {
    const first = createReceiveSession();
    expect(detectReceive(first.session)).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(true);

    controller.abort();
    expect(first.session.abort).toHaveBeenCalledOnce();
    expect(controller.isActive()).toBe(false);

    const second = createReceiveSession();
    const secondDeny = detectReceive(second.session);
    expect(secondDeny).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(true);
  });

  it('ignores a stale session_end callback after a newer session starts', async () => {
    const first = createReceiveSession();
    detectReceive(first.session);
    controller.abort();

    const second = createReceiveSession();
    detectReceive(second.session);
    expect(controller.isActive()).toBe(true);

    first.end();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.isActive()).toBe(true);
  });
});

describe('ZMODEM filenames', () => {
  it('extracts a leaf name from Windows and Unix paths', () => {
    expect(zmodemFilename.basename(String.raw`C:\\temp\\archive.tar.gz`)).toBe('archive.tar.gz');
    expect(zmodemFilename.basename('/tmp/archive.tar.gz')).toBe('archive.tar.gz');
  });

  it('prevents a remote sender from choosing local directories', () => {
    expect(zmodemFilename.safeReceived('../../secret.txt')).toBe('secret.txt');
    expect(zmodemFilename.safeReceived(String.raw`..\\..\\secret.txt`)).toBe('secret.txt');
  });

  it('replaces characters that are invalid in Windows filenames', () => {
    expect(zmodemFilename.safeReceived('bad:name?.txt')).toBe('bad_name_.txt');
  });

  it('provides a safe fallback for empty and dot names', () => {
    expect(zmodemFilename.safeReceived('')).toBe('download');
    expect(zmodemFilename.safeReceived('..')).toBe('download');
  });
});
