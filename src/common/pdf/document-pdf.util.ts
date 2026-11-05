import PDFDocument from 'pdfkit';
import { formatRupees, MoneyInput } from '../utils/money.util';

/**
 * One server-side document layout for the PDFs FinMatrix Connect attaches,
 * mirroring the web's DocumentPaper (FinMatrix-Website
 * src/features/documents/DocumentPaper.tsx + documentModel.ts):
 *
 *   letterhead (company, address, contact)        KIND / number / stamp
 *   ───────────────────────────────────────────────────────────────────
 *   party (label, name, lines)                     meta (label: value)
 *   line table (Description [Qty] [Rate] [Tax] Amount) or a custom table
 *   totals (right), notes, signatures, footer
 */

export interface PdfCompany {
  name: string;
  addressLines: string[];
  contactLines: string[];
}

export interface PdfParty {
  label: string;
  name: string;
  lines: string[];
}

export interface PdfLine {
  description: string;
  secondary?: string | null;
  quantity?: string | null;
  unitPrice?: MoneyInput | null;
  taxRate?: string | null;
  amount: MoneyInput;
}

export interface PdfTotal {
  label: string;
  value: MoneyInput;
  grand?: boolean;
  prefix?: string;
  dividerBefore?: boolean;
}

export interface PdfTable {
  headers: string[];
  /** Fractions of the content width, summing to 1. */
  widths: number[];
  align: Array<'left' | 'right'>;
  rows: string[][];
}

export interface DocumentPdfModel {
  kind: string;
  number: string;
  company: PdfCompany;
  party: PdfParty;
  meta: Array<{ label: string; value: string }>;
  showQuantity?: boolean;
  showTax?: boolean;
  quantityHeader?: string;
  priceHeader?: string;
  lines?: PdfLine[];
  /** Instead of `lines`, e.g. a statement with a running balance. */
  table?: PdfTable;
  totals: PdfTotal[];
  notes?: Array<{ title: string; text: string | null | undefined }>;
  signatures?: string[];
  stamp?: string | null;
}

interface Address {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  zipCode?: string;
  country?: string;
}

/** An address as printed: street, then city/state/postcode, then country. */
export function addressLines(a: Address | null | undefined): string[] {
  if (!a) return [];
  const cityLine = [a.city, a.state, a.postalCode ?? a.zipCode]
    .filter((p) => p && String(p).trim())
    .join(', ');
  return [a.street, cityLine, a.country].filter(
    (p): p is string => !!p && String(p).trim().length > 0,
  );
}

export const joinDots = (...parts: Array<string | null | undefined>) =>
  parts.filter((p): p is string => !!p && p.trim().length > 0).join(' · ');

export function companyForPdf(c: {
  name: string;
  address?: Address | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  taxId?: string | null;
}): PdfCompany {
  return {
    name: c.name || 'Your company',
    addressLines: addressLines(c.address),
    contactLines: [
      joinDots(c.phone, c.email),
      joinDots(c.website, c.taxId ? `NTN ${c.taxId}` : ''),
    ].filter((l) => l.length > 0),
  };
}

