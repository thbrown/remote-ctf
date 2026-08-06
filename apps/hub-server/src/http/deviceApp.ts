/**
 * doc01 §3/§8 — Web App + /api + WSS (players), HTTPS-only (HUB-020). Socket.io attaches
 * to the https.Server this app is mounted on (done by the caller, HUB-013) — this module
 * only owns plain HTTP(S) routes: static Web App bundle, /cert, /join-sheet, /attachments.
 */
import { X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { Config } from '../config.js';
import type { TlsMaterial } from './tls.js';
import { renderJoinSheetHtml } from './joinSheetPage.js';
import { renderTestQrHtml } from './testQrPage.js';

export function createDeviceApp(config: Config, tls: TlsMaterial, webDistDir: string) {
  const app = express();

  app.get('/cert', (_req, res) => {
    const x509 = new X509Certificate(tls.cert);
    res.json({ pem: tls.cert, der: x509.raw.toString('base64') }); // HUB-024
  });

  app.get('/join-sheet', async (_req, res) => {
    res.status(200).type('html').send(await renderJoinSheetHtml(config));
  });

  app.get('/test-qr', async (_req, res) => {
    res.status(200).type('html').send(await renderTestQrHtml());
  });

  app.use('/attachments', express.static(join(config.dataDir, 'attachments')));

  if (existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      res.sendFile(join(webDistDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.status(200).type('html').send(
        '<html><body><h1>Foundry CTF</h1><p>Web App not built yet — run <code>pnpm --filter @foundry-ctf/web build</code>.</p></body></html>',
      );
    });
  }

  return app;
}
