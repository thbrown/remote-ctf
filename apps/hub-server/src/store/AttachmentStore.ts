/**
 * doc01 §5.3 (HUB-065..067). profilePicture is accessed only via this interface because
 * filesystem mode stores a path while Foundry stores an attachment RID.
 */
import type { AttachmentRef } from '@foundry-ctf/shared';

export const MAX_ATTACHMENT_BYTES = 64 * 1024; // HUB-067
export const MAX_ATTACHMENT_DIMENSION = 128; // HUB-067

export interface AttachmentStore {
  put(bytes: Uint8Array, mime: string): Promise<AttachmentRef>;
  getUrl(ref: AttachmentRef): Promise<string>;
}

export class AttachmentTooLargeError extends Error {
  constructor(sizeBytes: number) {
    super(`attachment of ${sizeBytes} bytes exceeds MAX_ATTACHMENT_BYTES (${MAX_ATTACHMENT_BYTES})`);
    this.name = 'AttachmentTooLargeError';
  }
}
