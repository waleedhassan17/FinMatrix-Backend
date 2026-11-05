import type {
  MessageEventOrTest,
  MessageLanguage,
} from '../messaging.constants';

/**
 * WhatsApp message templates FinMatrix Connect sends. Each must be created on
 * the WhatsApp Business Account and APPROVED by Meta before it can be sent
 * (`npm run messaging:templates:sync` creates missing ones; it never deletes).
 *
 * Rules every template here follows:
 * - category UTILITY (transactional, about a document the recipient has);
 * - body parameters are positional ({{1}}, {{2}}…) in `params` order, and
 *   {{1}} is ALWAYS the sending company's name, so every message names who it
 *   is from even on the shared FinMatrix number;
 * - footer "Sent via FinMatrix";
 * - English and Urdu. URDU TEXT NEEDS NATIVE REVIEW before submission.
 */

export type HeaderType = 'NONE' | 'TEXT' | 'DOCUMENT';

export interface TemplateText {
  body: string;
  /** For header type TEXT only. */
  header?: string;
  /** URL button label, when the template has one. */
  button?: string;
}

export interface TemplateDef {
  name: string;
  event: MessageEventOrTest;
  category: 'UTILITY';
  header: HeaderType;
  /** Named params, in body placeholder order ({{1}} = params[0] = company). */
  params: string[];
  /** One URL button whose last path segment is a parameter. */
  urlButton?: { param: string; baseUrlExample: string };
  footer: string;
  text: Record<MessageLanguage, TemplateText>;
  /** Sample values Meta requires when a template is submitted. */
  example: Record<string, string>;
}

const FOOTER = 'Sent via FinMatrix';

/** NEEDS NATIVE REVIEW — every Urdu string below. */
const UR_REVIEW = 'NEEDS NATIVE REVIEW';

