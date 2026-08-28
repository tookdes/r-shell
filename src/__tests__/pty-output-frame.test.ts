import { describe, expect, it } from 'vitest';
import { routePtyOutputFrame } from '../lib/pty-output-frame';

function frame(connectionId: string, payload: string): ArrayBuffer {
  const id = new TextEncoder().encode(connectionId);
  const body = new TextEncoder().encode(payload);
  const result = new Uint8Array(3 + id.length + body.length);
  result[0] = 1;
  result[1] = id.length >> 8;
  result[2] = id.length & 255;
  result.set(id, 3);
  result.set(body, 3 + id.length);
  return result.buffer;
}

describe('PTY output frame routing', () => {
  it('keeps sustained terminal A output isolated from terminal B', () => {
    let deliveredToA = 0;
    let deliveredToB = 0;
    let wrongConnectionDrops = 0;

    for (let index = 0; index < 2_000; index += 1) {
      const raw = frame('A', `btop-frame-${index}`);
      const a = routePtyOutputFrame(raw, 'A');
      const b = routePtyOutputFrame(raw, 'B');

      if (a.payload) deliveredToA += 1;
      if (b.payload) deliveredToB += 1;
      if (b.wrongConnection) wrongConnectionDrops += 1;
    }

    expect(deliveredToA).toBe(2_000);
    expect(deliveredToB).toBe(0);
    expect(wrongConnectionDrops).toBe(2_000);
  });

  it('rejects malformed and non-output frames without exposing payload', () => {
    const malformed = new Uint8Array([1, 0, 10, 65]).buffer;
    const wrongType = new Uint8Array([2, 0, 0]).buffer;

    expect(routePtyOutputFrame(malformed, 'A').payload).toBeNull();
    expect(routePtyOutputFrame(wrongType, 'A').payload).toBeNull();
  });
});
