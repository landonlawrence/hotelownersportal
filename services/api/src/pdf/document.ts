/**
 * Minimal branded PDF layout engine on pdf-lib (pure JS; runs in Lambda).
 * Provides a header band in the company's primary colour, paginated tables,
 * section headings, paragraphs, a "not for distribution" watermark for
 * unpublished content and a footer with the company's report footer and page numbers.
 */
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';

export interface Branding {
  portalName: string;
  companyName: string;
  primaryColor: string;
  accentColor: string;
  reportFooter: string | null;
}

export interface Column {
  header: string;
  width: number; // fraction of content width
  align?: 'left' | 'right';
}

export interface TableRow {
  cells: string[];
  style?: 'normal' | 'bold' | 'section' | 'muted';
}

const PAGE = { w: 612, h: 792, margin: 48 };

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** Standard PDF fonts are WinAnsi-only; map common typographic characters to safe equivalents. */
export function pdfSafe(text: string): string {
  return text
    .replace(/[−–]/g, '-')
    .replace(/—/g, '-')
    .replace(/[→]/g, '->')
    .replace(/[×]/g, 'x')
    .replace(/[÷]/g, '/')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[▲]/g, '+')
    .replace(/[▼]/g, '')
    // eslint-disable-next-line no-control-regex -- intentionally allows tab/newline in the WinAnsi whitelist
    .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, '?');
}

export class BrandedPdf {
  private doc!: PDFDocument;
  private font!: PDFFont;
  private bold!: PDFFont;
  private page!: PDFPage;
  private y = 0;
  private readonly pages: PDFPage[] = [];
  private readonly ink = rgb(0.07, 0.09, 0.15);
  private readonly muted = rgb(0.42, 0.45, 0.5);
  private readonly hair = rgb(0.88, 0.89, 0.91);

  private constructor(
    private readonly brand: Branding,
    private readonly title: string,
    private readonly watermark: string | null,
  ) {}

  static async create(brand: Branding, title: string, watermark: string | null): Promise<BrandedPdf> {
    const p = new BrandedPdf(brand, title, watermark);
    p.doc = await PDFDocument.create();
    p.doc.setTitle(pdfSafe(title));
    p.doc.setAuthor(pdfSafe(brand.companyName));
    p.doc.setCreator(pdfSafe(brand.portalName));
    p.doc.setProducer('Hotel Owners Portal');
    p.font = await p.doc.embedFont(StandardFonts.Helvetica);
    p.bold = await p.doc.embedFont(StandardFonts.HelveticaBold);
    p.newPage();
    return p;
  }

  private get contentWidth() {
    return PAGE.w - PAGE.margin * 2;
  }

