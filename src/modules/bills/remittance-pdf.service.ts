import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import Decimal from 'decimal.js';
import { BillPayment } from './entities/bill-payment.entity';
import { Bill } from './entities/bill.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { Company } from '../companies/entities/company.entity';
import { VendorCredit } from '../vendor-credits/entities/vendor-credit.entity';
import { formatRupees, toDecimal } from '../../common/utils/money.util';
import {
  addressLines,
  companyForPdf,
  DocumentPdfModel,
  joinDots,
  methodLabel,
  pdfDate,
  renderDocumentPdf,
} from '../../common/pdf/document-pdf.util';
import {
  DocumentRenderer,
  DocumentRendererRegistry,
  RenderedDocument,
} from '../messaging/document-renderer.registry';

export interface RemittanceCreditArg {
  vendorCreditId: string;
  billId: string;
  amount: string;
}

/**
 * Remittance advice: what a payment to a vendor settled — the bills applied,
 * any vendor credits applied alongside the cash, the method and reference.
 * Mirrors the web's billPaymentAdviceDocument. Args (stored on the message):
 *   { billPaymentId?, vendorId, credits?: [{vendorCreditId, billId, amount}], date? }
 * A settlement paid entirely from credits has no billPaymentId.
 */
@Injectable()
export class RemittancePdfService implements DocumentRenderer, OnModuleInit {
  readonly name = 'remittance';

  constructor(
    private readonly registry: DocumentRendererRegistry,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async model(
    companyId: string,
    args: Record<string, unknown>,
  ): Promise<DocumentPdfModel & { grandTotal: string; settledTotal: string }> {
    const paymentId = args.billPaymentId ? String(args.billPaymentId) : null;
    const credits = (
      Array.isArray(args.credits) ? args.credits : []
    ) as RemittanceCreditArg[];
    const payment = paymentId
      ? await this.dataSource.getRepository(BillPayment).findOne({
          where: { id: paymentId, companyId },
          relations: { applications: true },
        })
      : null;
    if (paymentId && !payment) throw new Error('Bill payment not found');
    const vendorId = payment?.vendorId ?? String(args.vendorId ?? '');

    const cashByBill = new Map<string, Decimal>();
    for (const a of payment?.applications ?? []) {
      cashByBill.set(
        a.billId,
        (cashByBill.get(a.billId) ?? new Decimal(0)).plus(toDecimal(a.amount)),
      );
    }
    const creditByBill = new Map<string, Decimal>();
    for (const c of credits) {
      creditByBill.set(
        c.billId,
        (creditByBill.get(c.billId) ?? new Decimal(0)).plus(
          toDecimal(c.amount),
        ),
      );
    }
    const billIds = [
      ...new Set([...cashByBill.keys(), ...creditByBill.keys()]),
    ];

    const [bills, vendor, company, vendorCredits] = await Promise.all([
      billIds.length
        ? this.dataSource
            .getRepository(Bill)
            .find({ where: { companyId, id: In(billIds) } })
        : Promise.resolve([] as Bill[]),
      this.dataSource
        .getRepository(Vendor)
        .findOneBy({ id: vendorId, companyId }),
      this.dataSource.getRepository(Company).findOneByOrFail({ id: companyId }),
      credits.length
        ? this.dataSource.getRepository(VendorCredit).find({
            where: {
              companyId,
              id: In([...new Set(credits.map((c) => c.vendorCreditId))]),
            },
          })
        : Promise.resolve([] as VendorCredit[]),
    ]);
    const billById = new Map(bills.map((b) => [b.id, b]));
    const creditNumber = new Map(
      vendorCredits.map((v) => [
        v.id,
        v.vendorCreditNumber ?? v.id.slice(0, 8),
      ]),
    );

    const cash = toDecimal(payment?.totalAmount ?? 0);
    const creditTotal = credits.reduce(
      (t, c) => t.plus(toDecimal(c.amount)),
      new Decimal(0),
    );
    const settled = cash.plus(creditTotal);
    const reference =
      payment?.reference ||
      (payment
        ? `BP-${payment.id.slice(0, 8).toUpperCase()}`
        : 'Credit applied');

    const lines = billIds.map((id) => {
      const bill = billById.get(id);
      const applied = (cashByBill.get(id) ?? new Decimal(0)).plus(
        creditByBill.get(id) ?? 0,
      );
      const remaining = toDecimal(bill?.balance ?? 0);
      return {
        description: `Bill ${bill?.billNumber ?? id.slice(0, 8)}`,
        secondary: remaining.greaterThan('0.005')
          ? `${formatRupees(remaining)} still owing`
          : 'Settled in full',
        amount: applied.toFixed(4),
      };
    });

    const creditNote = credits.length
      ? credits
          .map(
            (c) =>
              `${creditNumber.get(c.vendorCreditId) ?? 'Credit'} (${formatRupees(c.amount)})`,
          )
          .join(', ')
      : null;

    return {
      kind: 'Payment advice',
      number: reference,
      company: companyForPdf(company),
      party: {
        label: 'Paid to',
        name: vendor?.companyName ?? '—',
        lines: [
          vendor?.code ? `Vendor ID ${vendor.code}` : '',
          vendor?.contactPerson ? `Attn: ${vendor.contactPerson}` : '',
          ...addressLines(vendor?.address),
          joinDots(vendor?.phone, vendor?.email),
        ].filter((l) => l.length > 0),
      },
      meta: [
        {
          label: 'Payment date',
          value: pdfDate(
            payment?.paymentDate ?? (args.date as string | undefined) ?? null,
          ),
        },
        {
          label: 'Method',
          value: payment ? methodLabel(payment.paymentMethod) : 'Vendor credit',
        },
        { label: 'Reference', value: reference },
        { label: 'Bills', value: String(lines.length) },
      ],
      showQuantity: false,
      showTax: false,
      lines,
      totals: creditTotal.greaterThan(0)
        ? [
            { label: 'Bills settled', value: settled.toFixed(4) },
            {
              label: 'Your credit applied',
              value: creditTotal.toFixed(4),
              prefix: '− ',
            },
            {
              label: 'Total paid',
              value: cash.toFixed(4),
              grand: true,
              dividerBefore: true,
            },
          ]
        : [{ label: 'Total paid', value: cash.toFixed(4), grand: true }],
      notes: [{ title: 'Vendor credits applied', text: creditNote }],
      signatures: ['Authorised signature'],
      stamp: null,
      grandTotal: cash.toFixed(4),
      settledTotal: settled.toFixed(4),
    };
  }

  async render(
    companyId: string,
    args: Record<string, unknown>,
  ): Promise<RenderedDocument> {
    const model = await this.model(companyId, args);
    const safe = model.number.replace(/[^\w.-]+/g, '-');
    return {
      buffer: await renderDocumentPdf(model),
      filename: `Remittance-${safe}.pdf`,
      mimeType: 'application/pdf',
    };
  }
}
