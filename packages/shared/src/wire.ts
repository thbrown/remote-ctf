/**
 * Zod schemas for the Node<->Hub wire contract, doc00 §0.3/§0.4. Every inbound HTTP body
 * on nodeApp MUST be validated against these (HUB-190). Field shapes are copied verbatim
 * from the contract's request/response examples — this file is generated-by-hand from
 * doc00 and must be kept byte-for-byte in sync with it (see doc00's own edit rule).
 */
import { z } from 'zod';

export const LedPatternSchema = z.enum(['solid', 'pulse', 'flash']);

export const HexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'expected #RRGGBB');

export const MacAddressSchema = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/, 'expected AA:BB:CC:DD:EE:FF');

// POST /api/cp/register
export const CpRegisterRequestSchema = z.object({
  mac: MacAddressSchema,
  ip: z.string(),
  fw: z.string(),
});
export type CpRegisterRequest = z.infer<typeof CpRegisterRequestSchema>;

export interface CpRegisterResponse {
  claimed: boolean;
  controlPointId: string | null;
  hexColor: string;
  pattern: 'solid' | 'pulse' | 'flash';
  heartbeatIntervalMs: number;
}

// POST /api/cp/presence
export const CpPresenceRequestSchema = z.object({
  mac: MacAddressSchema,
  detected: z.boolean(),
});
export type CpPresenceRequest = z.infer<typeof CpPresenceRequestSchema>;

export interface CpPresenceResponse {
  hexColor: string;
  pattern: 'solid' | 'pulse' | 'flash';
}

// POST /api/cp/heartbeat
export const CpHeartbeatRequestSchema = z.object({
  mac: MacAddressSchema,
  ip: z.string(),
  detected: z.boolean(),
  hexColor: HexColorSchema,
});
export type CpHeartbeatRequest = z.infer<typeof CpHeartbeatRequestSchema>;

export interface CpHeartbeatResponse {
  claimed: boolean;
  controlPointId: string | null;
  hexColor: string;
  pattern: 'solid' | 'pulse' | 'flash';
  heartbeatIntervalMs: number;
}

// Hub -> Node: POST /set-color
export const SetColorRequestSchema = z.object({
  hexColor: HexColorSchema,
  pattern: LedPatternSchema,
});
export type SetColorRequest = z.infer<typeof SetColorRequestSchema>;

// Hub -> Node: GET /status response shape (diagnostics only, not validated inbound)
export interface NodeStatusResponse {
  mac: string;
  fw: string;
  hexColor: string;
  pattern: 'solid' | 'pulse' | 'flash';
  detected: boolean;
  uptimeMs: number;
  rssi: number;
}
