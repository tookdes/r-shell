import { describe, expect, it } from 'vitest';
import { pickDefaultNetworkInterface, resolveActiveInterface } from '../network-interface';

describe('network interface selection', () => {
  it('picks the busiest interface without relying on Linux names', () => {
    expect(pickDefaultNetworkInterface([
      { interface: 'anpi0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
      { interface: 'en1', rx_bytes_per_sec: 210944, tx_bytes_per_sec: 1061 },
    ])).toBe('en1');
  });

  it('uses aggregate when every interface is idle', () => {
    expect(pickDefaultNetworkInterface([
      { interface: 'en0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
      { interface: 'en1', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
    ])).toBe('all');
  });

  it('preserves a user choice and falls back when it disappears', () => {
    const bandwidth = [
      { interface: 'en0', rx_bytes_per_sec: 100, tx_bytes_per_sec: 50 },
      { interface: 'en1', rx_bytes_per_sec: 200, tx_bytes_per_sec: 50 },
    ];
    expect(resolveActiveInterface('en0', null, ['en0', 'en1'], bandwidth)).toBe('en0');
    expect(resolveActiveInterface('utun0', null, ['en0', 'en1'], bandwidth)).toBe('en1');
  });

  it('holds the previous automatic choice through an idle sample', () => {
    const idle = [
      { interface: 'en0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
      { interface: 'en1', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
    ];
    expect(resolveActiveInterface(null, 'en1', ['en0', 'en1'], idle)).toBe('en1');
  });
});
