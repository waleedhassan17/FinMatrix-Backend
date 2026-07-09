import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import Decimal from 'decimal.js';
import { Company } from '../companies/entities/company.entity';
import { Employee } from './entities/employee.entity';
import { PayrollItem } from './entities/payroll-item.entity';
import { PayrollRun } from './entities/payroll-run.entity';

// ── Amount in words (Pakistani numbering: crore / lakh) ──────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function upToNinetyNine(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

function upToNineNinetyNine(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (!h) return upToNinetyNine(rest);
  return rest ? `${ONES[h]} Hundred ${upToNinetyNine(rest)}` : `${ONES[h]} Hundred`;
}

/** "Rupees Ninety-Five Thousand Eight Hundred Thirty-Three Only" — PK payslip convention. */
export function amountInWordsPKR(value: Decimal.Value): string {
  const amount = new Decimal(value);
  let rupees = amount.floor().toNumber();
  const paisa = amount.minus(amount.floor()).times(100).toDecimalPlaces(0).toNumber();

  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000); rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000); rupees %= 100_000;
  const thousand = Math.floor(rupees / 1_000); rupees %= 1_000;
  if (crore) parts.push(`${upToNineNinetyNine(crore)} Crore`);
  if (lakh) parts.push(`${upToNinetyNine(lakh)} Lakh`);
  if (thousand) parts.push(`${upToNinetyNine(thousand)} Thousand`);
  if (rupees) parts.push(upToNineNinetyNine(rupees));
  const rupeeWords = parts.length ? parts.join(' ') : 'Zero';

  const paisaWords = paisa ? ` and ${upToNinetyNine(paisa)} Paisa` : '';
  return `Rupees ${rupeeWords}${paisaWords} Only`;
}

