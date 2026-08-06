/**
 * QR payload scheme (doc00 CON-030..033): qrctf:<version>:<kind>:<value>
 * The join QR is a bare URL, deliberately outside this scheme (CON-033).
 */

export type QrKind = 'cp' | 'rp' | 'pl';

export interface ParsedCpQr {
  kind: 'cp';
  version: number;
  macAddress: string; // uppercase, colon-separated
}
export interface ParsedRpQr {
  kind: 'rp';
  version: number;
  respawnLocationId: string;
}
export interface ParsedPlQr {
  kind: 'pl';
  version: number;
  qrCodeToken: string;
}
export type ParsedQr = ParsedCpQr | ParsedRpQr | ParsedPlQr;

export type QrParseError =
  | { reason: 'unknown_scheme' }
  | { reason: 'unknown_version'; version: string }
  | { reason: 'unknown_kind'; kind: string }
  | { reason: 'malformed' };

/**
 * CON-032: MAC colons are retained inside the `cp` payload. Split on the first three
 * colons only — everything after the third colon is the value. This generalizes to all
 * kinds since only `cp` values contain colons, but we apply the same "first 3 colons"
 * split rule uniformly per the contract's wording.
 */
export function parseQr(raw: string): ParsedQr | QrParseError {
  if (!raw.startsWith('qrctf:')) return { reason: 'unknown_scheme' };

  const parts = raw.split(':');
  // ['qrctf', version, kind, ...valueParts]
  if (parts.length < 4) return { reason: 'malformed' };

  const [, versionStr, kind, ...valueParts] = parts;
  const version = Number(versionStr);
  if (!Number.isInteger(version) || version < 1) {
    return { reason: 'unknown_version', version: versionStr };
  }

  const value = valueParts.join(':');
  if (value.length === 0) return { reason: 'malformed' };

  switch (kind as QrKind) {
    case 'cp':
      return { kind: 'cp', version, macAddress: value.toUpperCase() };
    case 'rp':
      return { kind: 'rp', version, respawnLocationId: value };
    case 'pl':
      return { kind: 'pl', version, qrCodeToken: value };
    default:
      return { reason: 'unknown_kind', kind };
  }
}

export function isQrParseError(x: ParsedQr | QrParseError): x is QrParseError {
  return 'reason' in x;
}

export function encodeCpQr(macAddress: string, version = 1): string {
  return `qrctf:${version}:cp:${macAddress.toUpperCase()}`;
}
export function encodeRpQr(respawnLocationId: string, version = 1): string {
  return `qrctf:${version}:rp:${respawnLocationId}`;
}
export function encodePlQr(qrCodeToken: string, version = 1): string {
  return `qrctf:${version}:pl:${qrCodeToken}`;
}

/** CON-005: canonical MAC format is uppercase, colon-separated. Normalize defensively. */
export function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase();
}

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
export function isValidMac(mac: string): boolean {
  return MAC_RE.test(mac);
}

const HEX_COLOR_RE = /^#[0-9A-F]{6}$/;
export function isValidHexColor(hex: string): boolean {
  return HEX_COLOR_RE.test(hex);
}