export const TEMPLATES: TemplateDef[] = [
  {
    name: 'fm_invoice_issued',
    event: 'invoice_issued',
    category: 'UTILITY',
    header: 'DOCUMENT',
    params: ['company', 'recipientName', 'invoiceNumber', 'total', 'dueDate'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, {{1}} has sent you invoice {{3}} for {{4}}, due on {{5}}. The invoice is attached.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} نے آپ کو انوائس {{3}} بھیجی ہے، رقم {{4}}، ادائیگی کی آخری تاریخ {{5}}۔ انوائس منسلک ہے۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      invoiceNumber: 'INV-0042',
      total: 'Rs 12,500.00',
      dueDate: '15 Nov 2026',
    },
  },
  {
    name: 'fm_invoice_revised',
    event: 'invoice_revised',
    category: 'UTILITY',
    header: 'DOCUMENT',
    params: ['company', 'recipientName', 'invoiceNumber', 'total', 'dueDate'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, {{1}} has revised invoice {{3}}. The new total is {{4}}, due on {{5}}. The revised invoice is attached and replaces the earlier one.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} نے انوائس {{3}} میں ترمیم کی ہے۔ نئی رقم {{4}} ہے، آخری تاریخ {{5}}۔ ترمیم شدہ انوائس منسلک ہے اور پچھلی انوائس کی جگہ لیتی ہے۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      invoiceNumber: 'INV-0042',
      total: 'Rs 13,000.00',
      dueDate: '15 Nov 2026',
    },
  },
  {
    name: 'fm_invoice_cancelled',
    event: 'invoice_cancelled',
    category: 'UTILITY',
    header: 'NONE',
    params: ['company', 'recipientName', 'invoiceNumber', 'total'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, {{1}} has cancelled invoice {{3}} for {{4}}. You do not need to pay it.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} نے انوائس {{3}} (رقم {{4}}) منسوخ کر دی ہے۔ آپ کو اس کی ادائیگی کی ضرورت نہیں۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      invoiceNumber: 'INV-0042',
      total: 'Rs 12,500.00',
    },
  },
  {
    name: 'fm_payment_received',
    event: 'payment_received',
    category: 'UTILITY',
    header: 'DOCUMENT',
    params: ['company', 'recipientName', 'amount', 'receiptNumber', 'balance'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, {{1}} has received your payment of {{3}} (receipt {{4}}). Your balance is now {{5}}. The receipt is attached. Thank you.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} کو آپ کی {{3}} کی ادائیگی موصول ہو گئی ہے (رسید {{4}})۔ آپ کا موجودہ بقایا {{5}} ہے۔ رسید منسلک ہے۔ شکریہ۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      amount: 'Rs 5,000.00',
      receiptNumber: 'RCT-0017',
      balance: 'Rs 7,500.00',
    },
  },
  {
    name: 'fm_reminder_upcoming',
    event: 'reminder_upcoming',
    category: 'UTILITY',
    header: 'NONE',
    params: ['company', 'recipientName', 'invoiceNumber', 'balance', 'dueDate'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, a reminder from {{1}}: invoice {{3}} has {{4}} outstanding, due on {{5}}. Please ignore this if you have already paid.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} کی طرف سے یاددہانی: انوائس {{3}} پر {{4}} واجب الادا ہے، آخری تاریخ {{5}}۔ اگر آپ ادائیگی کر چکے ہیں تو اس پیغام کو نظرانداز کریں۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      invoiceNumber: 'INV-0042',
      balance: 'Rs 12,500.00',
      dueDate: '15 Nov 2026',
    },
  },
  {
    name: 'fm_reminder_overdue',
    event: 'reminder_overdue',
    category: 'UTILITY',
    header: 'DOCUMENT',
    params: ['company', 'recipientName', 'invoiceNumber', 'balance', 'dueDate'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, {{1}} reminds you that invoice {{3}} with {{4}} outstanding was due on {{5}}. The invoice is attached. Please ignore this if you have already paid.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} آپ کو یاد دلاتا ہے کہ انوائس {{3}} جس پر {{4}} واجب الادا ہے، {{5}} کو قابل ادائیگی تھی۔ انوائس منسلک ہے۔ اگر آپ ادائیگی کر چکے ہیں تو اسے نظرانداز کریں۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      invoiceNumber: 'INV-0042',
      balance: 'Rs 12,500.00',
      dueDate: '15 Oct 2026',
    },
  },
  {
    name: 'fm_statement',
    event: 'statement',
    category: 'UTILITY',
    header: 'DOCUMENT',
    params: ['company', 'recipientName', 'period', 'closingBalance'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, your statement from {{1}} for {{3}} is attached. Balance at the end of the period: {{4}}.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} کی طرف سے {{3}} کا آپ کا اسٹیٹمنٹ منسلک ہے۔ مدت کے اختتام پر بقایا: {{4}}۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      period: 'October 2026',
      closingBalance: 'Rs 12,500.00',
    },
  },
  {
    name: 'fm_po_issued',
    event: 'po_issued',
    category: 'UTILITY',
    header: 'DOCUMENT',
    params: ['company', 'recipientName', 'poNumber', 'total', 'expectedDate'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, {{1}} has placed purchase order {{3}} for {{4}}, expected by {{5}}. The purchase order is attached.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} نے خریداری آرڈر {{3}} دیا ہے، رقم {{4}}، متوقع تاریخ {{5}}۔ خریداری آرڈر منسلک ہے۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Bilal',
      poNumber: 'PO-0009',
      total: 'Rs 80,000.00',
      expectedDate: '20 Nov 2026',
    },
  },
  {
    name: 'fm_po_cancelled',
    event: 'po_cancelled',
    category: 'UTILITY',
    header: 'NONE',
    params: ['company', 'recipientName', 'poNumber'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, {{1}} has withdrawn purchase order {{3}}. Please do not ship against it.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} نے خریداری آرڈر {{3}} واپس لے لیا ہے۔ براہ کرم اس کے تحت مال نہ بھیجیں۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Bilal',
      poNumber: 'PO-0009',
    },
  },
  {
    name: 'fm_remittance',
    event: 'remittance',
    category: 'UTILITY',
    header: 'DOCUMENT',
    params: ['company', 'recipientName', 'amount', 'bills', 'reference'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, {{1}} has settled {{3}} against {{4}} (reference {{5}}). The remittance advice is attached.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} نے {{4}} کے عوض {{3}} ادا کر دیے ہیں (حوالہ {{5}})۔ ادائیگی کی تفصیل منسلک ہے۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Bilal',
      amount: 'Rs 80,000.00',
      bills: 'BILL-0031, BILL-0032',
      reference: 'BP-0012',
    },
  },
  {
    name: 'fm_approval_pending',
    event: 'approval_pending',
    category: 'UTILITY',
    header: 'NONE',
    params: ['company', 'requester', 'summary'],
    urlButton: {
      param: 'approvalPath',
      baseUrlExample: 'https://finmatrix-theta.vercel.app/approvals/',
    },
    footer: FOOTER,
    text: {
      en: {
        body: '{{1}}: a request from {{2}} is waiting for your approval: {{3}}.',
        button: 'Review request',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: '{{1}}: {{2}} کی درخواست آپ کی منظوری کی منتظر ہے: {{3}}۔',
        button: 'درخواست دیکھیں',
      },
    },
    example: {
      company: 'Warehouse Co',
      requester: 'Sana (staff)',
      summary: 'Pay bills to Karachi Steel, Rs 80,000.00',
      approvalPath: '3f2c1d4e-0000-4000-8000-000000000000',
    },
  },
  {
    name: 'fm_delivery_update',
    event: 'delivery_update',
    category: 'UTILITY',
    header: 'NONE',
    params: ['company', 'recipientName', 'deliveryNumber', 'statusText'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Dear {{2}}, an update from {{1}} on delivery {{3}}: {{4}}.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'محترم {{2}}، {{1}} کی طرف سے ڈیلیوری {{3}} کے بارے میں اطلاع: {{4}}۔',
      },
    },
    example: {
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      deliveryNumber: 'DLV-0101',
      statusText: 'your order is on its way',
    },
  },
  {
    name: 'fm_test',
    event: 'test',
    category: 'UTILITY',
    header: 'NONE',
    params: ['company', 'recipientName'],
    footer: FOOTER,
    text: {
      en: {
        body: 'Hello {{2}}, this is a test message from {{1}} on FinMatrix Connect. WhatsApp delivery is working.',
      },
      ur: {
        // NEEDS NATIVE REVIEW
        body: 'السلام علیکم {{2}}، یہ {{1}} کی طرف سے FinMatrix Connect کا آزمائشی پیغام ہے۔ واٹس ایپ پیغام رسانی کام کر رہی ہے۔',
      },
    },
    example: { company: 'Warehouse Co', recipientName: 'Waleed' },
  },
];

