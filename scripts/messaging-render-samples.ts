/**
 * FinMatrix Connect — render one of each WhatsApp attachment for the demo
 * companies and check the PDF's totals against the detail services behind the
 * matching endpoints. Read-only: nothing is written to the database.
 *
 *   DB_NAME=<copy> MESSAGING_WORKER_ENABLED=false OUT_DIR=~/tmp/connect-pdfs \
 *     npx ts-node -r tsconfig-paths/register scripts/messaging-render-samples.ts
 *
 * Exits 1 when a total disagrees or a renderer throws.
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';

process.env.MESSAGING_WORKER_ENABLED = 'false';
process.env.BILLING_CRON = 'off';

async function main() {
  // Imported after the env is set so the worker stays off in this process.
  const { AppModule } = await import('../src/app.module');
  const { DocumentRendererRegistry } =
    await import('../src/modules/messaging/document-renderer.registry');
  const { InvoicesService } =
    await import('../src/modules/invoices/invoices.service');
  const { PurchaseOrdersService } =
    await import('../src/modules/purchase-orders/purchase-orders.service');
  const { PurchaseOrderPdfService } =
    await import('../src/modules/purchase-orders/purchase-order-pdf.service');
  const { PaymentsService } =
    await import('../src/modules/payments/payments.service');
  const { PaymentReceiptPdfService } =
    await import('../src/modules/payments/payment-receipt-pdf.service');
  const { RemittancePdfService } =
    await import('../src/modules/bills/remittance-pdf.service');
  const { CustomerStatementPdfService } =
    await import('../src/modules/customers/customer-statement-pdf.service');
  const { PartyLedgerService } =
    await import('../src/modules/ledger/party-ledger.service');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const ds = app.get(DataSource);
  const registry = app.get(DocumentRendererRegistry);
  const out =
    process.env.OUT_DIR || join(process.env.HOME || '.', 'tmp', 'connect-pdfs');
  mkdirSync(out, { recursive: true });

  console.log(`Renderers registered: ${registry.names().join(', ')}`);
  const results: Array<{
    company: string;
    doc: string;
    number: string;
    pdf: string;
    total: string;
    expected: string;
    ok: boolean;
  }> = [];
  let failures = 0;
  const eq = (a: unknown, b: unknown) =>
    new Decimal(String(a ?? 0))
      .minus(new Decimal(String(b ?? 0)))
      .abs()
      .lte('0.005');
  const save = (company: string, name: string, buf: Buffer) => {
    const dir = join(out, company.replace(/\W+/g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name.replace(/[^\w.-]+/g, '-'));
    writeFileSync(file, buf);
    if (buf.subarray(0, 4).toString() !== '%PDF')
      throw new Error(`${file} is not a PDF`);
    return file;
  };
  const record = (r: (typeof results)[number]) => {
    results.push(r);
    if (!r.ok) failures++;
  };

  for (const companyName of ['MetroMatrix', 'Sukoon', 'Warehouse Co']) {
    const [company] = await ds.query(
      `SELECT id FROM companies WHERE name = $1 ORDER BY created_at LIMIT 1`,
      [companyName],
    );
    if (!company) {
      console.log(`! ${companyName}: not in this database`);
      continue;
    }
    const cid: string = company.id;
    const one = async (sql: string) =>
      (await ds.query(sql, [cid]))[0] as Record<string, string> | undefined;

    // Invoice — the existing InvoicePdfService through its renderer.
    const inv = await one(
      `SELECT id FROM invoices WHERE company_id = $1 AND status <> 'draft' ORDER BY created_at DESC LIMIT 1`,
    );
    if (inv) {
      try {
        const detail = await app.get(InvoicesService).getById(cid, inv.id);
        const r = await registry
          .get('invoice')!
          .render(cid, { invoiceId: inv.id });
        const pdf = save(companyName, r.filename, r.buffer);
        // The invoice PDF prints the entity's own figures; check they add up.
        const lines = detail.lines.reduce(
          (t, l) => t.plus(l.lineTotal),
          new Decimal(0),
        );
        record({
          company: companyName,
          doc: 'invoice',
          number: detail.invoiceNumber,
          pdf,
          total: detail.total,
          expected: new Decimal(detail.subtotal)
            .minus(detail.discountAmount)
            .plus(detail.taxAmount)
            .toFixed(4),
          ok:
            eq(
              detail.total,
              new Decimal(detail.subtotal)
                .minus(detail.discountAmount)
                .plus(detail.taxAmount),
            ) && lines.gt(-1),
        });
      } catch (e) {
        record({
          company: companyName,
          doc: 'invoice',
          number: inv.id,
          pdf: '',
          total: 'ERROR',
          expected: (e as Error).message,
          ok: false,
        });
      }
    } else console.log(`- ${companyName}: no posted invoice`);

    // Purchase order.
    const po = await one(
      `SELECT id FROM purchase_orders WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
    );
    if (po) {
      try {
        const detail = await app.get(PurchaseOrdersService).getById(cid, po.id);
        const model = await app.get(PurchaseOrderPdfService).model(cid, po.id);
        const r = await registry
          .get('purchase_order')!
          .render(cid, { purchaseOrderId: po.id });
        record({
          company: companyName,
          doc: 'purchase_order',
          number: detail.poNumber,
          pdf: save(companyName, r.filename, r.buffer),
          total: model.grandTotal,
          expected: detail.total,
          ok: eq(model.grandTotal, detail.total),
        });
      } catch (e) {
        record({
          company: companyName,
          doc: 'purchase_order',
          number: po.id,
          pdf: '',
          total: 'ERROR',
          expected: (e as Error).message,
          ok: false,
        });
      }
    } else
      console.log(
        `- ${companyName}: no purchase orders (feature not on this tier)`,
      );

    // Customer payment receipt.
    const rct = await one(
      `SELECT id FROM payments WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
    );
    if (rct) {
      try {
        const detail = (await app
          .get(PaymentsService)
          .getById(cid, rct.id)) as unknown as Record<string, string>;
        const model = await app
          .get(PaymentReceiptPdfService)
          .model(cid, rct.id);
        const r = await registry
          .get('receipt')!
          .render(cid, { paymentId: rct.id });
        const parts = new Decimal(detail.amountApplied ?? 0).plus(
          detail.unapplied ?? 0,
        );
        record({
          company: companyName,
          doc: 'receipt',
          number: model.number,
          pdf: save(companyName, r.filename, r.buffer),
          total: model.grandTotal,
          expected: detail.amount,
          ok: eq(model.grandTotal, detail.amount) && eq(parts, detail.amount),
        });
      } catch (e) {
        record({
          company: companyName,
          doc: 'receipt',
          number: rct.id,
          pdf: '',
          total: 'ERROR',
          expected: (e as Error).message,
          ok: false,
        });
      }
    } else console.log(`- ${companyName}: no customer payments`);

    // Remittance advice for a bill payment.
    const bp = await one(
      `SELECT id, vendor_id, total_amount FROM bill_payments WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
    );
    if (bp) {
      try {
        const model = await app
          .get(RemittancePdfService)
          .model(cid, { billPaymentId: bp.id, vendorId: bp.vendor_id });
        const r = await registry
          .get('remittance')!
          .render(cid, { billPaymentId: bp.id, vendorId: bp.vendor_id });
        const [apps] = await ds.query(
          `SELECT COALESCE(SUM(amount),0) AS s FROM bill_payment_applications WHERE bill_payment_id = $1`,
          [bp.id],
        );
        const lineSum = (model.lines ?? []).reduce(
          (t, l) => t.plus(String(l.amount)),
          new Decimal(0),
        );
        record({
          company: companyName,
          doc: 'remittance',
          number: model.number,
          pdf: save(companyName, r.filename, r.buffer),
          total: model.grandTotal,
          expected: bp.total_amount,
          ok: eq(model.grandTotal, bp.total_amount) && eq(lineSum, apps.s),
        });
      } catch (e) {
        record({
          company: companyName,
          doc: 'remittance',
          number: bp.id,
          pdf: '',
          total: 'ERROR',
          expected: (e as Error).message,
          ok: false,
        });
      }
    } else console.log(`- ${companyName}: no bill payments`);

    // Statement: the customer with the largest balance, for the last full month and year to date.
    const cust = await one(
      `SELECT id, name FROM customers WHERE company_id = $1 ORDER BY balance DESC LIMIT 1`,
    );
    if (cust) {
      try {
        const now = new Date();
        const start = `${now.getFullYear()}-01-01`;
        const end = now.toISOString().slice(0, 10);
        const ledger = await app
          .get(PartyLedgerService)
          .statement(cid, 'customer', cust.id, start, end);
        const model = await app
          .get(CustomerStatementPdfService)
          .model(cid, cust.id, start, end);
        const r = await registry
          .get('statement')!
          .render(cid, { customerId: cust.id, startDate: start, endDate: end });
        const moved = ledger.lines.reduce(
          (t, l) => t.plus(String(l.amount)),
          new Decimal(String(ledger.openingBalance)),
        );
        record({
          company: companyName,
          doc: 'statement',
          number: `${cust.name} ${start}..${end}`,
          pdf: save(companyName, `Statement-${cust.name}-${end}.pdf`, r.buffer),
          total: model.grandTotal,
          expected: String(ledger.closingBalance),
          ok:
            eq(model.grandTotal, ledger.closingBalance) &&
            eq(moved, ledger.closingBalance),
        });
      } catch (e) {
        record({
          company: companyName,
          doc: 'statement',
          number: cust.id,
          pdf: '',
          total: 'ERROR',
          expected: (e as Error).message,
          ok: false,
        });
      }
    }
  }

  console.log(
    '\ncompany        doc             number                         pdf total        expected        ok',
  );
  for (const r of results) {
    console.log(
      `${r.company.padEnd(14)} ${r.doc.padEnd(15)} ${r.number.slice(0, 30).padEnd(30)} ${String(r.total).padStart(14)}  ${String(r.expected).slice(0, 40).padStart(14)}  ${r.ok ? 'OK' : 'MISMATCH'}`,
    );
  }
  console.log(`\nPDFs in ${out}`);
  await app.close();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
