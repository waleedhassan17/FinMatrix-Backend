import { freeNumber, namesAgree, sameAccount } from './account-clash';

const fm = (
  accountNumber: string,
  name: string,
  type: string,
  subType: string | null = null,
) => ({ accountNumber, name, type, subType });
const src = (
  number: string,
  name: string | null,
  type: string | null = null,
  kind: string | null = null,
) => ({ number, name, type, kind });

describe('a source account and the FinMatrix account with its number', () => {
  it('are the same when the names agree, words like "expense" aside', () => {
    expect(namesAgree('Rent', 'Rent Expense')).toBe(true);
    expect(namesAgree('Sales', 'Sales Revenue')).toBe(true);
    expect(namesAgree('Sales Returns', 'Sales Revenue')).toBe(false);
    expect(
      sameAccount(
        src('6000', 'Rent', 'Expense'),
        fm('6000', 'Rent Expense', 'expense', 'Operating'),
      ),
    ).toBe(true);
  });

  it('are the same control account however the source names it', () => {
    expect(
      sameAccount(
        src('1100', 'Debtors Control Account', 'Asset'),
        fm('1100', 'Accounts Receivable', 'asset', 'Accounts Receivable'),
      ),
    ).toBe(true);
    expect(
      sameAccount(
        src('2000', 'Trade Creditors', 'Liability'),
        fm('2000', 'Accounts Payable', 'liability', 'Accounts Payable'),
      ),
    ).toBe(true);
  });

  it('are the same when both are the one account of a distinctive kind', () => {
    expect(
      sameAccount(
        src('1000', 'Cash in Hand', 'Asset', 'Cash'),
        fm('1000', 'Cash', 'asset', 'Cash'),
      ),
    ).toBe(true);
    expect(
      sameAccount(
        src('3000', "Owner's Capital", 'Equity', 'Owner Equity'),
        fm('3000', 'Owner Equity', 'equity', 'Owner Equity'),
      ),
    ).toBe(true);
  });

  it("QuickBooks Desktop: Accounts Receivable at 1200 is not FinMatrix's Inventory", () => {
    expect(
      sameAccount(
        src('1200', 'Accounts Receivable', 'Asset', 'Accounts Receivable'),
        fm('1200', 'Inventory', 'asset', 'Inventory'),
      ),
    ).toBe(false);
  });

  it('Sage 50 UK: the bank at 1200 is not Inventory, and productive labour at 6000 is not rent', () => {
    expect(
      sameAccount(
        src('1200', 'Bank Current Account', 'Asset', 'Bank'),
        fm('1200', 'Inventory', 'asset', 'Inventory'),
      ),
    ).toBe(false);
    expect(
      sameAccount(
        src('6000', 'Productive Labour', 'Expense'),
        fm('6000', 'Rent Expense', 'expense', 'Operating'),
      ),
    ).toBe(false);
  });

  it('a trial balance line with no type is judged by its name; a bare number by nothing', () => {
    expect(
      sameAccount(
        src('1200', 'Bank Current Account'),
        fm('1200', 'Inventory', 'asset'),
      ),
    ).toBe(false);
    expect(
      sameAccount(src('4000', 'Sales'), fm('4000', 'Sales Revenue', 'revenue')),
    ).toBe(true);
    expect(
      sameAccount(src('4000', null), fm('4000', 'Sales Revenue', 'revenue')),
    ).toBe(true);
  });

  it('different types are never the same account, whatever the names', () => {
    expect(
      sameAccount(
        src('3000', 'Owner Equity', 'Liability'),
        fm('3000', 'Owner Equity', 'equity', 'Owner Equity'),
      ),
    ).toBe(false);
  });
});

describe('the free number for a clashing account', () => {
  it('is the next one nobody uses, keeping its width', () => {
    const taken = new Set(['1200', '1201', '1250']);
    expect(freeNumber('1200', taken)).toBe('1202');
    expect(freeNumber('1200', taken)).toBe('1203');
    expect(freeNumber('090', new Set(['090']))).toBe('091');
    expect(freeNumber('CASH', new Set(['cash']))).toBe('CASH-1');
  });
});
