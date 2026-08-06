import { describe, expect, it } from 'vitest';
import { encodeCpQr, isQrParseError, parseQr } from './qr.js';

describe('parseQr', () => {
  it('parses a cp payload and retains colons past the third', () => {
    const raw = 'qrctf:1:cp:AA:BB:CC:DD:EE:FF';
    const parsed = parseQr(raw);
    expect(isQrParseError(parsed)).toBe(false);
    if (!isQrParseError(parsed) && parsed.kind === 'cp') {
      expect(parsed.macAddress).toBe('AA:BB:CC:DD:EE:FF');
      expect(parsed.version).toBe(1);
    }
  });

  it('round-trips encodeCpQr', () => {
    const raw = encodeCpQr('aa:bb:cc:dd:ee:ff');
    const parsed = parseQr(raw);
    expect(isQrParseError(parsed)).toBe(false);
    if (!isQrParseError(parsed) && parsed.kind === 'cp') {
      expect(parsed.macAddress).toBe('AA:BB:CC:DD:EE:FF');
    }
  });

  it('parses rp and pl payloads', () => {
    const rp = parseQr('qrctf:1:rp:respawn-123');
    expect(!isQrParseError(rp) && rp.kind === 'rp' && rp.respawnLocationId === 'respawn-123').toBe(true);

    const pl = parseQr('qrctf:1:pl:abcdEFGH12345678');
    expect(!isQrParseError(pl) && pl.kind === 'pl' && pl.qrCodeToken === 'abcdEFGH12345678').toBe(true);
  });

  it('rejects unknown scheme', () => {
    const parsed = parseQr('https://example.com/');
    expect(isQrParseError(parsed) && parsed.reason === 'unknown_scheme').toBe(true);
  });

  it('rejects unknown kind', () => {
    const parsed = parseQr('qrctf:1:zz:value');
    expect(isQrParseError(parsed) && parsed.reason === 'unknown_kind').toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isQrParseError(parseQr('qrctf:1:cp'))).toBe(true);
    expect(isQrParseError(parseQr('qrctf:1:cp:'))).toBe(true);
  });
});
