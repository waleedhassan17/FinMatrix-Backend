import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PurchaseOrdersService } from './purchase-orders.service';
import { Vendor } from '../vendors/entities/vendor.entity';
import { Company } from '../companies/entities/company.entity';
import {
  addressLines,
  companyForPdf,
  DocumentPdfModel,
  joinDots,
  pdfDate,
  qty,
  renderDocumentPdf,
  termsLabel,
} from '../../common/pdf/document-pdf.util';
import {
  DocumentRenderer,
  DocumentRendererRegistry,
  RenderedDocument,
} from '../messaging/document-renderer.registry';

/**
 * A purchase order as the vendor receives it — the web's purchaseOrderDocument
 * (FinMatrix-Website src/features/documents/documentBuilders.ts) on the server.
 */
@Injectable()
export class PurchaseOrderPdfService implements DocumentRenderer, OnModuleInit {
  readonly name = 'purchase_order';

  constructor(
    private readonly registry: DocumentRendererRegistry,
    private readonly orders: PurchaseOrdersService,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async model(
    companyId: string,
    purchaseOrderId: string,
  ): Promise<DocumentPdfModel & { grandTotal: string }> {
    const po = await this.orders.getById(companyId, purchaseOrderId);
    const [vendor, company] = await Promise.all([
      this.dataSource
        .getRepository(Vendor)
        .findOneBy({ id: po.vendorId, companyId }),
      this.dataSource.getRepository(Company).findOneByOrFail({ id: companyId }),
    ]);
    const requisition = po.status === 'draft';
    return {
      kind: requisition ? 'Purchase requisition' : 'Purchase order',
      number: po.poNumber,
      company: companyForPdf(company),
      party: {
        label: 'Vendor',
        name: vendor?.companyName ?? '—',
        lines: [
          vendor?.code ? `Vendor ID ${vendor.code}` : '',
          vendor?.contactPerson ? `Attn: ${vendor.contactPerson}` : '',
          ...addressLines(vendor?.address),
          joinDots(vendor?.phone, vendor?.email),
          vendor?.taxId ? `NTN ${vendor.taxId}` : '',
        ].filter((l) => l.length > 0),
      },
      meta: [
        { label: requisition ? 'Requisition #' : 'PO #', value: po.poNumber },
        { label: 'Order date', value: pdfDate(po.orderDate) },
        { label: 'Expected delivery', value: pdfDate(po.expectedDate) },
        { label: 'Terms', value: termsLabel(vendor?.paymentTerms) },
      ],
      showQuantity: true,
      showTax: true,
      quantityHeader: 'Qty',
      priceHeader: 'Unit cost',
      lines: po.lines.map((l) => ({
        description: l.description,
        quantity: qty(l.orderedQty),
        unitPrice: l.unitCost,
        taxRate: l.taxRate,
        amount: l.lineTotal,
      })),
      totals: [
        { label: 'Subtotal', value: po.subtotal },
        { label: 'Tax', value: po.taxAmount },
        { label: 'Total', value: po.total, grand: true, dividerBefore: true },
      ],
      notes: [{ title: 'Notes', text: po.notes }],
      signatures: requisition
        ? ['Requested by', 'Approved by']
        : ['Prepared by', 'Authorised signature'],
      stamp: po.status === 'closed' ? 'Closed' : null,
      grandTotal: po.total,
    };
  }

  async render(
    companyId: string,
    args: Record<string, unknown>,
  ): Promise<RenderedDocument> {
    const model = await this.model(companyId, String(args.purchaseOrderId));
    return {
      buffer: await renderDocumentPdf(model),
      filename: `${model.number}.pdf`,
      mimeType: 'application/pdf',
    };
  }
}
