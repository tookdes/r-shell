export type TerminalDiagnosticEvent = {
  timestamp?: string;
  event: string;
  connectionHash?: string;
  renderer?: string;
  active?: boolean;
  cols?: number;
  rows?: number;
  websocketState?: string;
  ptyGeneration?: number;
  framesReceived?: number;
  bytesReceived?: number;
  wrongConnectionFramesDropped?: number;
  fit?: boolean;
  resize?: boolean;
  dispose?: boolean;
  reconnect?: boolean;
  rendererContextLoss?: boolean;
  outputWatermark?: number;
};

type NormalizedTerminalDiagnosticEvent = TerminalDiagnosticEvent & { timestamp: string };

const MAX_QUEUE = 512;
const MAX_BATCH_BYTES = 1024 * 1024;
const FLUSH_INTERVAL_MS = 5000;

const queue: NormalizedTerminalDiagnosticEvent[] = [];
let queuedBytes = 0;
let flushTimer: ReturnType<typeof setInterval> | undefined;
let flushInProgress = false;
let sink: ((events: NormalizedTerminalDiagnosticEvent[]) => void | Promise<void>) | undefined;

function eventBytes(event: TerminalDiagnosticEvent): number {
  return JSON.stringify(event).length;
}

export function shortConnectionHash(connectionId: string): string {
  let hash = 2166136261;
  for (const char of connectionId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

export function configureTerminalDiagnostics(
  writer: (events: NormalizedTerminalDiagnosticEvent[]) => void | Promise<void>,
): void {
  sink = writer;
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flushTerminalDiagnostics();
    }, FLUSH_INTERVAL_MS);
  }
}

export function recordTerminalDiagnostic(event: TerminalDiagnosticEvent): void {
  const normalized: NormalizedTerminalDiagnosticEvent = {
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  };

  if (queue.length >= MAX_QUEUE) {
    const dropped = queue.shift();
    if (dropped) queuedBytes = Math.max(queuedBytes - eventBytes(dropped), 0);
  }

  queue.push(normalized);
  queuedBytes += eventBytes(normalized);
  if (queuedBytes >= MAX_BATCH_BYTES) void flushTerminalDiagnostics();
}

export async function flushTerminalDiagnostics(): Promise<void> {
  if (!sink || queue.length === 0 || flushInProgress) return;

  flushInProgress = true;
  const batch = queue.splice(0, queue.length);
  queuedBytes = 0;
  try {
    await sink(batch);
  } catch (error) {
    console.warn('[PTY Terminal] Failed to persist terminal diagnostics:', error);
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      queue.unshift(batch[index]);
    }
    while (queue.length > MAX_QUEUE) queue.pop();
    queuedBytes = queue.reduce((total, queuedEvent) => total + eventBytes(queuedEvent), 0);
  } finally {
    flushInProgress = false;
  }
}

export function stopTerminalDiagnostics(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = undefined;
  void flushTerminalDiagnostics();
}