const fmt = (v: Decimal.Value) =>
  `Rs ${new Decimal(v).toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface PayslipInput {
  company: Company;
  employee: Employee;
  run: PayrollRun;
  item: PayrollItem;
}

interface Line { label: string; amount: Decimal }

const INK = '#1A2733';
const MUTED = '#5A6B7B';
const RULE = '#C9D3DC';
const BAND = '#EEF3F8';

/**
 * Official PDF payslip. All figures come straight off the stored
 * PayrollItem (the same rows the posted journal entry was built from) —
 * nothing is recomputed here, so the PDF always ties to the ledger.
 */
@Injectable()
export class PayslipPdfService {
  /** Itemised earnings. The data model carries one gross figure per item
   *  (no allowance breakdown), so this is a single line summing to gross. */
  private earningLines({ employee, item }: PayslipInput): Line[] {
    if (employee.payType === 'hourly') {
      const hours = new Decimal(item.hours ?? 0);
      return [{ label: `Hourly wages (${hours.toFixed(2)} hrs)`, amount: new Decimal(item.gross) }];
    }
    return [{ label: 'Basic salary', amount: new Decimal(item.gross) }];
  }

  /** Itemised deductions. If the employee's configured deduction lines sum
   *  exactly to what this run withheld, show them by name; otherwise fall
   *  back to a single line so the total always equals the posted figure. */
  private deductionLines({ employee, item }: PayslipInput): Line[] {
    const withheld = new Decimal(item.deductions);
    const configured: any = employee.deductions;
    if (Array.isArray(configured) && configured.length > 0) {
      const lines = configured.map((d: any, i: number) => ({
        label: String(d?.name || d?.type || `Deduction ${i + 1}`),
        amount: new Decimal(parseFloat(d?.amount ?? '0') || 0),
      }));
      const sum = lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
      if (sum.equals(withheld)) return lines;
    }
    if (withheld.isZero()) return [];
    return [{ label: 'Income tax / deductions withheld', amount: withheld }];
  }

  render(input: PayslipInput): Readable {
    const { company, employee, run, item } = input;
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const L = 40, R = 555, W = R - L;

    // ── Header: company identity + document title ──
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text(company.name, L, 42, { width: 330 });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    const a = company.address;
    const addressLine = a ? [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ') : '';
    if (addressLine) doc.text(addressLine, { width: 330 });
    const contact = [company.phone, company.email].filter(Boolean).join('  ·  ');
    if (contact) doc.text(contact, { width: 330 });

    doc.font('Helvetica-Bold').fontSize(21).fillColor(INK).text('PAYSLIP', 375, 42, { width: 180, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text(`Salary for ${run.payPeriod}`, 375, doc.y + 2, { width: 180, align: 'right' })
      .text(`Pay date: ${run.payDate}`, 375, doc.y + 1, { width: 180, align: 'right' });

    let y = Math.max(doc.y, 100) + 12;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(RULE).stroke();
    y += 14;

    // ── Employee block ──
    const kv = (label: string, value: string, x: number, yy: number) => {
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, yy);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(value || '—', x, yy + 10, { width: 240 });
    };
    kv('Employee', `${employee.firstName} ${employee.lastName}`, L, y);
    kv('Employee ID', `EMP-${employee.id.slice(0, 8).toUpperCase()}`, 320, y);
    y += 34;
    kv('Designation / Department', [employee.position, employee.department].filter(Boolean).join(' · ') || '—', L, y);
    kv('Pay period', `${run.periodStart} to ${run.periodEnd}`, 320, y);
    y += 44;

    // ── Earnings & deductions, side by side ──
    const earnings = this.earningLines(input);
    const deductions = this.deductionLines(input);
    const colW = 250, leftX = L, rightX = 305;
    const rowH = 18, headH = 20;
    const rows = Math.max(earnings.length, deductions.length, 1);
    const tableH = headH + rows * rowH + rowH; // header + lines + total row

    const table = (x: number, title: string, lines: Line[], totalLabel: string, total: Decimal) => {
      doc.rect(x, y, colW, headH).fill(BAND);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
        .text(title, x + 8, y + 6)
        .text('AMOUNT (PKR)', x, y + 6, { width: colW - 8, align: 'right' });
      let ry = y + headH;
      for (const line of lines) {
        doc.font('Helvetica').fontSize(9.5).fillColor(INK)
          .text(line.label, x + 8, ry + 5, { width: colW - 110 })
          .text(fmt(line.amount), x, ry + 5, { width: colW - 8, align: 'right' });
        ry += rowH;
      }
      if (lines.length === 0) {
        doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text('—', x + 8, ry + 5);
      }
      const ty = y + headH + rows * rowH;
      doc.moveTo(x, ty).lineTo(x + colW, ty).lineWidth(0.75).strokeColor(RULE).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
        .text(totalLabel, x + 8, ty + 5)
        .text(fmt(total), x, ty + 5, { width: colW - 8, align: 'right' });
      doc.rect(x, y, colW, tableH).lineWidth(0.75).strokeColor(RULE).stroke();
    };

    table(leftX, 'EARNINGS', earnings, 'GROSS PAY', new Decimal(item.gross));
    table(rightX, 'DEDUCTIONS', deductions, 'TOTAL DEDUCTIONS', new Decimal(item.deductions));
    y += tableH + 18;

    // ── Net pay band + amount in words ──
    doc.rect(L, y, W, 30).fill(BAND);
    doc.rect(L, y, W, 30).lineWidth(0.75).strokeColor(RULE).stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
      .text('NET PAY', L + 10, y + 9)
      .text(fmt(item.net), L, y + 9, { width: W - 10, align: 'right' });
    y += 38;
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(MUTED)
      .text(`Amount in words: ${amountInWordsPKR(item.net)}`, L, y, { width: W });

    // ── Footer ──
    const fy = doc.page.height - 70;
    doc.moveTo(L, fy).lineTo(R, fy).lineWidth(0.75).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text('This is a system-generated payslip and does not require a signature.', L, fy + 8, { width: W, align: 'center' })
      .text('All amounts are in Pakistani Rupees (PKR).', L, fy + 19, { width: W, align: 'center' });

    doc.end();
    return doc as unknown as Readable;
  }
}
