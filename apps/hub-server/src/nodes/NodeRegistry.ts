/**
 * HUB-043: Hub-local table keyed by MAC. Deliberately NOT an ontology type (doc01 §4.2) —
 * ephemeral network plumbing that would be noise in Foundry. Not persisted to disk:
 * Nodes re-register on every boot and Wi-Fi reconnect (CON-010), so an empty registry on
 * Hub restart self-heals within one register call per Node.
 */
import type { ControlPointNodeRecord, LedPattern } from '@foundry-ctf/shared';

export class NodeRegistry {
  private readonly nodes = new Map<string, ControlPointNodeRecord>();

  constructor(private readonly heartbeatIntervalMs: number) {}

  /** CON-017: offline is a derived judgement, not a stored flag — avoids a sweep timer
   * drifting out of sync with what the API actually reports. */
  isOnline(record: ControlPointNodeRecord, nowMs = Date.now()): boolean {
    return nowMs - record.lastSeenMs < 3 * this.heartbeatIntervalMs;
  }

  upsertOnRegisterOrHeartbeat(
    mac: string,
    fields: Partial<Pick<ControlPointNodeRecord, 'ip' | 'fw' | 'reportedColor' | 'rssi'>>,
    nowMs = Date.now(),
  ): ControlPointNodeRecord {
    const existing = this.nodes.get(mac);
    const record: ControlPointNodeRecord = {
      mac,
      ip: fields.ip ?? existing?.ip ?? '',
      controlPointId: existing?.controlPointId ?? null,
      lastSeenMs: nowMs,
      isOnline: true, // superseded by isOnline() at read time; kept for interface parity
      fw: fields.fw ?? existing?.fw ?? '',
      desiredColor: existing?.desiredColor ?? '#202020',
      desiredPattern: existing?.desiredPattern ?? 'solid',
      reportedColor: fields.reportedColor ?? existing?.reportedColor ?? null,
      rssi: fields.rssi ?? existing?.rssi ?? null,
    };
    this.nodes.set(mac, record);
    return record;
  }

  setControlPointId(mac: string, controlPointId: string | null): void {
    const existing = this.nodes.get(mac);
    if (!existing) return;
    this.nodes.set(mac, { ...existing, controlPointId });
  }

  setDesired(mac: string, hexColor: string, pattern: LedPattern): void {
    const existing = this.nodes.get(mac);
    if (!existing) return;
    this.nodes.set(mac, { ...existing, desiredColor: hexColor, desiredPattern: pattern });
  }

  setReported(mac: string, hexColor: string | null): void {
    const existing = this.nodes.get(mac);
    if (!existing) return;
    this.nodes.set(mac, { ...existing, reportedColor: hexColor });
  }

  get(mac: string): ControlPointNodeRecord | null {
    return this.nodes.get(mac) ?? null;
  }

  list(): ControlPointNodeRecord[] {
    return [...this.nodes.values()];
  }

  delete(mac: string): void {
    this.nodes.delete(mac);
  }
}
