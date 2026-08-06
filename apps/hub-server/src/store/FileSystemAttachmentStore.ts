/** HUB-065..067: data/attachments/<ref>.<ext>, never base64-inlined into state.json. */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AttachmentStore } from './AttachmentStore.js';
import { AttachmentTooLargeError, MAX_ATTACHMENT_BYTES } from './AttachmentStore.js';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class FileSystemAttachmentStore implements AttachmentStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'attachments');
  }

  async put(bytes: Uint8Array, mime: string): Promise<string> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(bytes.byteLength);
    await mkdir(this.dir, { recursive: true });
    const ext = EXT_BY_MIME[mime] ?? 'bin';
    const ref = randomUUID();
    await writeFile(join(this.dir, `${ref}.${ext}`), bytes);
    return `${ref}.${ext}`;
  }

  async getUrl(ref: string): Promise<string> {
    const path = join(this.dir, ref);
    await stat(path); // throws ENOENT if missing
    return `/attachments/${ref}`;
  }
}
