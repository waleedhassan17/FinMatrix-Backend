import Decimal from 'decimal.js';
import { formatRupees, toDecimal } from '../../common/utils/money.util';
import { pdfDate } from '../../common/pdf/document-pdf.util';
import { EnqueueInput } from './messaging.service';
import { REMINDER_EVENTS } from './messaging.constants';

/**
 * What each accounting event sends, built from the document the service just
 * saved. Kept here so every hook in an accounting service is ONE call:
 *
 *   await this.messaging.enqueue(manager, invoiceIssuedMessage(invoice, userId));
 *
 * A builder returns null when the event sends nothing (enqueue(null) is a
 * no-op). Only ids and display values go on the row; the PDF is rendered by
 * the dispatcher later, from the stored ids.
 */

/** `deliver` from a request: false = do not send, true = send even if the rule says "ask". */
export interface DeliverOption {
  whatsapp?: boolean;
}

interface InvoiceLike {
  id: string;
  companyId: string;
  customerId: string;
  invoiceNumber: string;
  total: string;
  dueDate?: string | null;
}

export function invoiceIssuedMessage(
  invoice: InvoiceLike,
  userId: string | null,
  deliver?: DeliverOption | null,
): EnqueueInput | null {
  if (deliver?.whatsapp === false) return null;
  return {
    companyId: invoice.companyId,
    event: 'invoice_issued',
    docType: 'invoice',
    docId: invoice.id,
    recipient: { type: 'customer', id: invoice.customerId },
    params: {
      invoiceNumber: invoice.invoiceNumber,
      total: formatRupees(invoice.total),
      dueDate: pdfDate(invoice.dueDate) || 'on receipt',
    },
    attachment: {
      renderer: 'invoice',
      args: { invoiceId: invoice.id, filename: `${invoice.invoiceNumber}.pdf` },
    },
    createdBy: userId,
    explicit: deliver?.whatsapp === true,
  };
}

/** Sent only if the customer was actually sent the invoice (or a reminder about it). */
export function invoiceCancelledMessage(
  invoice: InvoiceLike,
  userId: string | null,
): EnqueueInput {
  return {
    companyId: invoice.companyId,
    event: 'invoice_cancelled',
    docType: 'invoice',
    docId: invoice.id,
    recipient: { type: 'customer', id: invoice.customerId },
    params: {
      invoiceNumber: invoice.invoiceNumber,
      total: formatRupees(invoice.total),
    },
    createdBy: userId,
    requireSent: {
      docType: 'invoice',
      docId: invoice.id,
      events: ['invoice_issued', 'invoice_revised', ...REMINDER_EVENTS],
    },
  };
}

export function paymentReceivedMessage(
  payment: {
    id: string;
    companyId: string;
    customerId: string;
    paymentNumber: string | null;
    amount: string;
  },
  customerBalanceAfter: string,
  userId: string | null,
): EnqueueInput {
  const number =
    payment.paymentNumber || `RCT-${payment.id.slice(0, 8).toUpperCase()}`;
  return {
    companyId: payment.companyId,
    event: 'payment_received',
    docType: 'payment',
    docId: payment.id,
    recipient: { type: 'customer', id: payment.customerId },
    params: {
      amount: formatRupees(payment.amount),
      receiptNumber: number,
      balance: formatRupees(customerBalanceAfter),
    },
    attachment: {
      renderer: 'receipt',
      args: { paymentId: payment.id, filename: `${number}.pdf` },
    },
    createdBy: userId,
  };
}

interface PoLike {
  id: string;
  companyId: string;
  vendorId: string;
  poNumber: string;
  total: string;
  expectedDate?: string | null;
  status: string;
}

/** A PO went to the vendor (draft -> sent). A reopen (closed -> sent) sends nothing. */
export function isPoIssue(previous: string, next: string) {
  return previous === 'draft' && next === 'sent';
}

/** A PO the vendor had was withdrawn: back to requisition, or closed with nothing received. */
export function isPoWithdrawal(
  previous: string,
  next: string,
  anyReceived: boolean,
) {
  if (previous === 'sent' && next === 'draft') return true;
  return (
    next === 'closed' &&
    previous !== 'draft' &&
    previous !== 'closed' &&
    !anyReceived
  );
}

