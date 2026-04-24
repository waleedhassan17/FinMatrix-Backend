import { Injectable } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import { Invoice } from './entities/invoice.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Company } from '../companies/entities/company.entity';

@Injectable()
export class InvoicePdfService {
  render(invoice: Invoice, customer: Customer, company: Company): Readable {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    // Header
    doc.fontSize(20).text(company.name, 50, 50);
    if (company.email) doc.fontSize(10).text(company.email);
    if (company.phone) doc.text(company.phone);
    doc.moveDown();

    doc.fontSize(20).text('INVOICE', { align: 'right' });
    doc.fontSize(10)
      .text(`# ${invoice.invoiceNumber}`, { align: 'right' })
      .text(`Date: ${invoice.invoiceDate}`, { align: 'right' })
      .text(`Due: ${invoice.dueDate}`, { align: 'right' })
      .text(`Status: ${invoice.status.toUpperCase()}`, { align: 'right' });
    doc.moveDown(2);

    // Bill to
    doc.fontSize(12).text('Bill To:');
    doc.fontSize(10).text(customer.name);
    if (customer.company) doc.text(customer.company);
    if (customer.email) doc.text(customer.email);
    if (customer.billingAddress) {
      const a = customer.billingAddress;
      const line = [a.street, a.city, a.state, a.postalCode, a.country]
        .filter(Boolean)
        .join(', ');
      if (line) doc.text(line);
    }
    doc.moveDown();

    // Lines table
    const tableTop = doc.y + 10;
    doc.fontSize(10).text('Description', 50, tableTop);
    doc.text('Qty', 300, tableTop, { width: 50, align: 'right' });
    doc.text('Unit Price', 355, tableTop, { width: 80, align: 'right' });
    doc.text('Tax %', 440, tableTop, { width: 40, align: 'right' });
    doc.text('Amount', 485, tableTop, { width: 65, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

    let y = tableTop + 25;
    for (const line of invoice.lines ?? []) {
      doc.text(line.description, 50, y, { width: 240 });
      doc.text(line.quantity, 300, y, { width: 50, align: 'right' });
      doc.text(line.unitPrice, 355, y, { width: 80, align: 'right' });
      doc.text(line.taxRate, 440, y, { width: 40, align: 'right' });
      doc.text(line.lineTotal, 485, y, { width: 65, align: 'right' });
      y += 20;
    }

    // Totals
    y += 10;
    doc.moveTo(350, y).lineTo(550, y).stroke();
    y += 10;
    doc.text('Subtotal:', 350, y, { width: 130, align: 'right' });
    doc.text(invoice.subtotal, 485, y, { width: 65, align: 'right' });
    y += 16;
    if (parseFloat(invoice.discountAmount) > 0) {
      doc.text('Discount:', 350, y, { width: 130, align: 'right' });
      doc.text(`-${invoice.discountAmount}`, 485, y, { width: 65, align: 'right' });
      y += 16;
    }
    doc.text('Tax:', 350, y, { width: 130, align: 'right' });
    doc.text(invoice.taxAmount, 485, y, { width: 65, align: 'right' });
    y += 16;
    doc.fontSize(12).text('Total:', 350, y, { width: 130, align: 'right' });
    doc.text(invoice.total, 485, y, { width: 65, align: 'right' });
    y += 20;
    doc.fontSize(10).text('Paid:', 350, y, { width: 130, align: 'right' });
    doc.text(invoice.amountPaid, 485, y, { width: 65, align: 'right' });
    y += 16;
    doc.fontSize(12).text('Balance Due:', 350, y, { width: 130, align: 'right' });
    doc.text(invoice.balance, 485, y, { width: 65, align: 'right' });

    if (invoice.notes) {
      doc.moveDown(3).fontSize(9).text(`Notes: ${invoice.notes}`, 50);
    }

    doc.end();
    return doc as unknown as Readable;
  }
}
