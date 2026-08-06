/**
 * Mirrors the Foundry ontology (doc01 §4.1). This is the ONLY place ontology types are
 * defined (HUB-070) — game logic and the store layer import from here, never redefine
 * fields inline. When Lohi ships, adapt at the store boundary (HUB-071); these types
 * must never be replaced by generated Lohi types directly.
 */

export type EpochMs = number; // internal monotonic-anchored clock (HUB-062)
export type Iso8601 = string; // wall-clock, Foundry-facing timestamps
export type SeriesId = string;

/** Opaque reference into AttachmentStore — a filesystem path in dev, a Foundry RID later. */
export type AttachmentRef = string;

export type PlayerStatus = 'active' | 'tagged_out' | 'respawning';
export type CaptureStatus = 'in_progress' | 'complete' | 'abandoned';

export type AbandonReason =
  | 'presence_lost' // isHumanDetected false for > presenceGraceMs
  | 'player_tagged' // capturer was tagged mid-attempt (HUB-107)
  | 'player_cancelled' // capture:cancel from the client
  | 'session_ended' // admin stopped the session
  | 'node_offline' // Node missed 3 heartbeats mid-capture
  | 'hub_restart'; // HUB-016

export type LedPattern = 'solid' | 'pulse' | 'flash';

export interface QrCtfTeam {
  teamId: string;
  teamName: string;
  hexColor: string;
  score: number; // double 0..1
  totalTagsInflicted: number;
  totalTagsReceived: number;
}

export interface QrCtfStation {
  stationId: string;
  currentSessionId: string | null;
  stationName: string;
  captureDurationMs: number; // mutable admin setting (HUB-047)
  presenceGraceMs: number;
  tagCooldownMs: number;
  respawnImmunityMs: number;
  neutralHexColor: string;
}

export interface QrCtfControlPoint {
  controlPointId: string;
  controlPointName: string;
  stationId: string;
  currentOwnerTeamId: string | null;
  capturingPlayerId: string | null;
  captureProgress: number; // 0..1
  isHumanDetected: boolean;
  locationLat: number | null;
  locationLong: number | null;
  macAddress: string | null; // null while pre-staged (HUB-161), set once claimed
}

export interface QrCtfPlayer {
  playerId: string;
  playerName: string;
  stationId: string;
  sessionId: string | null;
  playerSessionId: string | null;
  teamId: string | null;
  qrCodeToken: string; // >=16 random chars (HUB-178)
  /** True once this player has claimed a physical badge via player:claimQr - until then
   * qrCodeToken is a placeholder nobody actually holds (see PlayerApp/ClaimBadgeScreen). */
  qrCodeClaimed: boolean;
  playerStatus: PlayerStatus;
  profilePicture: AttachmentRef | null;
  locationLat: number | null;
  locationLong: number | null;
  /** Hub-local only, never synced (doc01 §4.2 "deliberately not in the ontology"). Used to
   * resume identity from localStorage (HUB-151). Not part of the Foundry-mirrored shape,
   * but co-located here since it lives on the same record in every store impl. */
  playerSecret: string;
}

export interface QrCtfRespawnLocation {
  respawnLocationId: string;
  stationId: string;
  locationLat: number;
  locationLong: number;
  allowedTeamIds: string[]; // empty array = any team (HUB-120)
}

export interface QrCtfSession {
  sessionId: string;
  sessionName: string;
  stationId: string;
  winningTeamId: string | null;
  startTimestamp: Iso8601;
  endTimestamp: Iso8601 | null;
  captureDurationMs: number; // immutable snapshot (HUB-048)
}

export interface QrCtfPlayerSession {
  playerSessionId: string;
  sessionId: string;
  playerId: string;
  teamId: string | null;
  locationLatSeriesId: SeriesId;
  locationLongSeriesId: SeriesId;
  isAliveSeriesId: SeriesId;
  tagsInflictedSeriesId: SeriesId;
  tagsReceivedSeriesId: SeriesId;
  capturesCompletedSeriesId: SeriesId;
}

