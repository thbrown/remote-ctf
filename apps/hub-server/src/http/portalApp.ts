/**
 * doc01 §3.1 — captive-portal survival. Mobile OSes probe for internet on join; failing
 * the probe causes "no internet" banners and, on iOS, silent fallback to cellular, which
 * takes players off the LAN mid-game (R-5, "demo-killer"). Answer every known probe path
 * as success; redirect everything else to PUBLIC_ORIGIN (HUB-026/027).
 */
import express from 'express';
import type { Config } from '../config.js';

const SUCCESS_HTML = '<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>';

export function createPortalApp(config: Config) {
  const app = express();

  app.get(['/hotspot-detect.html', '/library/test/success.html'], (_req, res) => {
    res.status(200).type('html').send(SUCCESS_HTML);
  });

  app.get(['/generate_204', '/gen_204'], (_req, res) => {
    res.status(204).end();
  });

  app.get('/connecttest.txt', (_req, res) => {
    res.status(200).type('text/plain').send('Microsoft Connect Test');
  });

  app.get('/ncsi.txt', (_req, res) => {
    res.status(200).type('text/plain').send('Microsoft NCSI');
  });

  app.use((req, res) => {
    res.redirect(301, config.publicOrigin + req.originalUrl);
  });

  return app;
}