  private newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.pages.push(this.page);
    const band = hexToRgb(this.brand.primaryColor);
    const onBand = luminance(this.brand.primaryColor) > 0.4 ? this.ink : rgb(1, 1, 1);
    this.page.drawRectangle({ x: 0, y: PAGE.h - 56, width: PAGE.w, height: 56, color: band });
    this.page.drawRectangle({ x: 0, y: PAGE.h - 59, width: PAGE.w, height: 3, color: hexToRgb(this.brand.accentColor) });
    this.page.drawText(pdfSafe(this.brand.portalName), { x: PAGE.margin, y: PAGE.h - 34, size: 14, font: this.bold, color: onBand });
    const right = pdfSafe(this.brand.companyName);
    this.page.drawText(right, { x: PAGE.w - PAGE.margin - this.font.widthOfTextAtSize(right, 9), y: PAGE.h - 33, size: 9, font: this.font, color: onBand });
    if (this.watermark) {
      this.page.drawText(pdfSafe(this.watermark), { x: 90, y: 260, size: 46, font: this.bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(35) });
    }
    this.y = PAGE.h - 84;
  }

  private ensure(height: number) {
    if (this.y - height < PAGE.margin + 30) this.newPage();
  }

  heading(text: string, size = 18) {
    this.ensure(size + 10);
    this.page.drawText(pdfSafe(text), { x: PAGE.margin, y: this.y - size, size, font: this.bold, color: this.ink });
    this.y -= size + 8;
  }

  subheading(text: string) {
    this.heading(text, 12);
  }

  line(text: string, opts: { size?: number; muted?: boolean; bold?: boolean } = {}) {
    for (const l of this.wrap(pdfSafe(text), opts.size ?? 10, this.contentWidth, opts.bold ? this.bold : this.font)) {
      this.ensure((opts.size ?? 10) + 5);
      this.page.drawText(l, { x: PAGE.margin, y: this.y - (opts.size ?? 10), size: opts.size ?? 10, font: opts.bold ? this.bold : this.font, color: opts.muted ? this.muted : this.ink });
      this.y -= (opts.size ?? 10) + 4;
    }
  }

  space(h = 10) {
    this.y -= h;
  }

  /** Key figures in a row of boxes. */
  tiles(items: Array<{ label: string; value: string; note?: string }>) {
    const gap = 8;
    const w = (this.contentWidth - gap * (items.length - 1)) / items.length;
    this.ensure(62);
    items.forEach((t, i) => {
      const x = PAGE.margin + i * (w + gap);
      this.page.drawRectangle({ x, y: this.y - 58, width: w, height: 58, borderColor: this.hair, borderWidth: 1 });
      this.page.drawText(pdfSafe(t.label.toUpperCase()), { x: x + 8, y: this.y - 16, size: 7.5, font: this.bold, color: this.muted });
      this.page.drawText(pdfSafe(t.value), { x: x + 8, y: this.y - 36, size: 15, font: this.bold, color: this.ink });
      if (t.note) this.page.drawText(pdfSafe(t.note), { x: x + 8, y: this.y - 50, size: 7.5, font: this.font, color: this.muted });
    });
    this.y -= 70;
  }

  table(columns: Column[], rows: TableRow[]) {
    const size = 8.5;
    const rowH = 15;
    const widths = columns.map((c) => c.width * this.contentWidth);
    const drawHeader = () => {
      this.ensure(rowH * 2);
      this.page.drawRectangle({ x: PAGE.margin, y: this.y - rowH, width: this.contentWidth, height: rowH, color: rgb(0.96, 0.96, 0.95) });
      let x = PAGE.margin;
      columns.forEach((c, i) => {
        this.cell(c.header, x, widths[i]!, c.align, this.bold, size, this.muted);
        x += widths[i]!;
      });
      this.y -= rowH;
    };
    drawHeader();
    for (const r of rows) {
      if (this.y - rowH < PAGE.margin + 30) {
        this.newPage();
        drawHeader();
      }
      if (r.style === 'bold') this.page.drawRectangle({ x: PAGE.margin, y: this.y - rowH, width: this.contentWidth, height: rowH, color: rgb(0.97, 0.97, 0.96) });
      let x = PAGE.margin;
      r.cells.forEach((text, i) => {
        const col = columns[i];
        if (!col) return;
        const font = r.style === 'bold' || r.style === 'section' ? this.bold : this.font;
        this.cell(text, x, widths[i]!, col.align, font, size, r.style === 'muted' || r.style === 'section' ? this.muted : this.ink);
        x += widths[i]!;
      });
      this.page.drawLine({ start: { x: PAGE.margin, y: this.y - rowH }, end: { x: PAGE.margin + this.contentWidth, y: this.y - rowH }, thickness: 0.5, color: this.hair });
      this.y -= rowH;
    }
    this.y -= 8;
  }

  private cell(text: string, x: number, width: number, align: 'left' | 'right' | undefined, font: PDFFont, size: number, color: RGB) {
    let t = pdfSafe(text);
    while (t.length > 1 && font.widthOfTextAtSize(t, size) > width - 8) t = `${t.slice(0, -2)}…`.replace('…', '.');
    const tw = font.widthOfTextAtSize(t, size);
    const tx = align === 'right' ? x + width - 4 - tw : x + 4;
    this.page.drawText(t, { x: tx, y: this.y - 11, size, font, color });
  }

  private wrap(text: string, size: number, width: number, font: PDFFont): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/)) {
        const next = cur ? `${cur} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width && cur) {
          out.push(cur);
          cur = word;
        } else cur = next;
      }
      out.push(cur);
    }
    return out;
  }

  async finish(generatedFor: string): Promise<Uint8Array> {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const footer = pdfSafe(this.brand.reportFooter ?? `${this.brand.companyName}. Confidential.`);
      p.drawLine({ start: { x: PAGE.margin, y: 40 }, end: { x: PAGE.w - PAGE.margin, y: 40 }, thickness: 0.5, color: this.hair });
      p.drawText(footer.slice(0, 120), { x: PAGE.margin, y: 28, size: 7, font: this.font, color: this.muted });
      const meta = pdfSafe(`${this.title} · Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC for ${generatedFor} · Page ${i + 1} of ${total}`).replace('·', '-').replace('·', '-');
      p.drawText(meta, { x: PAGE.margin, y: 18, size: 7, font: this.font, color: this.muted });
    });
    return this.doc.save();
  }
}
