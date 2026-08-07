/**
 * doc01 §7 — capture FSM, tagging, respawn, scoring. This is the Hub's sole authority
 * over game outcomes (HUB-090); every mutation goes through `store`. Timing-sensitive
 * state (capture progress, tag cooldowns, respawn immunity, cumulative hold-seconds for
 * scoring) is deliberately kept in engine memory rather than the ontology, computed from
 * the injected monotonic `clock` — never wall clock (HUB-062) — and reset at session
 * start. It survives a Hub restart only via HUB-016 (abandon everything, don't resume).
 */
import { randomUUID } from 'node:crypto';
import type {
  AbandonReason,
  LedPattern,
  QrCtfCapture,
  QrCtfControlPoint,
  QrCtfPlayer,
  QrCtfSession,
} from '@foundry-ctf/shared';
import { isQrParseError, parseQr } from '@foundry-ctf/shared';
import type {
  CaptureAbandonedEvent,
  CaptureCompletedEvent,
  CaptureStartedEvent,
  RespawnCompletedEvent,
  ScanRejectReason,
  TagEvent,
  TagOccurredEvent,
} from '@foundry-ctf/shared';
import type { GameStateStore } from '../store/GameStateStore.js';
import type { Clock } from './Clock.js';

export interface GameEngineEvents {
  captureStarted(e: CaptureStartedEvent): void;
  captureProgress(e: { captureId: string; progress: number; isHumanDetected: boolean }): void;
  captureCompleted(e: CaptureCompletedEvent): void;
  /** Same completion, but delivered only to the player who did the capturing - for
   * personal feedback (haptics/sound) that shouldn't fire for every player whenever
   * anyone anywhere completes a capture, which is what captureCompleted's broadcast is
   * for (control point state visible to everyone, including spectators). */
  captureCompletedForPlayer(playerId: string, e: CaptureCompletedEvent): void;
  captureAbandoned(e: CaptureAbandonedEvent): void;
  tagInflicted(sourcePlayerId: string, e: TagEvent): void;
  tagReceived(targetPlayerId: string, e: TagEvent): void;
  /** Public, spectator-room broadcast - see TagOccurredEvent's doc comment. */
  tagOccurred(e: TagOccurredEvent): void;
  respawnCompleted(playerId: string, e: RespawnCompletedEvent): void;
  scanRejected(playerId: string, raw: string, reason: ScanRejectReason): void;
  sessionStarted(sessionId: string): void;
  sessionEnded(sessionId: string, winningTeamId: string | null): void;
}

export interface GameEngineDeps {
  store: GameStateStore;
  clock: Clock;
  /** Wall-clock ISO timestamp for recorded events — separate from the monotonic clock
   * above so tests can hold it fixed without freezing duration math (HUB-062). */
  wallClockIso: () => string;
  /** Push an authoritative color to a claimed Control Point's Node. Best-effort, may
   * silently no-op if the Node has never registered — correctness never depends on this
   * landing (CON-022). */
  dispatchColor: (macAddress: string, hexColor: string, pattern: LedPattern) => void;
  /** True if the Node behind this MAC has heartbeated within 3x its interval (CON-017). */
  isNodeOnline: (macAddress: string) => boolean;
  events: GameEngineEvents;
}

interface CaptureRuntime {
  controlPointId: string;
  playerId: string;
  startMonoMs: number;
  presenceLostSinceMonoMs: number | null;
}

export class GameEngine {
  private readonly store: GameStateStore;
  private readonly clock: Clock;
  private readonly wallClockIso: () => string;
  private readonly dispatchColor: GameEngineDeps['dispatchColor'];
  private readonly isNodeOnline: GameEngineDeps['isNodeOnline'];
  private readonly events: GameEngineEvents;

  private readonly captureRuntimeById = new Map<string, CaptureRuntime>();
  private readonly captureIdByControlPointId = new Map<string, string>();
  private readonly captureIdByPlayerId = new Map<string, string>();

  private readonly holdSecondsByTeam = new Map<string, number>();
  private readonly lastTagAtMonoMsByPair = new Map<string, number>();
  private readonly lastRespawnAtMonoMsByPlayer = new Map<string, number>();
  private readonly capturesCompletedCountByPlayer = new Map<string, number>();
  private readonly tagsInflictedCountByPlayer = new Map<string, number>();
  private readonly tagsReceivedCountByPlayer = new Map<string, number>();