export const URDU_REVIEW_NOTE = UR_REVIEW;

const BY_EVENT = new Map<string, TemplateDef>(
  TEMPLATES.map((t) => [t.event, t]),
);
const BY_NAME = new Map<string, TemplateDef>(TEMPLATES.map((t) => [t.name, t]));

export function templateForEvent(event: MessageEventOrTest): TemplateDef {
  const t = BY_EVENT.get(event);
  if (!t) throw new Error(`No WhatsApp template for event ${event}`);
  return t;
}

export function templateByName(name: string): TemplateDef | undefined {
  return BY_NAME.get(name);
}

/**
 * Body parameter values in placeholder order. WhatsApp refuses empty values
 * and values containing new lines, tabs or more than four spaces in a row, so
 * those are normalised here rather than failing at Meta.
 */
export function bodyParameters(
  t: TemplateDef,
  params: Record<string, unknown>,
): string[] {
  return t.params.map((key) => cleanParam(params[key]));
}

export function cleanParam(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  const cleaned = s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, 1000);
  return cleaned === '' ? '-' : cleaned;
}

/** The message text a person would read (for the timeline and the fake provider log). */
export function renderPreview(
  t: TemplateDef,
  language: MessageLanguage,
  params: Record<string, unknown>,
): string {
  const values = bodyParameters(t, params);
  const body = (t.text[language] ?? t.text.en).body;
  return body.replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => values[Number(n) - 1] ?? '',
  );
}
