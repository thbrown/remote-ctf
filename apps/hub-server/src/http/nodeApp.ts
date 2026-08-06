/**
 * doc00 §0.3 — Control Point Node API. HUB-014: this Express app MUST expose no
 * game-mutating endpoint beyond those in doc00, and MUST NOT serve static assets, the Web
 * App, or any admin surface. HUB-011: MUST NOT depend on TLS material being present.
 */
import express from 'express';
import {
  CpHeartbeatRequestSchema,
  CpPresenceRequestSchema,
  CpRegisterRequestSchema,
  normalizeMac,
  type CpHeartbeatResponse,
  type CpPresenceResponse,
  type CpRegisterResponse,
} from '@foundry-ctf/shared';
import type { GameStateStore } from '../store/GameStateStore.js';
import type { NodeRegistry } from '../nodes/NodeRegistry.js';
import type { Config } from '../config.js';
import { validateBody } from './validate.js';

export function createNodeApp(store: GameStateStore, registry: NodeRegistry, config: Config) {
  const app = express();
  app.use(express.json());

  app.post('/api/cp/register', validateBody(CpRegisterRequestSchema), async (req, res) => {
    const { mac: rawMac, ip, fw } = req.body as { mac: string; ip: string; fw: string };
    const mac = normalizeMac(rawMac); // CON-005: Hub normalizes case defensively

    const existingCps = await store.controlPoints.list({ macAddress: mac } as any);
    const claimed = existingCps.length > 0;
    const controlPointId = claimed ? existingCps[0].controlPointId : null;

    registry.upsertOnRegisterOrHeartbeat(mac, { ip, fw }); // CON-010: overwrite ip every call
    registry.setControlPointId(mac, controlPointId);

    if (!claimed) {
      // CON-012: unclaimed Nodes show the configured unclaimedHexColor
      registry.setDesired(mac, config.unclaimedHexColor, 'solid');
    }

    const record = registry.get(mac)!;
    const body: CpRegisterResponse = {
      claimed,
      controlPointId,
      hexColor: record.desiredColor,
      pattern: record.desiredPattern,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    };
    res.status(200).json(body); // CON-011: never 404, even for an unknown MAC
  });

  app.post('/api/cp/presence', validateBody(CpPresenceRequestSchema), async (req, res) => {
    const { mac: rawMac, detected } = req.body as { mac: string; detected: boolean };
    const mac = normalizeMac(rawMac);

    const cps = await store.controlPoints.list({ macAddress: mac } as any);
    if (cps.length > 0) {
      // CON-013: state assertion, not an event — idempotent write, duplicates harmless.
      // Feeds the store change feed, which is how GameEngine (task #7) observes presence
      // transitions without nodeApp knowing anything about capture rules.
      await store.controlPoints.update(cps[0].controlPointId, { isHumanDetected: detected });
    }

    const record = registry.get(mac);
    const hexColor = record?.desiredColor ?? config.unclaimedHexColor;
    const pattern = record?.desiredPattern ?? 'solid';
    const body: CpPresenceResponse = { hexColor, pattern }; // CON-014: fast self-heal path
    res.status(200).json(body);
  });

  app.post('/api/cp/heartbeat', validateBody(CpHeartbeatRequestSchema), async (req, res) => {
    const { mac: rawMac, ip, detected, hexColor: reportedHexColor } = req.body as {
      mac: string;
      ip: string;
      detected: boolean;
      hexColor: string;
    };
    const mac = normalizeMac(rawMac);

    registry.upsertOnRegisterOrHeartbeat(mac, { ip, reportedColor: reportedHexColor }); // CON-010

    const cps = await store.controlPoints.list({ macAddress: mac } as any);
    const claimed = cps.length > 0;
    const controlPointId = claimed ? cps[0].controlPointId : null;
    registry.setControlPointId(mac, controlPointId);

    if (claimed) {
      await store.controlPoints.update(cps[0].controlPointId, { isHumanDetected: detected });
    } else {
      registry.setDesired(mac, config.unclaimedHexColor, 'solid');
    }

    const record = registry.get(mac)!;
    const body: CpHeartbeatResponse = {
      claimed,
      controlPointId,
      hexColor: record.desiredColor, // CON-016: what the Node SHOULD be showing
      pattern: record.desiredPattern,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    };
    res.status(200).json(body);
  });

  return app;
}
