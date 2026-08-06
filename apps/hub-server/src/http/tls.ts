/**
 * doc01 §3 (HUB-021/022). `selfsigned` mode: generate once into DATA_DIR/tls/, reuse
 * thereafter. SANs cover both a DNS name and every local IP address, so
 * `https://<gateway-ip>/` works with zero DNS (HUB-022). `provided` mode: load
 * TLS_CERT_PATH/TLS_KEY_PATH verbatim.
 */
import { networkInterfaces } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import selfsigned from 'selfsigned';
import type { Config } from '../config.js';

export interface TlsMaterial {
  cert: string; // PEM
  key: string; // PEM
}

function localIPv4Addresses(): string[] {
  const addrs = new Set<string>(['127.0.0.1']);
  for (const ifaceList of Object.values(networkInterfaces())) {
    for (const iface of ifaceList ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.add(iface.address);
    }
  }
  return [...addrs];
}

function generateSelfSigned(): TlsMaterial {
  const ips = localIPv4Addresses();
  const altNames = [
    { type: 2, value: 'localhost' }, // DNS
    ...ips.map((ip) => ({ type: 7, ip })), // IP
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'foundry-ctf.local' }], {
    keySize: 2048,
    days: 825, // HUB-022
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  return { cert: pems.cert, key: pems.private };
}

export async function loadOrCreateTlsMaterial(config: Config): Promise<TlsMaterial> {
  if (config.tlsMode === 'provided') {
    if (!config.tlsCertPath || !config.tlsKeyPath) {
      throw new Error('TLS_MODE=provided requires TLS_CERT_PATH and TLS_KEY_PATH');
    }
    const [cert, key] = await Promise.all([readFile(config.tlsCertPath, 'utf8'), readFile(config.tlsKeyPath, 'utf8')]);
    return { cert, key };
  }

  const tlsDir = join(config.dataDir, 'tls');
  const certPath = join(tlsDir, 'cert.pem');
  const keyPath = join(tlsDir, 'key.pem');

  try {
    const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
    return { cert, key };
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const material = generateSelfSigned();
  await mkdir(tlsDir, { recursive: true });
  await Promise.all([writeFile(certPath, material.cert, 'utf8'), writeFile(keyPath, material.key, 'utf8')]);
  return material;
}
