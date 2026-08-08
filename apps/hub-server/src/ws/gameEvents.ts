/**
 * Adapts GameEngine's transport-agnostic event sink onto socket.io broadcasts (doc01 §6.2).
 * Session-level events go to everyone (control point state, scores — visible to spectators
 * too); tag/respawn/rejection/capture-in-progress outcomes are player-specific and go only
 * to that player's room (HUB-093: `player:<playerId>`) — capture:started/progress are only
 * ever relevant to the player doing the capturing, so bystanders never see their bar.
 */
import type { Server } from 'socket.io';
import type { ScanRejectReason } from '@foundry-ctf/shared';
import type { GameEngineEvents } from '../engine/GameEngine.js';

export function createSocketIoGameEvents(io: Server): GameEngineEvents {
  return {
    captureStarted: (e) => {
      io.to(`player:${e.playerId}`).emit('capture:started', e);
      // Spectator twin (mirrors tagOccurred): the scoreboard ticker needs to know a capture
      // began, but must not get the progress stream or a ring of its own.
      io.to('spectators').emit('capture:occurred', {
        captureId: e.captureId,
        controlPointId: e.controlPointId,
        playerId: e.playerId,
      });
    },
    captureProgress: (e) => io.to(`player:${e.playerId}`).emit('capture:progress', e),
    captureCompleted: (e) => io.emit('capture:completed', e),
    captureCompletedForPlayer: (playerId, e) => io.to(`player:${playerId}`).emit('capture:completedOwn', e),
    captureAbandoned: (e) => io.emit('capture:abandoned', e),
    tagInflicted: (playerId, e) => io.to(`player:${playerId}`).emit('tag:inflicted', e),
    tagReceived: (playerId, e) => io.to(`player:${playerId}`).emit('tag:received', e),
    tagOccurred: (e) => io.to('spectators').emit('tag:occurred', e),
    respawnCompleted: (playerId, e) => io.to(`player:${playerId}`).emit('respawn:completed', e),
    scanRejected: (playerId: string, raw: string, reason: ScanRejectReason) =>
      io.to(`player:${playerId}`).emit('scan:rejected', { raw, reason }),
    sessionStarted: (sessionId) => io.emit('session:started', { sessionId }),
    sessionEnded: (sessionId, winningTeamId) => io.emit('session:ended', { sessionId, winningTeamId }),
  };
}
