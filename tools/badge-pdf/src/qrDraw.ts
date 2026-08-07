import QRCode from 'qrcode';
import type { PdfPage } from './pdf.js';

const QUIET_ZONE_MODULES = 4;

/** Draws a QR code as vector-filled squares (row runs merged into single rects) into a
 * boxSize x boxSize square whose top-left corner is (boxX, boxTopY), in the page's
 * top-down coordinates. Vector fill prints crisp at any size, unlike an embedded raster. */
export function drawQr(page: PdfPage, payload: string, boxX: number, boxTopY: number, boxSize: number): void {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'H' });
  const size = qr.modules.size;
  const modulePt = boxSize / (size + QUIET_ZONE_MODULES * 2);

  for (let row = 0; row < size; row++) {
    let runStart = -1;
    for (let col = 0; col <= size; col++) {
      const dark = col < size && qr.modules.get(row, col) === 1;
      if (dark && runStart === -1) {
        runStart = col;
      } else if (!dark && runStart !== -1) {
        const x = boxX + (QUIET_ZONE_MODULES + runStart) * modulePt;
        const y = boxTopY + (QUIET_ZONE_MODULES + row) * modulePt;
        const width = (col - runStart) * modulePt;
        page.fillRect({ x, y, width, height: modulePt });
        runStart = -1;
      }
    }
  }
}