/** "5 Nov 2026" from an ISO date, as the web's docDate shows it. */
export function pdfDate(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const s = iso instanceof Date ? iso.toISOString() : String(iso);
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${d} ${months[m - 1]} ${y}`;
}

const TERMS: Record<string, string> = {
  due_on_receipt: 'Due on receipt',
  net15: 'Net 15',
  net30: 'Net 30',
  net45: 'Net 45',
  net60: 'Net 60',
  '2_10_net30': '2/10 Net 30',
  custom: 'Custom',
};
export const termsLabel = (t: string | null | undefined) =>
  t ? (TERMS[t] ?? t) : '';

const METHODS: Record<string, string> = {
  cash: 'Cash',
  check: 'Cheque',
  cheque: 'Cheque',
  bank_transfer: 'Bank transfer',
  credit_card: 'Card',
  card: 'Card',
  online: 'Online',
  other: 'Other',
};
export const methodLabel = (m: string | null | undefined) =>
  m
    ? (METHODS[m] ??
      m.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()))
    : '';

const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#d1d5db';

/** Render the model to a PDF Buffer (A4). */
export function renderDocumentPdf(model: DocumentPdfModel): Promise<Buffer> {
  const doc = new PDFDocument({
    margin: 48,
    size: 'A4',
    info: { Title: `${model.kind} ${model.number}` },
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
  const bottom = () => doc.page.height - doc.page.margins.bottom - 40;

  // ── Letterhead ─────────────────────────────────────────────
  let y = doc.page.margins.top;
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(INK)
    .text(model.company.name, left, y, { width: width * 0.6 });
  let ly = doc.y + 2;
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  for (const line of [
    ...model.company.addressLines,
    ...model.company.contactLines,
  ]) {
    doc.text(line, left, ly, { width: width * 0.6 });
    ly = doc.y;
  }
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(INK)
    .text(model.kind.toUpperCase(), left, y, { width, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(MUTED)
    .text(model.number, left, doc.y + 2, { width, align: 'right' });
  if (model.stamp) {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#b91c1c')
      .text(model.stamp.toUpperCase(), left, doc.y + 4, {
        width,
        align: 'right',
      });
  }
  y = Math.max(ly, doc.y) + 14;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(1).stroke();
  y += 14;

  // ── Party and meta ─────────────────────────────────────────
  const top = y;
  doc
    .font('Helvetica-Bold')
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(model.party.label.toUpperCase(), left, y);
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text(model.party.name, left, doc.y + 3, { width: width * 0.5 });
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  for (const line of model.party.lines)
    doc.text(line, left, doc.y + 1, { width: width * 0.5 });
  const partyBottom = doc.y;

  let my = top;
  const metaX = left + width * 0.55;
  const metaW = width * 0.45;
  for (const m of model.meta.filter((r) => r.value && r.value.trim())) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(m.label, metaX, my, { width: metaW * 0.45 });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(INK)
      .text(m.value, metaX + metaW * 0.45, my, {
        width: metaW * 0.55,
        align: 'right',
      });
    my = doc.y + 3;
  }
  y = Math.max(partyBottom, my) + 18;

  // ── Table ──────────────────────────────────────────────────
  const table = model.table ?? linesTable(model);
  const colX: number[] = [];
  let acc = left;
  for (const w of table.widths) {
    colX.push(acc);
    acc += w * width;
  }
  const colW = table.widths.map((w) => w * width - 6);
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    table.headers.forEach((h, i) =>
      doc.text(h.toUpperCase(), colX[i], y, {
        width: colW[i],
        align: table.align[i],
      }),
    );
    y = doc.y + 4;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
    y += 6;
  };
  header();
  const secondaries = model.table
    ? []
    : (model.lines ?? []).map((l) => l.secondary ?? '');
  table.rows.forEach((row, r) => {
    if (y > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
      header();
    }
    let rowBottom = y;
    row.forEach((cell, i) => {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(INK)
        .text(cell, colX[i], y, { width: colW[i], align: table.align[i] });
      rowBottom = Math.max(rowBottom, doc.y);
    });
    const sec = secondaries[r];
    if (sec) {
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(sec, colX[0], rowBottom + 1, { width: colW[0] });
      rowBottom = doc.y;
    }
    y = rowBottom + 6;
    doc
      .moveTo(left, y - 3)
      .lineTo(right, y - 3)
      .strokeColor('#eef0f3')
      .stroke();
  });

  // ── Totals ─────────────────────────────────────────────────
  y += 6;
  if (y > bottom() - model.totals.length * 18) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  const tx = left + width * 0.5;
  const tw = width * 0.5;
  for (const t of model.totals) {
    if (t.dividerBefore) {
      doc.moveTo(tx, y).lineTo(right, y).strokeColor(RULE).stroke();
      y += 6;
    }
    const font = t.grand ? 'Helvetica-Bold' : 'Helvetica';
    const size = t.grand ? 11 : 9.5;
    doc
      .font(font)
      .fontSize(size)
      .fillColor(t.grand ? INK : MUTED)
      .text(t.label, tx, y, { width: tw * 0.55 });
    doc
      .font(font)
      .fontSize(size)
      .fillColor(INK)
      .text(`${t.prefix ?? ''}${formatRupees(t.value)}`, tx + tw * 0.55, y, {
        width: tw * 0.45,
        align: 'right',
      });
    y = doc.y + 5;
  }

  // ── Notes and signatures ───────────────────────────────────
  y += 10;
  for (const n of model.notes ?? []) {
    if (!n.text || !n.text.trim()) continue;
    if (y > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(MUTED)
      .text(n.title.toUpperCase(), left, y);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(INK)
      .text(n.text, left, doc.y + 2, { width });
    y = doc.y + 10;
  }
  if (model.signatures?.length) {
    y = Math.max(y + 30, Math.min(bottom() - 10, y + 30));
    const sw = width / model.signatures.length;
    model.signatures.forEach((s, i) => {
      const x = left + i * sw;
      doc
        .moveTo(x, y)
        .lineTo(x + sw - 24, y)
        .strokeColor(RULE)
        .stroke();
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(MUTED)
        .text(s, x, y + 4, { width: sw - 24 });
    });
  }

  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(
      `Sent via FinMatrix`,
      left,
      doc.page.height - doc.page.margins.bottom - 12,
      { width, align: 'center' },
    );

  doc.end();
  return done;
}

function linesTable(model: DocumentPdfModel): PdfTable {
  const q = model.showQuantity !== false;
  const t = model.showTax !== false;
  const headers = ['Description'];
  const widths: number[] = [];
  const align: Array<'left' | 'right'> = ['left'];
  if (q) {
    headers.push(model.quantityHeader ?? 'Qty', model.priceHeader ?? 'Rate');
    align.push('right', 'right');
  }
  if (t) {
    headers.push('Tax');
    align.push('right');
  }
  headers.push('Amount');
  align.push('right');
  const rest = (q ? 0.12 + 0.17 : 0) + (t ? 0.09 : 0) + 0.2;
  widths.push(1 - rest);
  if (q) widths.push(0.12, 0.17);
  if (t) widths.push(0.09);
  widths.push(0.2);
  const rows = (model.lines ?? []).map((l) => {
    const r = [l.description];
    if (q)
      r.push(
        l.quantity ?? '',
        l.unitPrice === null || l.unitPrice === undefined
          ? ''
          : formatRupees(l.unitPrice),
      );
    if (t) r.push(l.taxRate ? `${Number(l.taxRate)}%` : '');
    r.push(formatRupees(l.amount));
    return r;
  });
  return { headers, widths, align, rows };
}

/** "12.0000" -> "12", "2.5000" -> "2.5". */
export function qty(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : String(v);
}
