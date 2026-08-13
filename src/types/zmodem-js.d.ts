declare module 'zmodem.js' {
  export interface Detection {
    confirm(): Session;
    deny(): void;
    is_valid(): boolean;
    get_session_role(): 'send' | 'receive';
  }

  export interface TransferDetails {
    name: string;
    size: number | null;
    mtime: Date | null;
    mode: number | null;
    files_remaining: number | null;
    bytes_remaining: number | null;
  }

  export interface ReceiveTransfer {
    get_details(): TransferDetails;
    get_payloads(): Uint8Array[];
    accept(options?: {
      on_input?: 'spool_uint8array' | 'spool_array' | ((bytes: number[]) => void);
    }): Promise<Uint8Array[]>;
    skip(): Promise<unknown>;
    on(event: 'input' | 'complete', callback: (bytes?: number[]) => void): this;
  }

  export interface SendTransfer {
    get_offset(): number;
    send(bytes: Uint8Array): void;
    end(bytes?: Uint8Array): Promise<void>;
  }

  export interface Session {
    readonly type: 'send' | 'receive';
    get_role(): 'send' | 'receive';
    on(event: 'offer', callback: (offer: ReceiveTransfer) => void): this;
    on(event: 'session_end', callback: () => void): this;
    start(): Promise<ReceiveTransfer | void>;
    send_offer(details: {
      name: string;
      size: number;
      mtime?: Date | null;
      files_remaining?: number;
      bytes_remaining?: number;
    }): Promise<SendTransfer | undefined>;
    close(): Promise<void>;
    abort(): void;
    aborted(): boolean;
    has_ended(): boolean;
  }

  export interface SentryOptions {
    to_terminal(octets: number[]): void;
    sender(octets: number[]): void;
    on_detect(detection: Detection): void;
    on_retract(): void;
  }

  export class Sentry {
    constructor(options: SentryOptions);
    consume(input: ArrayBuffer | Uint8Array | number[]): void;
    get_confirmed_session(): Session | null;
  }
}
