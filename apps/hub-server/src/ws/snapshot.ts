/**
 * doc01 HUB-092/§6.2 state:snapshot. HUB-094: the spectator variant strips player-specific
 * fields — no `ownPlayer`, and `capturingPlayerId` (a player reference) is redacted from
 * control points since spectators get no player PII.
 */
import type { StateSnapshot } from '@foundry-ctf/shared';
import type { GameStateStore } from '../store/GameStateStore.js';

export async function buildSnapshot(
  store: GameStateStore,
  stationId: string,
  opts: { forPlayerId?: string; spectator?: boolean } = {},
): Promise<StateSnapshot> {
  const teams = await store.teams.list();
  const controlPointsRaw = await store.controlPoints.list({ stationId } as any);
  const station = await store.stations.get(stationId);
  const sessionId = (station as any)?.currentSessionId as string | null | undefined;
  const session = sessionId ? await store.sessions.get(sessionId) : null;

  const controlPoints = opts.spectator
    ? controlPointsRaw.map((cp: any) => ({ ...cp, capturingPlayerId: null }))
    : controlPointsRaw;

  const ownPlayer = opts.forPlayerId ? ((await store.players.get(opts.forPlayerId)) ?? undefined) : undefined;

  return {
    teams,
    controlPoints,
    ownPlayer: ownPlayer ?? undefined,
    session,
  } as StateSnapshot;
}
