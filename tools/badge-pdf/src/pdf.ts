/**
 * Tiny dependency-free PDF writer: just enough to emit letter-size pages containing
 * centered Helvetica text and solid black rectangles (used here to render QR modules as
 * vector fills, so codes stay crisp at any print size). Not a general-purpose PDF library -
 * built for this one badge sheet so we don't need network access to pull in a PDF package.
 */

// Standard Helvetica / Helvetica-Bold AFM advance widths (per 1000 em), for the character
// set this document actually uses. Used only to center short labels - approximate widths
// for any character outside this map are fine since nothing here needs pixel-perfect kerning.
const HELVETICA_WIDTHS: Record<string, number> = {
  ' ': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556,
  M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
  m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
};
const HELVETICA_BOLD_WIDTHS: Record<string, number> = {
  ' ': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611,
  M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278,
  m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
};

export type FontName = 'Helvetica' | 'Helvetica-Bold';

export function textWidth(text: string, font: FontName, size: number): number {
  const widths = font === 'Helvetica-Bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const ch of text) units += widths[ch] ?? 556;
  return (units / 1000) * size;
}

function escapePdfString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export interface Rect {
  /** top-down page coordinates: x/y measured from the top-left corner */
  x: number;
  y: number;
  width: number;
  height: number;
}

export class PdfPage {
  private ops: string[] = [];
  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {}

  private toPdfY(topY: number, height: number): number {
    return this.height - topY - height;
  }

  fillRect(rect: Rect): void {
    const pdfY = this.toPdfY(rect.y, rect.height);
    this.ops.push(`${rect.x.toFixed(2)} ${pdfY.toFixed(2)} ${rect.width.toFixed(2)} ${rect.height.toFixed(2)} re f`);
  }

  /** Draws text with its top-left baseline box starting at (x, topY), i.e. topY is where the
   * cap-height of the glyphs effectively begins - matches how the caller lays pages out top-down. */
  text(str: string, x: number, topY: number, font: FontName, size: number): void {
    const fontKey = font === 'Helvetica-Bold' ? 'F2' : 'F1';
    const baselineY = this.height - topY - size * 0.8;
    this.ops.push('BT');
    this.ops.push(`/${fontKey} ${size} Tf`);
    this.ops.push(`${x.toFixed(2)} ${baselineY.toFixed(2)} Td`);
    this.ops.push(`(${escapePdfString(str)}) Tj`);
    this.ops.push('ET');
  }

  centeredText(str: string, pageMarginX: number, topY: number, font: FontName, size: number): void {
    const usableWidth = this.width - pageMarginX * 2;
    const w = textWidth(str, font, size);
    const x = pageMarginX + (usableWidth - w) / 2;
    this.text(str, x, topY, font, size);
  }

  toContentStream(): string {
    return this.ops.join('\n');
  }
}

export class PdfDocument {
  private pages: PdfPage[] = [];

  addPage(width: number, height: number): PdfPage {
    const page = new PdfPage(width, height);
    this.pages.push(page);
    return page;
  }

  /** Serializes all pages into a complete PDF file (uncompressed streams - simple and
   * plenty small for vector-only content at this page count). */
  build(): Buffer {
    // Object 1 = Catalog, 2 = Pages, 3 = Helvetica, 4 = Helvetica-Bold, then a
    // (page dict, content stream) pair per page.
    const catalogId = 1;
    const pagesId = 2;
    const fontRegId = 3;
    const fontBoldId = 4;
    let nextId = 5;

    const byId = new Map<number, string>();
    const pageIds: number[] = [];
    for (const page of this.pages) {
      const pageId = nextId++;
      const contentId = nextId++;
      pageIds.push(pageId);
      const content = page.toContentStream();
      byId.set(
        pageId,
        `${pageId} 0 obj\n<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
          `/Resources << /Font << /F1 ${fontRegId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
      );
      byId.set(
        contentId,
        `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream\nendobj\n`,
      );
    }

    byId.set(catalogId, `${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`);
    byId.set(
      pagesId,
      `${pagesId} 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>\nendobj\n`,
    );
    byId.set(
      fontRegId,
      `${fontRegId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
    );
    byId.set(
      fontBoldId,
      `${fontBoldId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`,
    );

    const totalObjs = nextId - 1;
    const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    let out = header;
    const offsets: number[] = new Array(totalObjs + 1).fill(0);
    for (let id = 1; id <= totalObjs; id++) {
      offsets[id] = Buffer.byteLength(out, 'binary');
      out += byId.get(id);
    }
    const xrefStart = Buffer.byteLength(out, 'binary');
    out += `xref\n0 ${totalObjs + 1}\n`;
    out += '0000000000 65535 f \n';
    for (let id = 1; id <= totalObjs; id++) {
      out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${totalObjs + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    return Buffer.from(out, 'binary');
  }
}
