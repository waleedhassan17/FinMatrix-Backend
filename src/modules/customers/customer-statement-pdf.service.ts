import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PartyLedgerService } from '../ledger/party-ledger.service';
import { Customer } from './entities/customer.entity';
import { Company } from '../companies/entities/company.entity';
import { formatRupees } from '../../common/utils/money.util';
import {
  addressLines,
  companyForPdf,
  DocumentPdfModel,
  joinDots,
  pdfDate,
  renderDocumentPdf,
} from '../../common/pdf/document-pdf.util';
import {
  DocumentRenderer,
  DocumentRendererRegistry,
  RenderedDocument,
} from '../messaging/document-renderer.registry';

/**
 * A customer statement for a period. Every figure comes from
 * PartyLedgerService.statement — the same query behind
 * GET /customers/:id/ledger-statement — so no balance is computed here.
 * Args: { customerId, startDate, endDate } (ISO dates).
 */
@Injectable()
export class CustomerStatementPdfService
  implements DocumentRenderer, OnModuleInit
{
  readonly name = 'statement';

  constructor(
    private readonly registry: DocumentRendererRegistry,
    private readonly ledger: PartyLedgerService,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async model(
    companyId: string,
    customerId: string,
    startDate: string,
    endDate: string,
  ): Promise<DocumentPdfModel & { grandTotal: string }> {
    const s = await this.ledger.statement(
      companyId,
      'customer',
      customerId,
      startDate,
      endDate,
    );
    const [customer, company] = await Promise.all([
      this.dataSource
        .getRepository(Customer)
        .findOneBy({ id: customerId, companyId }),
      this.dataSource.getRepository(Company).findOneByOrFail({ id: companyId }),
    ]);
    const rows: string[][] = [
      [
        pdfDate(startDate),
        'Opening balance',
        '',
        '',
        formatRupees(s.openingBalance),
      ],
      ...s.lines.map((l) => [
        pdfDate(l.date),
        l.label,
        l.reference ?? '',
        formatRupees(l.amount),
        formatRupees(l.balance),
      ]),
    ];
    return {
      kind: 'Statement',
      number: `${pdfDate(startDate)} – ${pdfDate(endDate)}`,
      company: companyForPdf(company),
      party: {
        label: 'Statement for',
        name: customer?.name ?? s.party?.name ?? '—',
        lines: [
          customer?.code ? `Customer ID ${customer.code}` : '',
          ...addressLines(customer?.billingAddress),
          joinDots(customer?.phone, customer?.email),
        ].filter((l) => l.length > 0),
      },
      meta: [
        { label: 'From', value: pdfDate(startDate) },
        { label: 'To', value: pdfDate(endDate) },
      ],
      table: {
        headers: ['Date', 'Details', 'Reference', 'Amount', 'Balance'],
        widths: [0.15, 0.31, 0.2, 0.17, 0.17],
        align: ['left', 'left', 'left', 'right', 'right'],
        rows,
      },
      totals: [
        { label: 'Opening balance', value: s.openingBalance },
        {
          label: 'Balance due',
          value: s.closingBalance,
          grand: true,
          dividerBefore: true,
        },
      ],
      notes: [],
      stamp: null,
      grandTotal: String(s.closingBalance),
    };
  }

  async render(
    companyId: string,
    args: Record<string, unknown>,
  ): Promise<RenderedDocument> {
    const start = String(args.startDate);
    const end = String(args.endDate);
    const model = await this.model(
      companyId,
      String(args.customerId),
      start,
      end,
    );
    return {
      buffer: await renderDocumentPdf(model),
      filename: `Statement-${end.slice(0, 7)}.pdf`,
      mimeType: 'application/pdf',
    };
  }
}
