/** doc01 HUB-176. Plain HTTP; socket.io is attached to this server's http.Server by the
 * caller (HUB-013), not created here. */
import { join } from 'node:path';
import express from 'express';
import type { Config } from '../config.js';
import type { GameStateStore } from '../store/GameStateStore.js';
import { registerExportRoutes } from './exportRoutes.js';
import { SCOREBOARD_HTML } from './scoreboardPage.js';

export function createSpectatorApp(config: Config, store: GameStateStore): express.Express {
  const app = express();

  // spectatorApp runs on its own port (separate from deviceApp), so player photos
  // referenced by the scoreboard (profilePicture: /attachments/<ref>) need this mounted
  // here too, not just on deviceApp.
  app.use('/attachments', express.static(join(config.dataDir, 'attachments')));

  app.get('/scoreboard', (_req, res) => {
    res.status(200).type('html').send(SCOREBOARD_HTML);
  });

  // Post-game: session index, JSON/GeoJSON export, and the replay page.
  registerExportRoutes(app, store, config);

  app.get('/', (_req, res) => {
    res.redirect(302, '/scoreboard');
  });

  return app;
}
