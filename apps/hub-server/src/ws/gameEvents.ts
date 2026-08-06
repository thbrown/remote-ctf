/**
 * Adapts GameEngine's transport-agnostic event sink onto socket.io broadcasts (doc01 §6.2).
 * Public capture/session events go to everyone (control point state, scores — visible to
 * spectators too); tag/respawn/rejection outcomes are player-specific and go only to that
 * player's room (HUB-093: `player:<playerId>`).
 */
import type { Server } from 'socket.io';
import type { ScanRejectReason } from '@foundry-ctf/shared';
import type { GameEngineEvents } from '../engine/GameEngine.js';

export function createSocketIoGameEvents(io: Server): GameEngineEvents {
  return {
    captureStarted: (e) => io.emit('capture:started', e),
    captureProgress: (e) => io.emit('capture:progress', e),
    captureCompleted: (e) => io.emit('capture:completed', e),
    captureAbandoned: (e) => io.emit('capture:abandoned', e),
    tagInflicted: (playerId, e) => io.to(`player:${playerId}`).emit('tag:inflicted', e),
    tagReceived: (playerId, e) => io.to(`player:${playerId}`).emit('tag:received', e),
    respawnCompleted: (playerId, e) => io.to(`player:${playerId}`).emit('respawn:completed', e),
    scanRejected: (playerId: string, raw: string, reason: ScanRejectReason) =>
      io.to(`player:${playerId}`).emit('scan:rejected', { raw, reason }),
    sessionStarted: (sessionId) => io.emit('session:started', { sessionId }),
    sessionEnded: (sessionId, winningTeamId) => io.emit('session:ended', { sessionId, winningTeamId }),
  };
}
