import { DataSource } from 'typeorm';
import { PartyLedgerRow, PartyLedgerService } from './party-ledger.service';

const CUSTOMER = 'c0000000-0000-0000-0000-000000000001';
const OTHER = 'c0000000-0000-0000-0000-000000000002';

let seq = 0;
const row = (over: Partial<PartyLedgerRow>): PartyLedgerRow => ({
  id: `gl-${++seq}`,
  date: '2026-07-01',
  postedAt: '2026-07-01T10:00:00.000Z',
  reference: `JE-${seq}`,
  entryId: `je-${seq}`,
  voided: false,
  accountCode: '1100',
  accountName: 'Accounts Receivable',
  memo: '',
  debit: 0,
  credit: 0,
  postingType: 'invoice',
  sourceId: `doc-${seq}`,
  documentType: 'invoice',
  documentId: `doc-${seq}`,
  documentNumber: null,
  partyId: CUSTOMER,
  ...over,
});

/** A service whose book is the rows given, with the party directory stubbed. */
function serviceWith(
  rows: PartyLedgerRow[],
  opening: Array<[string | null, number]> = [],
) {
  const service = new PartyLedgerService({} as DataSource);
  const directory = [
    {
      id: CUSTOMER,
      code: 'C-0007',
      name: 'Ali Traders',
      email: null,
      isActive: true,
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: OTHER,
      code: 'C-0010',
      name: 'Bismillah Mart',
      email: null,
      isActive: true,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];
  jest.spyOn(service, 'rows').mockResolvedValue({
    opening: new Map(opening),
    rows,
    accounts: [
      { id: 'a1', code: '1100', name: 'Accounts Receivable' },
      { id: 'a2', code: '2400', name: 'Customer Advances' },
    ],
  });
  jest
    .spyOn(service, 'directory')
    .mockImplementation(async (_c, _t, ids) =>
      directory.filter((p) => !ids || ids.includes(p.id)),
    );
  return service;
}

describe('PartyLedgerService', () => {
  describe('ledger — the General Ledger read by party', () => {
    it('carries a running balance per party from its opening balance, debit-positive', async () => {
      const service = serviceWith(
        [
          row({ debit: 3000, documentNumber: 'INV-1' }),
          row({ partyId: OTHER, debit: 500 }),
          row({
            postingType: 'payment',
            documentType: 'payment',
            credit: 2000,
            documentNumber: 'RCT-1',
          }),
        ],
        [[CUSTOMER, 1000]],
      );
      const result = await service.ledger(
        'co',
        'customer',
        '2026-07-01',
        '2026-07-31',
      );

      const mine = result.entries
        .filter((e) => e.partyId === CUSTOMER)
        .map((e) => e.balance);
      expect(mine).toEqual([4000, 2000]);
      expect(result.entries[0]).toMatchObject({
        label: 'Invoice',
        partyCode: 'C-0007',
        sourceType: 'journal_entry',
      });
      expect(
        result.closingBalances.map((b) => [b.partyCode, b.balance]),
      ).toEqual([
        ['C-0007', 2000],
        ['C-0010', 500],
      ]);
      expect(result.totals).toEqual({ debit: 3500, credit: 2000 });
    });

    it('ties every customer to the control accounts and names what no customer holds', async () => {
      const service = serviceWith(
        [
          row({ debit: 3000 }),
          // A journal straight to 1100: no party.
          row({
            partyId: null,
            postingType: 'journal_entry',
            documentType: null,
            debit: 250,
          }),
        ],
        [
          [CUSTOMER, 1000],
          [null, -100],
        ],
      );
      const result = await service.ledger(
        'co',
        'customer',
        '2026-07-01',
        '2026-07-31',
      );

      expect(result.control).toMatchObject({
        linked: 4000,
        unlinked: 150,
        balance: 4150,
      });
      // The unlinked journal is not shown as anyone's line.
      expect(result.entries).toHaveLength(1);
    });
  });

  describe('statement — what is sent to the party', () => {
    it('makes one line of a receipt split between A/R and Customer Advances', async () => {
      const service = serviceWith([
        row({
          debit: 1000,
          reference: 'JE-1',
          sourceId: 'inv-1',
          documentNumber: 'INV-1',
        }),
        row({
          postingType: 'payment',
          documentType: 'payment',
          reference: 'JE-2',
          sourceId: 'rct-1',
          credit: 600,
          documentNumber: 'RCT-1',
        }),
        row({
          postingType: 'payment',
          documentType: 'payment',
          reference: 'JE-2',
          sourceId: 'rct-1',
          accountCode: '2400',
          credit: 400,
          documentNumber: 'RCT-1',
        }),
      ]);
      const s = await service.statement(
        'co',
        'customer',
        CUSTOMER,
        '2026-07-01',
        '2026-07-31',
      );

      expect(
        s.lines.map((l) => [l.kind, l.reference, l.amount, l.balance]),
      ).toEqual([
        ['invoice', 'INV-1', 1000, 1000],
        ['payment', 'RCT-1', -1000, 0],
      ]);
      expect(s.totals).toMatchObject({ invoiced: 1000, received: 1000 });
      expect(s.closingBalance).toBe(0);
    });

    it('leaves out an advance applied to an invoice, which changes nothing owed', async () => {
      const service = serviceWith(
        [
          row({
            postingType: 'payment_application',
            reference: 'JE-5',
            sourceId: 'rct-1',
            accountCode: '2400',
            debit: 400,
          }),
          row({
            postingType: 'payment_application',
            reference: 'JE-5',
            sourceId: 'rct-1',
            credit: 400,
          }),
        ],
        [[CUSTOMER, -400]],
      );
      const s = await service.statement(
        'co',
        'customer',
        CUSTOMER,
        '2026-07-01',
        '2026-07-31',
      );

      expect(s.lines).toHaveLength(0);
      expect(s.openingBalance).toBe(-400);
      expect(s.closingBalance).toBe(-400);
    });

    it('leaves out a document raised and voided inside the period, but keeps a later void of an earlier one', async () => {
      const service = serviceWith(
        [
          row({
            reference: 'JE-7',
            sourceId: 'inv-7',
            debit: 1500,
            documentNumber: 'INV-7',
          }),
          row({
            reference: 'JE-8',
            sourceId: 'inv-7',
            postingType: 'invoice_void',
            credit: 1500,
            documentNumber: 'INV-7',
          }),
          // INV-3 was raised before the period; only its void is inside it.
          row({
            reference: 'JE-9',
            sourceId: 'inv-3',
            postingType: 'invoice_void',
            credit: 300,
            documentNumber: 'INV-3',
          }),
        ],
        [[CUSTOMER, 300]],
      );
      const s = await service.statement(
        'co',
        'customer',
        CUSTOMER,
        '2026-07-01',
        '2026-07-31',
      );

      expect(s.lines.map((l) => [l.kind, l.reference, l.amount])).toEqual([
        ['invoice_void', 'INV-3', -300],
      ]);
      expect(s.closingBalance).toBe(0);
    });

    it('signs a vendor statement the way the vendor reads it: what is owed goes up', async () => {
      const service = serviceWith([
        row({
          accountCode: '2000',
          postingType: 'bill',
          documentType: 'bill',
          credit: 500,
          documentNumber: 'BILL-1',
        }),
        row({
          accountCode: '2000',
          postingType: 'bill_payment',
          documentType: 'bill_payment',
          debit: 200,
        }),
      ]);
      const s = await service.statement(
        'co',
        'vendor',
        CUSTOMER,
        '2026-07-01',
        '2026-07-31',
      );

      expect(s.lines.map((l) => [l.kind, l.amount, l.balance])).toEqual([
        ['bill', 500, 500],
        ['payment', -200, 300],
      ]);
      expect(s.totals).toMatchObject({ billed: 500, paid: 200 });
    });
  });
});