  private unsubscribeStore: (() => void) | null = null;

  constructor(deps: GameEngineDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.wallClockIso = deps.wallClockIso;
    this.dispatchColor = deps.dispatchColor;
    this.isNodeOnline = deps.isNodeOnline;
    this.events = deps.events;
  }

  /** Watch the store's change feed for presence transitions written by nodeApp's
   * /api/cp/presence handler (CON-013), independent of who wrote them. */
  start(): void {
    this.unsubscribeStore = this.store.subscribe((e) => {
      if (e.kind === 'updated' && e.type === 'qrCtfControlPoint') {
        const patch = e.patch as Partial<QrCtfControlPoint>;
        if ('isHumanDetected' in patch) {
          this.onPresenceChanged(e.id, patch.isHumanDetected === true);
        }
      }
    });
  }

  stop(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }

  private onPresenceChanged(controlPointId: string, detected: boolean): void {
    const captureId = this.captureIdByControlPointId.get(controlPointId);
    if (!captureId) return;
    const rt = this.captureRuntimeById.get(captureId);
    if (!rt) return;
    rt.presenceLostSinceMonoMs = detected ? null : this.clock.now();
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /** HUB-016 — on boot, if a session was left running, abandon it. No resume logic. */
  async handleHubRestart(): Promise<void> {
    const stations = await this.store.stations.list();
    for (const station of stations as any[]) {
      if (!station.currentSessionId) continue;
      await this.store.batch(async (tx) => {
        await tx.sessions.update(station.currentSessionId, { endTimestamp: this.wallClockIso() });
        const inProgress = await tx.captures.list({ captureStatus: 'in_progress' } as any);
        for (const capture of inProgress as QrCtfCapture[]) {
          await tx.captures.update(capture.captureId, {
            captureStatus: 'abandoned',
            abandonReason: 'hub_restart',
            completeTimestamp: this.wallClockIso(),
          });
        }
        const players = await tx.players.list({ stationId: station.stationId } as any);
        for (const player of players as QrCtfPlayer[]) {
          await tx.players.update(player.playerId, { playerStatus: 'active' });
        }
        const controlPoints = await tx.controlPoints.list({ stationId: station.stationId } as any);
        for (const cp of controlPoints as QrCtfControlPoint[]) {
          await tx.controlPoints.update(cp.controlPointId, {
            currentOwnerTeamId: null,
            capturingPlayerId: null,
            captureProgress: 0,
          });
          if (cp.macAddress) this.dispatchColor(cp.macAddress, station.neutralHexColor, 'solid');
        }
        await tx.stations.update(station.stationId, { currentSessionId: null });
      });
    }
    this.resetRuntimeState();
  }

  private resetRuntimeState(): void {
    this.captureRuntimeById.clear();
    this.captureIdByControlPointId.clear();
    this.captureIdByPlayerId.clear();
    this.holdSecondsByTeam.clear();
    this.lastTagAtMonoMsByPair.clear();
    this.lastRespawnAtMonoMsByPlayer.clear();
    this.capturesCompletedCountByPlayer.clear();
    this.tagsInflictedCountByPlayer.clear();
    this.tagsReceivedCountByPlayer.clear();
  }

  /** HUB-165. */
  async startSession(stationId: string, sessionName: string, activeTeamIds: string[]): Promise<QrCtfSession> {
    const station = await this.store.stations.get(stationId);
    if (!station) throw new Error(`station ${stationId} not found`);

    const session = await this.store.batch(async (tx) => {
      const session = await tx.sessions.create({
        sessionId: randomUUID(),
        sessionName,
        stationId,
        winningTeamId: null,
        startTimestamp: this.wallClockIso(),
        endTimestamp: null,
        captureDurationMs: (station as any).captureDurationMs, // HUB-048: snapshot once
      });
      await tx.stations.update(stationId, { currentSessionId: session.sessionId });

      for (const teamId of activeTeamIds) {
        const scoreSeriesId = await tx.series.createSeries({
          ownerType: 'qrCtfTeamSession',
          ownerId: `${session.sessionId}:${teamId}`,
          property: 'score',
          valueType: 'double',
        });
        await tx.teamSessions.create({
          teamSessionId: randomUUID(),
          sessionId: session.sessionId,
          teamId,
          scoreSeriesId,
          finalScore: null,
          totalTagsInflicted: 0,
          totalTagsReceived: 0,
        });
        await tx.teams.update(teamId, { score: 0, totalTagsInflicted: 0, totalTagsReceived: 0 });
      }

      const players = await tx.players.list({ stationId } as any);
      for (const player of players as QrCtfPlayer[]) {
        const [locationLatSeriesId, locationLongSeriesId, isAliveSeriesId, tagsInflictedSeriesId, tagsReceivedSeriesId, capturesCompletedSeriesId] =
          await Promise.all([
            tx.series.createSeries({ ownerType: 'qrCtfPlayerSession', ownerId: player.playerId, property: 'locationLat', valueType: 'double' }),
            tx.series.createSeries({ ownerType: 'qrCtfPlayerSession', ownerId: player.playerId, property: 'locationLong', valueType: 'double' }),
            tx.series.createSeries({ ownerType: 'qrCtfPlayerSession', ownerId: player.playerId, property: 'isAlive', valueType: 'boolean' }),
            tx.series.createSeries({ ownerType: 'qrCtfPlayerSession', ownerId: player.playerId, property: 'tagsInflicted', valueType: 'int' }),
            tx.series.createSeries({ ownerType: 'qrCtfPlayerSession', ownerId: player.playerId, property: 'tagsReceived', valueType: 'int' }),
            tx.series.createSeries({ ownerType: 'qrCtfPlayerSession', ownerId: player.playerId, property: 'capturesCompleted', valueType: 'int' }),
          ]);
        await tx.playerSessions.create({
          playerSessionId: randomUUID(),
          sessionId: session.sessionId,
          playerId: player.playerId,
          teamId: player.teamId,
          locationLatSeriesId,
          locationLongSeriesId,
          isAliveSeriesId,
          tagsInflictedSeriesId,
          tagsReceivedSeriesId,
          capturesCompletedSeriesId,
        });
        await tx.players.update(player.playerId, { playerStatus: 'active', sessionId: session.sessionId });
      }

      const controlPoints = await tx.controlPoints.list({ stationId } as any);
      for (const cp of controlPoints as QrCtfControlPoint[]) {
        const [ownerHistorySeriesId, isHumanDetectedHistorySeriesId] = await Promise.all([
          tx.series.createSeries({ ownerType: 'qrCtfControlPointSession', ownerId: cp.controlPointId, property: 'currentOwnerTeamId', valueType: 'string' }),
          tx.series.createSeries({ ownerType: 'qrCtfControlPointSession', ownerId: cp.controlPointId, property: 'isHumanDetected', valueType: 'boolean' }),
        ]);
        await tx.controlPointSessions.create({
          controlPointSessionId: randomUUID(),
          sessionId: session.sessionId,
          controlPointId: cp.controlPointId,
          ownerHistorySeriesId,
          isHumanDetectedHistorySeriesId,
        });
        await tx.controlPoints.update(cp.controlPointId, {
          currentOwnerTeamId: null,
          capturingPlayerId: null,
          captureProgress: 0,
        });
        if (cp.macAddress) this.dispatchColor(cp.macAddress, station.neutralHexColor, 'solid');
      }

      return session;
    });

    this.resetRuntimeState();
    this.events.sessionStarted(session.sessionId);
    return session;
  }

  /** HUB-108 (session_ended) + HUB-133. */
  async endSession(stationId: string): Promise<void> {
    const station = await this.store.stations.get(stationId);
    if (!station || !(station as any).currentSessionId) return;
    const sessionId = (station as any).currentSessionId as string;

    for (const captureId of [...this.captureRuntimeById.keys()]) {
      await this.abandonCapture(captureId, 'session_ended');
    }

    const teamSessions = await this.store.teamSessions.list({ sessionId } as any);
    let winningTeamId: string | null = null;
    let bestScore = -1;
    for (const ts of teamSessions as any[]) {
      const team = await this.store.teams.get(ts.teamId);
      const score = team?.score ?? 0;
      await this.store.teamSessions.update(ts.teamSessionId, {
        finalScore: score,
        totalTagsInflicted: team?.totalTagsInflicted ?? 0,
        totalTagsReceived: team?.totalTagsReceived ?? 0,
      });
      if (score > bestScore) {
        bestScore = score;
        winningTeamId = ts.teamId;
      }
    }

    await this.store.sessions.update(sessionId, { endTimestamp: this.wallClockIso(), winningTeamId });
    await this.store.stations.update(stationId, { currentSessionId: null });

    // Mirrors handleHubRestart's reset above: a tagged-out badge is meaningless once
    // there's no session, and nothing else ever clears it back to active.
    const players = await this.store.players.list({ stationId } as any);
    for (const player of players as QrCtfPlayer[]) {
      await this.store.players.update(player.playerId, { playerStatus: 'active' });
    }

    this.events.sessionEnded(sessionId, winningTeamId);
  }

  // ---------------------------------------------------------------------------
  // Scan dispatch (HUB-090: server classifies, clients never do)
  // ---------------------------------------------------------------------------

  async handleScan(playerId: string, raw: string): Promise<void> {
    const parsed = parseQr(raw);
    if (isQrParseError(parsed)) {
      this.events.scanRejected(playerId, raw, 'unknown_qr');
      return;
    }
    switch (parsed.kind) {
      case 'cp':
        return this.attemptCapture(playerId, raw, parsed.macAddress);
      case 'pl':
        return this.attemptTag(playerId, raw, parsed.qrCodeToken);
      case 'rp':
        return this.attemptRespawn(playerId, raw, parsed.respawnLocationId);
    }
  }

  private reject(playerId: string, raw: string, reason: ScanRejectReason): void {
    this.events.scanRejected(playerId, raw, reason);
  }

  private async getRunningSession(player: QrCtfPlayer): Promise<QrCtfSession | null> {
    const station = await this.store.stations.get(player.stationId);
    const sessionId = (station as any)?.currentSessionId;
    if (!sessionId) return null;
    return this.store.sessions.get(sessionId);
  }

  // ---- Capture (HUB-100..108) ----

  async attemptCapture(playerId: string, raw: string, macAddress: string): Promise<void> {
    const player = await this.store.players.get(playerId);
    if (!player) return this.reject(playerId, raw, 'unrecognized_target');

    const session = await this.getRunningSession(player);
    if (!session) return this.reject(playerId, raw, 'no_session');
    if (player.playerStatus !== 'active') return this.reject(playerId, raw, 'player_tagged_out');

    const cps = await this.store.controlPoints.list({ macAddress } as any);
    const cp = cps[0] as QrCtfControlPoint | undefined;
    if (!cp || !this.isNodeOnline(macAddress)) return this.reject(playerId, raw, 'node_offline');
    if (!cp.isHumanDetected) return this.reject(playerId, raw, 'no_presence_detected');
    if (this.captureIdByControlPointId.has(cp.controlPointId)) return this.reject(playerId, raw, 'capture_in_progress');
    if (this.captureIdByPlayerId.has(playerId)) return this.reject(playerId, raw, 'already_capturing');
    if (cp.currentOwnerTeamId === player.teamId) return this.reject(playerId, raw, 'already_owned_by_your_team');

    const capture = await this.store.captures.create({
      captureId: randomUUID(),
      sessionId: session.sessionId,
      playerId,
      capturingTeamId: player.teamId as string,
      controlPointId: cp.controlPointId,
      startTimestamp: this.wallClockIso(),
      completeTimestamp: null,
      captureStatus: 'in_progress',
      abandonReason: null,
    });
    await this.store.controlPoints.update(cp.controlPointId, { capturingPlayerId: playerId, captureProgress: 0 });

    this.captureRuntimeById.set(capture.captureId, {
      controlPointId: cp.controlPointId,
      playerId,
      startMonoMs: this.clock.now(),
      presenceLostSinceMonoMs: null,
    });
    this.captureIdByControlPointId.set(cp.controlPointId, capture.captureId);
    this.captureIdByPlayerId.set(playerId, capture.captureId);

    if (cp.macAddress) this.dispatchColor(cp.macAddress, await this.ownerColor(cp.currentOwnerTeamId, player.stationId), 'pulse');

    this.events.captureStarted({
      captureId: capture.captureId,
      controlPointId: cp.controlPointId,
      playerId,
      durationMs: session.captureDurationMs,
      startedAtMs: this.clock.now(),
    });
  }

  private async ownerColor(ownerTeamId: string | null, stationId: string): Promise<string> {
    if (!ownerTeamId) {
      const station = await this.store.stations.get(stationId);
      return (station as any)?.neutralHexColor ?? '#FFFFFF';
    }
    const team = await this.store.teams.get(ownerTeamId);
    return team?.hexColor ?? '#FFFFFF';
  }

  /** Called at 5 Hz by the caller (doc01 HUB-103); advances progress, checks completion
   * and abandon conditions for every in-progress capture. */
  async tickCaptures(stationId: string): Promise<void> {
    const station = await this.store.stations.get(stationId);
    if (!station) return;
    const presenceGraceMs = (station as any).presenceGraceMs as number;

    for (const [captureId, rt] of [...this.captureRuntimeById.entries()]) {
      const capture = await this.store.captures.get(captureId);
      const session = capture ? await this.store.sessions.get(capture.sessionId) : null;
      if (!capture || !session) {
        this.captureRuntimeById.delete(captureId);
        continue;
      }

      const cp = await this.store.controlPoints.get(rt.controlPointId);
      if (cp?.macAddress && !this.isNodeOnline(cp.macAddress)) {
        await this.abandonCapture(captureId, 'node_offline');
        continue;
      }

      if (rt.presenceLostSinceMonoMs !== null && this.clock.now() - rt.presenceLostSinceMonoMs >= presenceGraceMs) {
        await this.abandonCapture(captureId, 'presence_lost');
        continue;
      }

      const elapsed = this.clock.now() - rt.startMonoMs;
      const progress = Math.min(1, elapsed / session.captureDurationMs);
      await this.store.controlPoints.update(rt.controlPointId, { captureProgress: progress });
      this.events.captureProgress({ captureId, progress, isHumanDetected: cp?.isHumanDetected ?? false });

      if (progress >= 1) {
        await this.completeCapture(captureId);
      }
    }
  }

  private async completeCapture(captureId: string): Promise<void> {
    const capture = await this.store.captures.get(captureId);
    const rt = this.captureRuntimeById.get(captureId);
    if (!capture || !rt) return;

    await this.store.captures.update(captureId, {
      captureStatus: 'complete',
      completeTimestamp: this.wallClockIso(),
    });

    const cp = await this.store.controlPoints.get(rt.controlPointId);
    await this.store.controlPoints.update(rt.controlPointId, {
      currentOwnerTeamId: capture.capturingTeamId,
      capturingPlayerId: null,
      captureProgress: 0,
    });

    const cpSessions = await this.store.controlPointSessions.list({ sessionId: capture.sessionId, controlPointId: rt.controlPointId } as any);
    if (cpSessions[0]) {
      await this.store.series.append((cpSessions[0] as any).ownerHistorySeriesId, {
        t: Date.now(),
        v: capture.capturingTeamId,
      });
    }

    const playerSessions = await this.store.playerSessions.list({ sessionId: capture.sessionId, playerId: rt.playerId } as any);
    if (playerSessions[0]) {
      const prevCount = this.capturesCompletedCountByPlayer.get(rt.playerId) ?? 0;
      const nextCount = prevCount + 1;
      this.capturesCompletedCountByPlayer.set(rt.playerId, nextCount);
      await this.store.series.append((playerSessions[0] as any).capturesCompletedSeriesId, { t: Date.now(), v: nextCount });
    }

    if (cp?.macAddress) {
      const team = await this.store.teams.get(capture.capturingTeamId);
      this.dispatchColor(cp.macAddress, team?.hexColor ?? '#FFFFFF', 'flash'); // Node auto-returns to solid (CON-020)
    }

    this.captureRuntimeById.delete(captureId);
    this.captureIdByControlPointId.delete(rt.controlPointId);
    this.captureIdByPlayerId.delete(rt.playerId);

    const completedEvent = { captureId, controlPointId: rt.controlPointId, teamId: capture.capturingTeamId };
    this.events.captureCompleted(completedEvent);
    this.events.captureCompletedForPlayer(rt.playerId, completedEvent);
  }

  private async abandonCapture(captureId: string, reason: AbandonReason): Promise<void> {
    const capture = await this.store.captures.get(captureId);
    const rt = this.captureRuntimeById.get(captureId);
    if (!capture || !rt) return;

    await this.store.captures.update(captureId, {
      captureStatus: 'abandoned',
      abandonReason: reason,
      completeTimestamp: this.wallClockIso(),
    });

    const cp = await this.store.controlPoints.get(rt.controlPointId);
    await this.store.controlPoints.update(rt.controlPointId, { capturingPlayerId: null, captureProgress: 0 });

    if (cp?.macAddress) {
      const color = await this.ownerColor(cp.currentOwnerTeamId, cp.stationId);
      this.dispatchColor(cp.macAddress, color, 'solid');
    }

    this.captureRuntimeById.delete(captureId);
    this.captureIdByControlPointId.delete(rt.controlPointId);
    this.captureIdByPlayerId.delete(rt.playerId);

    this.events.captureAbandoned({ captureId, abandonReason: reason });
  }

  /** Client-initiated cancel (HUB-107's sibling: voluntary, not a tag). */
  async cancelCapture(playerId: string, captureId: string): Promise<void> {
    const activeCaptureId = this.captureIdByPlayerId.get(playerId);
    if (activeCaptureId !== captureId) return;
    await this.abandonCapture(captureId, 'player_cancelled');
  }

  // ---- Tagging (HUB-110..113) ----

  async attemptTag(sourcePlayerId: string, raw: string, targetQrCodeToken: string): Promise<void> {
    const source = await this.store.players.get(sourcePlayerId);
    if (!source) return;

    const targets = await this.store.players.list({ qrCodeToken: targetQrCodeToken } as any);
    const target = targets[0] as QrCtfPlayer | undefined;
    if (!target) return this.reject(sourcePlayerId, raw, 'unrecognized_target');

    const session = await this.getRunningSession(source);
    if (!session) return this.reject(sourcePlayerId, raw, 'no_session');
    if (source.playerStatus !== 'active') return this.reject(sourcePlayerId, raw, 'source_not_active');
    if (target.playerStatus !== 'active') return this.reject(sourcePlayerId, raw, 'target_not_active');
    if (source.teamId === target.teamId) return this.reject(sourcePlayerId, raw, 'same_team');
    if (this.captureIdByPlayerId.has(sourcePlayerId)) return this.reject(sourcePlayerId, raw, 'already_capturing'); // HUB-112

    const station = await this.store.stations.get(source.stationId);
    const tagCooldownMs = (station as any)?.tagCooldownMs ?? 10000;
    const respawnImmunityMs = (station as any)?.respawnImmunityMs ?? 5000;

    const pairKey = `${sourcePlayerId}|${target.playerId}`;
    const lastTagAt = this.lastTagAtMonoMsByPair.get(pairKey);
    if (lastTagAt !== undefined && this.clock.now() - lastTagAt < tagCooldownMs) {
      return this.reject(sourcePlayerId, raw, 'tag_cooldown');
    }

    const lastRespawnAt = this.lastRespawnAtMonoMsByPlayer.get(target.playerId);
    if (lastRespawnAt !== undefined && this.clock.now() - lastRespawnAt < respawnImmunityMs) {
      return this.reject(sourcePlayerId, raw, 'respawn_immunity');
    }

    const tag = await this.store.tags.create({
      tagId: randomUUID(),
      sessionId: session.sessionId,
      sourcePlayerId,
      targetPlayerId: target.playerId,
      sourceTeamId: source.teamId as string,
      targetTeamId: target.teamId as string,
      locationLat: source.locationLat,
      locationLong: source.locationLong,
      tagTimestamp: this.wallClockIso(),
    });

    await this.store.players.update(target.playerId, { playerStatus: 'tagged_out' });
    this.lastTagAtMonoMsByPair.set(pairKey, this.clock.now());

    await this.bumpTeamTagCounters(source.teamId as string, target.teamId as string, session.sessionId);
    await this.appendPlayerTagSeries(sourcePlayerId, target.playerId, session.sessionId);

    this.events.tagInflicted(sourcePlayerId, { tagId: tag.tagId, otherPlayerId: target.playerId });
    this.events.tagReceived(target.playerId, { tagId: tag.tagId, otherPlayerId: sourcePlayerId });
    this.events.tagOccurred({
      tagId: tag.tagId,
      sourcePlayerId,
      targetPlayerId: target.playerId,
      sourceTeamId: source.teamId as string,
      targetTeamId: target.teamId as string,
    });

    // HUB-107: capturer tagged mid-attempt aborts their capture.
    const victimCaptureId = this.captureIdByPlayerId.get(target.playerId);
    if (victimCaptureId) await this.abandonCapture(victimCaptureId, 'player_tagged');
  }

  private async bumpTeamTagCounters(sourceTeamId: string, targetTeamId: string, sessionId: string): Promise<void> {
    const sourceTeam = await this.store.teams.get(sourceTeamId);
    if (sourceTeam) await this.store.teams.update(sourceTeamId, { totalTagsInflicted: sourceTeam.totalTagsInflicted + 1 });
    const targetTeam = await this.store.teams.get(targetTeamId);
    if (targetTeam) await this.store.teams.update(targetTeamId, { totalTagsReceived: targetTeam.totalTagsReceived + 1 });
  }

  /** Appends cumulative running totals (like capturesCompletedCountByPlayer), not raw
   * per-event deltas, so a stats reader can cheaply get a player's current total via
   * TimeSeriesStore.latest() instead of summing the whole series every read. */
  private async appendPlayerTagSeries(sourcePlayerId: string, targetPlayerId: string, sessionId: string): Promise<void> {
    const sourcePs = (await this.store.playerSessions.list({ sessionId, playerId: sourcePlayerId } as any))[0] as any;
    if (sourcePs) {
      const nextInflicted = (this.tagsInflictedCountByPlayer.get(sourcePlayerId) ?? 0) + 1;
      this.tagsInflictedCountByPlayer.set(sourcePlayerId, nextInflicted);
      await this.store.series.append(sourcePs.tagsInflictedSeriesId, { t: Date.now(), v: nextInflicted });
    }
    const targetPs = (await this.store.playerSessions.list({ sessionId, playerId: targetPlayerId } as any))[0] as any;
    if (targetPs) {
      const nextReceived = (this.tagsReceivedCountByPlayer.get(targetPlayerId) ?? 0) + 1;
      this.tagsReceivedCountByPlayer.set(targetPlayerId, nextReceived);
      await this.store.series.append(targetPs.tagsReceivedSeriesId, { t: Date.now(), v: nextReceived });
    }
  }

  // ---- Respawn (HUB-120..124) ----

  async attemptRespawn(playerId: string, raw: string, respawnLocationId: string): Promise<void> {
    const player = await this.store.players.get(playerId);
    if (!player) return;

    const session = await this.getRunningSession(player);
    if (!session) return this.reject(playerId, raw, 'no_session');
    if (player.playerStatus !== 'tagged_out') return this.reject(playerId, raw, 'not_tagged_out');

    const location = await this.store.respawnLocations.get(respawnLocationId);
    if (!location) return this.reject(playerId, raw, 'unrecognized_target');
    if (location.allowedTeamIds.length > 0 && !location.allowedTeamIds.includes(player.teamId as string)) {
      return this.reject(playerId, raw, 'respawn_not_allowed_for_team');
    }

    const respawn = await this.store.respawns.create({
      respawnId: randomUUID(),
      sessionId: session.sessionId,
      playerId,
      respawnLocationId,
      respawnTimestamp: this.wallClockIso(),
    });

    await this.store.players.update(playerId, { playerStatus: 'active' });
    this.lastRespawnAtMonoMsByPlayer.set(playerId, this.clock.now());

    const ps = (await this.store.playerSessions.list({ sessionId: session.sessionId, playerId } as any))[0] as any;
    if (ps) await this.store.series.append(ps.isAliveSeriesId, { t: Date.now(), v: true });

    this.events.respawnCompleted(playerId, { respawnId: respawn.respawnId });
  }

  // ---- Scoring (HUB-130..133) ----

  /** Called at 1 Hz by the caller for the currently running session, if any. */
  async tickScoring(stationId: string): Promise<void> {
    const station = await this.store.stations.get(stationId);
    const sessionId = (station as any)?.currentSessionId as string | undefined;
    if (!sessionId) return;

    const controlPoints = await this.store.controlPoints.list({ stationId } as any);
    for (const cp of controlPoints as QrCtfControlPoint[]) {
      if (!cp.currentOwnerTeamId) continue;
      const prev = this.holdSecondsByTeam.get(cp.currentOwnerTeamId) ?? 0;
      this.holdSecondsByTeam.set(cp.currentOwnerTeamId, prev + 1);
    }

    const teamSessions = await this.store.teamSessions.list({ sessionId } as any);
    const total = [...this.holdSecondsByTeam.values()].reduce((a, b) => a + b, 0);

    for (const ts of teamSessions as any[]) {
      const hold = this.holdSecondsByTeam.get(ts.teamId) ?? 0;
      const score = total > 0 ? hold / total : 0;
      await this.store.teams.update(ts.teamId, { score });
      await this.store.series.append(ts.scoreSeriesId, { t: Date.now(), v: score });
    }
  }
}
