const connectionIdDecoder = new TextDecoder();

export interface PtyOutputFrameRoute {
  payload: Uint8Array | null;
  wrongConnection: boolean;
  payloadBytes: number;
}

/**
 * Route a binary PTY output frame to exactly one terminal instance.
 *
 * Wire format: [0x01][id_len: u16 BE][connection_id UTF-8][payload].
 * The returned object intentionally exposes no terminal text and no foreign
 * connection id, so callers can safely feed the counters into diagnostics.
 */
export function routePtyOutputFrame(
  frameData: ArrayBuffer | Uint8Array,
  expectedConnectionId: string,
): PtyOutputFrameRoute {
  const data = frameData instanceof Uint8Array ? frameData : new Uint8Array(frameData);
  if (data.length < 3 || data[0] !== 0x01) {
    return { payload: null, wrongConnection: false, payloadBytes: 0 };
  }

  const idLength = (data[1] << 8) | data[2];
  const payloadOffset = 3 + idLength;
  if (data.length < payloadOffset) {
    return { payload: null, wrongConnection: false, payloadBytes: 0 };
  }

  const frameConnectionId = connectionIdDecoder.decode(data.subarray(3, payloadOffset));
  const payloadBytes = data.length - payloadOffset;
  if (frameConnectionId !== expectedConnectionId) {
    return { payload: null, wrongConnection: true, payloadBytes };
  }

  return {
    payload: data.subarray(payloadOffset),
    wrongConnection: false,
    payloadBytes,
  };
}
