/**
 * Generates a player badge PDF: one page per player (p1..pN), each page holding one FRONT
 * badge, one BACK badge, and two smaller ARM PATCH badges - all four encoding the same `pl`
 * QR payload (CON-030..033) for that player, sized as large as reasonably fits on a single
 * 8.5x11 page. QR codes are drawn as vector fills (not raster images) so they print crisp
 * at any size.
 *
 * Usage: pnpm --filter @foundry-ctf/badge-pdf generate:players [playerCount]
 * (defaults to 12; pass e.g. `20` for a bigger game)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodePlQr } from '@foundry-ctf/shared';
import { PdfDocument } from './pdf.js';
import { drawQr } from './qrDraw.js';

const PLAYER_COUNT = Number(process.argv[2]) || 12;
const OUT_PATH = path.resolve(import.meta.dirname, '../../../ops/printables/player-badges.pdf');

const PAGE_WIDTH = 612; // 8.5in @ 72pt/in
const PAGE_HEIGHT = 792; // 11in @ 72pt/in
const PAGE_MARGIN = 24;
const QR_LARGE = 240; // front / back
const QR_SMALL = 120; // arm patches
const ARM_GAP = 40;

function centeredX(boxWidth: number): number {
  return (PAGE_WIDTH - boxWidth) / 2;
}

async function main(): Promise<void> {
  await mkdir(path.dirname(OUT_PATH), { recursive: true });

  const doc = new PdfDocument();

  for (let i = 1; i <= PLAYER_COUNT; i++) {
    const playerId = `p${i}`;
    const payload = encodePlQr(playerId);
    const page = doc.addPage(PAGE_WIDTH, PAGE_HEIGHT);
    let y = PAGE_MARGIN;

    page.centeredText(`Player ${playerId}`, PAGE_MARGIN, y, 'Helvetica-Bold', 24);
    y += 30 + 12;

    // FRONT
    page.centeredText('FRONT', PAGE_MARGIN, y, 'Helvetica', 12);
    y += 16 + 4;
    drawQr(page, payload, centeredX(QR_LARGE), y, QR_LARGE);
    y += QR_LARGE + 16;

    // BACK
    page.centeredText('BACK', PAGE_MARGIN, y, 'Helvetica', 12);
    y += 16 + 4;
    drawQr(page, payload, centeredX(QR_LARGE), y, QR_LARGE);
    y += QR_LARGE + 16;

    // ARM PATCHES (x2)
    page.centeredText('ARM PATCHES', PAGE_MARGIN, y, 'Helvetica', 12);
    y += 16 + 4;
    const armRowWidth = QR_SMALL * 2 + ARM_GAP;
    const armStartX = centeredX(armRowWidth);
    drawQr(page, payload, armStartX, y, QR_SMALL);
    drawQr(page, payload, armStartX + QR_SMALL + ARM_GAP, y, QR_SMALL);
  }

  await writeFile(OUT_PATH, doc.build());
  console.log(`Wrote ${OUT_PATH} (${PLAYER_COUNT} players)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
