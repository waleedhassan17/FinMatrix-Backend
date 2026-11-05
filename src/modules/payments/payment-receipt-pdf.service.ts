import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Customer } from '../customers/entities/customer.entity';
import { Company } from '../companies/entities/company.entity';
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

/**
 * A customer's payment as the receipt they are given — the web's
 * paymentReceiptDocument (src/features/documents/receiptBuilders.ts).
 */
@Injectable()
export class PaymentReceiptPdfService
  implements DocumentRenderer, OnModuleInit
{
  readonly name = 'receipt';

  constructor(
    private readonly registry: DocumentRendererRegistry,
    private readonly payments: PaymentsService,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async model(
    companyId: string,
    paymentId: string,
  ): Promise<DocumentPdfModel & { grandTotal: string }> {
    const p = await this.payments.getById(companyId, paymentId);
    const [customer, company] = await Promise.all([
      this.dataSource
        .getRepository(Customer)
        .findOneBy({ id: p.customerId, companyId }),
      this.dataSource.getRepository(Company).findOneByOrFail({ id: companyId }),
    ]);
    const number =
      p.paymentNumber || p.reference || `RCT-${p.id.slice(0, 8).toUpperCase()}`;
    const apps = p.applications ?? [];
    const lines =
      apps.length > 0
        ? apps.map((a) => {
            const total = (a as { invoiceTotal?: string | null }).invoiceTotal;
            const balance = (a as { invoiceBalance?: string | null })
              .invoiceBalance;
            const num = (a as { invoiceNumber?: string }).invoiceNumber;
            return {
              description: `Invoice ${num || a.invoiceId.slice(0, 8)}`,
              secondary:
                total !== null &&
                total !== undefined &&
                balance !== null &&
                balance !== undefined
                  ? `Invoice total ${formatRupees(total)} · ${
                      toDecimal(balance).greaterThan('0.005')
                        ? `${formatRupees(balance)} still owing`
                        : 'settled in full'
                    }`
                  : 'Applied to invoice',
              amount: a.amountApplied,
            };
          })
        : [
            {
              description: 'Payment on account',
              secondary: 'Held as customer advance',
              amount: p.amount,
            },
          ];
    const unapplied = toDecimal((p as { unapplied?: string }).unapplied ?? 0);
    return {
      kind: 'Payment receipt',
      number,
      company: companyForPdf(company),
      party: {
        label: 'Received from',
        name: customer?.name ?? '—',
        lines: [
          customer?.code ? `Customer ID ${customer.code}` : '',
          customer?.company && customer.company !== customer.name
            ? customer.company
            : '',
          ...addressLines(customer?.billingAddress),
          joinDots(customer?.phone, customer?.email),
        ].filter((l) => l.length > 0),
      },
      meta: [
        { label: 'Receipt date', value: pdfDate(p.paymentDate) },
        { label: 'Method', value: methodLabel(p.paymentMethod) },
        { label: 'Reference', value: p.reference ?? '' },
      ],
      showQuantity: false,
      showTax: false,
      lines,
      totals: [
        {
          label: 'Applied to invoices',
          value: (p as { amountApplied?: string }).amountApplied ?? '0',
        },
        ...(unapplied.greaterThan(0)
          ? [{ label: 'Held as advance', value: unapplied.toFixed(4) }]
          : []),
        {
          label: 'Amount received',
          value: p.amount,
          grand: true,
          dividerBefore: true,
        },
      ],
      notes: [{ title: 'Notes', text: p.memo }],
      signatures: ['Received by'],
      stamp: null,
      grandTotal: p.amount,
    };
  }

  async render(
    companyId: string,
    args: Record<string, unknown>,
  ): Promise<RenderedDocument> {
    const model = await this.model(companyId, String(args.paymentId));
    return {
      buffer: await renderDocumentPdf(model),
      filename: `${model.number}.pdf`,
      mimeType: 'application/pdf',
    };
  }
}
