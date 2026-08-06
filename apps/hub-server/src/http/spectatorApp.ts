/** doc01 HUB-176. Plain HTTP; socket.io is attached to this server's http.Server by the
 * caller (HUB-013), not created here. */
import express from 'express';
import { SCOREBOARD_HTML } from './scoreboardPage.js';

export function createSpectatorApp(): express.Express {
  const app = express();

  app.get('/scoreboard', (_req, res) => {
    res.status(200).type('html').send(SCOREBOARD_HTML);
  });

  app.get('/', (_req, res) => {
    res.redirect(302, '/scoreboard');
  });

  return app;
}
