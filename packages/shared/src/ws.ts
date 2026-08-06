/**
 * WebSocket contract, doc01 §6. Client<->Server event payload types + zod schemas for
 * every inbound (client->server) event (HUB-190).
 */
import { z } from 'zod';
import type {
  AbandonReason,
  QrCtfControlPoint,
  QrCtfPlayer,
  QrCtfSession,
  QrCtfTeam,
} from './ontology.js';

export type ClientRole = 'player' | 'admin' | 'spectator';

// ---- Client -> Server ----

export const SessionHelloSchema = z.object({
  playerId: z.string().optional(),
  playerSecret: z.string().optional(),
  role: z.enum(['player', 'admin', 'spectator']),
  adminPin: z.string().optional(),
});
export type SessionHello = z.infer<typeof SessionHelloSchema>;

export const ScanSchema = z.object({
  raw: z.string(),
  lat: z.number().optional(),
  long: z.number().optional(),
  accuracyM: z.number().optional(),
  clientTs: z.number(),
});
export type ScanPayload = z.infer<typeof ScanSchema>;

export const LocationSchema = z.object({
  lat: z.number(),
  long: z.number(),
  accuracyM: z.number(),
  clientTs: z.number(),
});
export type LocationPayload = z.infer<typeof LocationSchema>;

export const CaptureCancelSchema = z.object({
  captureId: z.string(),
});
export type CaptureCancelPayload = z.infer<typeof CaptureCancelSchema>;

export const PlayerUpdateSchema = z.object({
  playerName: z.string().min(1).max(40).optional(),
  teamId: z.string().optional(),
  profilePicture: z.string().optional(), // base64 or data-url, downscaled client-side (HUB-171)
});
export type PlayerUpdatePayload = z.infer<typeof PlayerUpdateSchema>;

// ---- Server -> Client ----

export interface StateSnapshot {
  teams: QrCtfTeam[];
  controlPoints: QrCtfControlPoint[];
  ownPlayer?: QrCtfPlayer;
  session: QrCtfSession | null;
}

export interface StatePatch {
  type: string;
  id: string;
  patch: unknown;
}

export interface CaptureStartedEvent {
  captureId: string;
  controlPointId: string;
  durationMs: number;
  startedAtMs: number;
}

export interface CaptureProgressEvent {
  captureId: string;
  progress: number; // 0..1
  isHumanDetected: boolean;
}

export interface CaptureCompletedEvent {
  captureId: string;
  controlPointId: string;
  teamId: string;
}

export interface CaptureAbandonedEvent {
  captureId: string;
  abandonReason: AbandonReason;
}

export interface TagEvent {
  tagId: string;
  otherPlayerId: string;
}

export interface RespawnCompletedEvent {
  respawnId: string;
}

export interface ScanRejectedEvent {
  raw: string;
  reason: string;
}

export interface SessionStartedEvent {
  sessionId: string;
}
export interface SessionEndedEvent {
  sessionId: string;
  winningTeamId: string | null;
}

/** doc01 HUB-101 rejection reasons — kept as a union so callers get exhaustiveness checks. */
export type ScanRejectReason =
  | 'no_session'
  | 'player_tagged_out'
  | 'node_offline'
  | 'no_presence_detected'
  | 'capture_in_progress'
  | 'already_capturing'
  | 'already_owned_by_your_team'
  | 'unknown_qr'
  | 'unrecognized_target'
  | 'tag_cooldown'
  | 'respawn_immunity'
  | 'same_team'
  | 'target_not_active'
  | 'source_not_active'
  | 'respawn_not_allowed_for_team';