export interface QrCtfControlPointSession {
  controlPointSessionId: string;
  sessionId: string;
  controlPointId: string;
  ownerHistorySeriesId: SeriesId;
  isHumanDetectedHistorySeriesId: SeriesId;
}

export interface QrCtfTeamSession {
  teamSessionId: string;
  sessionId: string;
  teamId: string;
  scoreSeriesId: SeriesId;
  finalScore: number | null;
  totalTagsInflicted: number;
  totalTagsReceived: number;
}

export interface QrCtfTag {
  tagId: string;
  sessionId: string;
  sourcePlayerId: string;
  targetPlayerId: string;
  /** Denormalized team membership as-of-event (HUB-041). Never back-filled. */
  sourceTeamId: string;
  targetTeamId: string;
  locationLat: number | null;
  locationLong: number | null;
  tagTimestamp: Iso8601;
}

export interface QrCtfCapture {
  captureId: string;
  sessionId: string;
  playerId: string;
  capturingTeamId: string; // denormalized as-of-event (HUB-041)
  controlPointId: string;
  startTimestamp: Iso8601;
  completeTimestamp: Iso8601 | null;
  captureStatus: CaptureStatus;
  abandonReason: AbandonReason | null;
}

export interface QrCtfRespawn {
  respawnId: string;
  sessionId: string;
  playerId: string;
  respawnLocationId: string;
  respawnTimestamp: Iso8601;
}

export type OntologyTypeName =
  | 'qrCtfTeam'
  | 'qrCtfStation'
  | 'qrCtfControlPoint'
  | 'qrCtfPlayer'
  | 'qrCtfRespawnLocation'
  | 'qrCtfSession'
  | 'qrCtfPlayerSession'
  | 'qrCtfControlPointSession'
  | 'qrCtfTeamSession'
  | 'qrCtfTag'
  | 'qrCtfCapture'
  | 'qrCtfRespawn';

/** Hub-local Node registry (HUB-043). Deliberately NOT an ontology type — see doc01 §4.2. */
export interface ControlPointNodeRecord {
  mac: string;
  ip: string;
  controlPointId: string | null;
  lastSeenMs: EpochMs;
  isOnline: boolean;
  fw: string;
  desiredColor: string;
  desiredPattern: LedPattern;
  reportedColor: string | null;
  rssi: number | null;
}

/** doc01 §4.4 — HUB-044. Fixed; no team CRUD in the Admin UI (HUB-045). */
export const SEED_TEAMS: ReadonlyArray<Pick<QrCtfTeam, 'teamId' | 'teamName' | 'hexColor'>> = [
  { teamId: 'e9b2b516-6c79-4e30-8177-32de66a37f29', teamName: 'Blue Bandits', hexColor: '#3A48EA' },
  { teamId: '38c7ae2e-259d-42df-a13d-496dd7375dc8', teamName: 'Red Raiders', hexColor: '#EE2D2D' },
  { teamId: 'cfa98610-1b23-4979-a733-18ba106a6f41', teamName: 'Green Goblins', hexColor: '#00E301' },
  { teamId: '718a369c-cfce-4814-9bf5-e934125d90a8', teamName: 'Yellow Yaks', hexColor: '#FFFF00' },
  { teamId: '4f0cb7d5-5b11-4175-8a9c-4853f5fe2d2b', teamName: 'Cyan Cyclones', hexColor: '#00EAEA' },
  { teamId: '860d1e6b-57c1-4e7b-b234-1744c071e962', teamName: 'Pink Panthers', hexColor: '#EA76DD' },
  { teamId: '1949c46d-8759-4b66-9976-04ae17d9ee34', teamName: 'Grey Ghosts', hexColor: '#7D7D7D' },
  { teamId: 'a2e4f279-ad40-4424-9ab9-f7be0247bbbf', teamName: 'Orange Orcs', hexColor: '#F07D19' },
] as const;

/** doc01 HUB-046 — visually confusable color pairs on cheap WS2812 LEDs. */
export const CONFUSABLE_COLOR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['#FFFF00', '#00E301'], // Yellow Yaks / Green Goblins
  ['#3A48EA', '#00EAEA'], // Blue Bandits / Cyan Cyclones
] as const;
