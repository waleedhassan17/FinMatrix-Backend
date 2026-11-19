import PDFDocument from 'pdfkit';

/**
 * One layout for every tabular financial report FinMatrix renders server-side
 * (the backup's trial balance, balance sheet, P&L and agings; the migration
 * certificate). A4 portrait, the company as a letterhead, then sections of
 * rows with a header that repeats on every page and totals set off by a rule.
 *
 * Standard PDF fonts only (Helvetica), as document-pdf.util: no font file is
 * bundled, so Latin text renders and Urdu names fall back to the CSVs, which
 * carry them exactly. Listed as a known limitation of the PDFs.
 */
export interface ReportPdfColumn {
  header: string;
  /** Fraction of the content width; a section's fractions sum to 1. */
  width: number;
  align?: 'left' | 'right';
}

export interface ReportPdfSection {
  heading?: string;
  columns: ReportPdfColumn[];
  rows: string[][];
  /** Bold rows under a rule — section totals. */
  totals?: string[][];
  note?: string;
}

export interface ReportPdfModel {
  title: string;
  subtitle?: string;
  company: { name: string; lines: string[] };
  meta?: Array<{ label: string; value: string }>;
  sections: ReportPdfSection[];
  footer?: string;
}

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const ROW_H = 15;
const HEAD_H = 18;

export function renderReportPdf(model: ReportPdfModel): Promise<Buffer> {
  const doc = new PDFDocument({
    margin: 40,
    size: 'A4',
    bufferPages: true,
    info: { Title: `${model.title} — ${model.company.name}` },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;

  // ── Letterhead ───────────────────────────────────────────────
  let y = doc.page.margins.top;
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK);
  doc.text(model.company.name, left, y, { width: width * 0.6 });
  let ly = doc.y + 2;
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  for (const line of model.company.lines) {
    doc.text(line, left, ly, { width: width * 0.6 });
    ly = doc.y;
  }
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK);
  doc.text(model.title.toUpperCase(), left, y, { width, align: 'right' });
  if (model.subtitle) {
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
    doc.text(model.subtitle, left, doc.y + 2, { width, align: 'right' });
  }
  for (const m of model.meta ?? []) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    doc.text(`${m.label}: ${m.value}`, left, doc.y + 1, {
      width,
      align: 'right',
    });
  }
  y = Math.max(ly, doc.y) + 12;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(1).stroke();
  y += 12;

  const colX = (cols: ReportPdfColumn[]) => {
    const xs: Array<{ x: number; w: number }> = [];
    let x = left;
    for (const c of cols) {
      const w = width * c.width;
      xs.push({ x, w });
      x += w;
    }
    return xs;
  };

  const drawHeader = (cols: ReportPdfColumn[]) => {
    const xs = colX(cols);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    cols.forEach((c, i) => {
      doc.text(c.header.toUpperCase(), xs[i].x + 2, y + 4, {
        width: xs[i].w - 4,
        align: c.align ?? 'left',
        lineBreak: false,
      });
    });
    y += HEAD_H;
    doc
      .moveTo(left, y)
      .lineTo(right, y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    y += 2;
  };

  const ensureRoom = (needed: number, cols: ReportPdfColumn[]) => {
    if (y + needed <= bottom()) return;
    doc.addPage();
    y = doc.page.margins.top;
    drawHeader(cols);
  };

  const drawRow = (cols: ReportPdfColumn[], cells: string[], bold: boolean) => {
    const xs = colX(cols);
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(8.5)
      .fillColor(INK);
    cells.forEach((cell, i) => {
      if (!xs[i]) return;
      doc.text(cell ?? '', xs[i].x + 2, y + 3, {
        width: xs[i].w - 4,
        align: cols[i].align ?? 'left',
        lineBreak: false,
        ellipsis: true,
      });
    });
    y += ROW_H;
  };

  // ── Sections ─────────────────────────────────────────────────
  for (const section of model.sections) {
    if (section.heading) {
      ensureRoom(HEAD_H * 3, section.columns);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
      doc.text(section.heading, left, y + 2, { width });
      y = doc.y + 4;
    }
    drawHeader(section.columns);
    if (section.rows.length === 0) {
      ensureRoom(ROW_H, section.columns);
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED);
      doc.text('No rows', left + 2, y + 3, { width });
      y += ROW_H;
    }
    for (const row of section.rows) {
      ensureRoom(ROW_H, section.columns);
      drawRow(section.columns, row, false);
    }
    if (section.totals && section.totals.length > 0) {
      ensureRoom(ROW_H * (section.totals.length + 1), section.columns);
      doc
        .moveTo(left, y + 1)
        .lineTo(right, y + 1)
        .strokeColor(INK)
        .lineWidth(0.8)
        .stroke();
      y += 3;
      for (const t of section.totals) drawRow(section.columns, t, true);
    }
    if (section.note) {
      ensureRoom(ROW_H * 2, section.columns);
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED);
      doc.text(section.note, left, y + 4, { width });
      y = doc.y + 4;
    }
    y += 10;
  }

  // ── Footer with page numbers ─────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - doc.page.margins.bottom - 10;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    doc.text(model.footer ?? '', left, fy, {
      width: width * 0.7,
      lineBreak: false,
    });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left, fy, {
      width,
      align: 'right',
      lineBreak: false,
    });
  }
  doc.end();
  return done;
}
