/**
 * Generates a respawn point sign PDF: one page per respawn location (r1..rN), each with a
 * single large QR code encoding the `rp` payload (CON-030..033) for that location. Print
 * one page per physical respawn point and post it there.
 *
 * These QR codes only resolve once a respawn location with the matching ID exists in the
 * Hub - open Admin -> Respawn Points and create one per sign, entering the same "Custom ID"
 * (r1, r2, ...) printed on the sign (any lat/long works, the QR is what's scanned in play).
 *
 * Usage: pnpm --filter @foundry-ctf/badge-pdf generate:respawns [respawnCount]
 * (defaults to 6)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeRpQr } from '@foundry-ctf/shared';
import { PdfDocument } from './pdf.js';
import { drawQr } from './qrDraw.js';

const RESPAWN_COUNT = Number(process.argv[2]) || 6;
const OUT_PATH = path.resolve(import.meta.dirname, '../../../ops/printables/respawn-points.pdf');

const PAGE_WIDTH = 612; // 8.5in @ 72pt/in
const PAGE_HEIGHT = 792; // 11in @ 72pt/in
const PAGE_MARGIN = 24;
const QR_SIZE = 480;

function centeredX(boxWidth: number): number {
  return (PAGE_WIDTH - boxWidth) / 2;
}

async function main(): Promise<void> {
  await mkdir(path.dirname(OUT_PATH), { recursive: true });

  const doc = new PdfDocument();

  for (let i = 1; i <= RESPAWN_COUNT; i++) {
    const respawnId = `r${i}`;
    const payload = encodeRpQr(respawnId);
    const page = doc.addPage(PAGE_WIDTH, PAGE_HEIGHT);
    let y = PAGE_MARGIN;

    page.centeredText(`Respawn ${respawnId}`, PAGE_MARGIN, y, 'Helvetica-Bold', 28);
    y += 34 + 14;

    page.centeredText('RESPAWN POINT', PAGE_MARGIN, y, 'Helvetica', 12);
    y += 16 + 16;

    drawQr(page, payload, centeredX(QR_SIZE), y, QR_SIZE);
    y += QR_SIZE + 20;

    page.centeredText(`CUSTOM ID: ${respawnId}`, PAGE_MARGIN, y, 'Helvetica-Bold', 14);
    y += 18 + 4;
    page.centeredText('Admin -> Respawn Points -> enter this as the Custom ID', PAGE_MARGIN, y, 'Helvetica', 10);
  }

  await writeFile(OUT_PATH, doc.build());
  console.log(`Wrote ${OUT_PATH} (${RESPAWN_COUNT} respawn points)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
