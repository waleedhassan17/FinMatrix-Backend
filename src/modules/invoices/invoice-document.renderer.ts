import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InvoicesService } from './invoices.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { Customer } from '../customers/entities/customer.entity';
import { Company } from '../companies/entities/company.entity';
import {
  DocumentRenderer,
  DocumentRendererRegistry,
  pdfToBuffer,
  RenderedDocument,
} from '../messaging/document-renderer.registry';

/**
 * The existing invoice PDF (InvoicePdfService, unchanged) as a FinMatrix
 * Connect attachment. Loads exactly what GET /invoices/:id/pdf loads.
 */
@Injectable()
export class InvoiceDocumentRenderer implements DocumentRenderer, OnModuleInit {
  readonly name = 'invoice';

  constructor(
    private readonly registry: DocumentRendererRegistry,
    private readonly invoices: InvoicesService,
    private readonly pdf: InvoicePdfService,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async render(
    companyId: string,
    args: Record<string, unknown>,
  ): Promise<RenderedDocument> {
    const invoice = await this.invoices.getById(
      companyId,
      String(args.invoiceId),
    );
    const customer = await this.dataSource
      .getRepository(Customer)
      .findOneByOrFail({ id: invoice.customerId, companyId });
    const company = await this.dataSource
      .getRepository(Company)
      .findOneByOrFail({ id: companyId });
    const buffer = await pdfToBuffer(
      this.pdf.render(invoice, customer, company),
    );
    return {
      buffer,
      filename: `${invoice.invoiceNumber}.pdf`,
      mimeType: 'application/pdf',
    };
  }
}