export function purchaseOrderStatusMessage(
  po: PoLike,
  previousStatus: string,
  anyReceived: boolean,
  opts: { userId?: string | null; deliver?: DeliverOption | null } = {},
): EnqueueInput | null {
  if (opts.deliver?.whatsapp === false) return null;
  if (isPoIssue(previousStatus, po.status)) {
    return {
      companyId: po.companyId,
      event: 'po_issued',
      docType: 'purchase_order',
      docId: po.id,
      recipient: { type: 'vendor', id: po.vendorId },
      params: {
        poNumber: po.poNumber,
        total: formatRupees(po.total),
        expectedDate: pdfDate(po.expectedDate) || 'as agreed',
      },
      attachment: {
        renderer: 'purchase_order',
        args: { purchaseOrderId: po.id, filename: `${po.poNumber}.pdf` },
      },
      createdBy: opts.userId ?? null,
      explicit: opts.deliver?.whatsapp === true,
      // Sent, withdrawn and sent again is a second PO to the vendor.
      autoVersion: true,
    };
  }
  if (isPoWithdrawal(previousStatus, po.status, anyReceived)) {
    return {
      companyId: po.companyId,
      event: 'po_cancelled',
      docType: 'purchase_order',
      docId: po.id,
      recipient: { type: 'vendor', id: po.vendorId },
      params: { poNumber: po.poNumber },
      createdBy: opts.userId ?? null,
      autoVersion: true,
      requireSent: {
        docType: 'purchase_order',
        docId: po.id,
        events: ['po_issued'],
      },
    };
  }
  return null;
}

/**
 * Remittance advice for money paid to a vendor. From payInTransaction the
 * advice covers the cash payment; settle() calls this again with the vendor
 * credits it applied and `merge`, replacing that queued row with ONE advice
 * covering credit + cash (decision D2). A settlement paid only from credits
 * has no payment: docType bill_settlement with its own id.
 */
export function remittanceMessage(input: {
  companyId: string;
  vendorId: string;
  userId: string | null;
  payment: {
    id: string;
    totalAmount: string;
    reference: string | null;
    applications?: Array<{ billId: string }>;
  } | null;
  credits?: Array<{ vendorCreditId: string; billId: string; amount: string }>;
  settlementId?: string;
  paymentDate?: string;
  merge?: boolean;
}): EnqueueInput | null {
  const credits = input.credits ?? [];
  if (!input.payment && credits.length === 0) return null;
  const creditTotal = credits.reduce(
    (t, c) => t.plus(toDecimal(c.amount)),
    new Decimal(0),
  );
  const cash = toDecimal(input.payment?.totalAmount ?? 0);
  const billIds = [
    ...new Set([
      ...(input.payment?.applications ?? []).map((a) => a.billId),
      ...credits.map((c) => c.billId),
    ]),
  ];
  const reference =
    input.payment?.reference ||
    (input.payment
      ? `BP-${input.payment.id.slice(0, 8).toUpperCase()}`
      : 'Credit applied');
  const docId = input.payment?.id ?? input.settlementId;
  if (!docId) return null;
  return {
    companyId: input.companyId,
    event: 'remittance',
    docType: input.payment ? 'bill_payment' : 'bill_settlement',
    docId,
    recipient: { type: 'vendor', id: input.vendorId },
    params: {
      amount: formatRupees(cash.plus(creditTotal)),
      reference,
    },
    lookups: { billNumbers: { param: 'bills', ids: billIds } },
    attachment: {
      renderer: 'remittance',
      args: {
        billPaymentId: input.payment?.id ?? null,
        vendorId: input.vendorId,
        credits,
        date: input.paymentDate ?? null,
        filename: `Remittance-${reference}.pdf`,
      },
    },
    createdBy: input.userId,
    mergeIntoQueued: input.merge === true,
  };
}

/** One alert per active company admin (see MessagingService.enqueueForAdmins). */
export function approvalPendingMessage(
  request: { id: string; companyId: string; summary: string },
  requesterUserId: string,
): Omit<EnqueueInput, 'recipient'> {
  return {
    companyId: request.companyId,
    event: 'approval_pending',
    docType: 'approval_request',
    docId: request.id,
    params: { summary: request.summary, approvalPath: request.id },
    lookups: { userName: { param: 'requester', userId: requesterUserId } },
    createdBy: requesterUserId,
  };
}

const DELIVERY_TEXT: Record<string, { version: number; text: string }> = {
  picked_up: {
    version: 1,
    text: 'your order has been picked up and will be on its way soon',
  },
  in_transit: { version: 2, text: 'your order is on its way' },
  // Only the owner's approval confirms a hand-over; a rider's own "delivered"
  // is not in this map and sends nothing.
  approved: { version: 3, text: 'your order has been delivered. Thank you' },
};

export function deliveryUpdateMessage(
  delivery:
    | {
        id: string;
        companyId: string;
        customerId: string;
        referenceNo: string | null;
      }
    | null
    | undefined,
  status: string,
  userId: string | null,
): EnqueueInput | null {
  const step = DELIVERY_TEXT[status];
  if (!delivery || !step || !delivery.customerId) return null;
  return {
    companyId: delivery.companyId,
    event: 'delivery_update',
    docType: 'delivery',
    docId: delivery.id,
    docVersion: step.version,
    recipient: { type: 'customer', id: delivery.customerId },
    params: {
      deliveryNumber:
        delivery.referenceNo || delivery.id.slice(0, 8).toUpperCase(),
      statusText: step.text,
    },
    createdBy: userId,
  };
}
