import { derivedStatus, derivedStatusSql } from './document-status.util';

describe('derivedStatus — overdue is what still owes past its due date', () => {
  const today = '2026-09-28';
  const open = ['sent', 'partial'] as const;

  it('a sent invoice nobody has paid, past due, is overdue', () => {
    expect(
      derivedStatus(
        { status: 'sent', dueDate: '2026-09-01', balance: '100.0000' },
        open,
        today,
      ),
    ).toBe('overdue');
  });

  it('part-paid and past due is overdue too', () => {
    expect(
      derivedStatus(
        { status: 'partial', dueDate: '2026-09-27', balance: '5.0000' },
        open,
        today,
      ),
    ).toBe('overdue');
  });

  it('due today is not yet overdue', () => {
    expect(
      derivedStatus(
        { status: 'sent', dueDate: today, balance: '100.0000' },
        open,
        today,
      ),
    ).toBe('sent');
  });

  it('nothing owed is never overdue, whatever the date', () => {
    expect(
      derivedStatus(
        { status: 'paid', dueDate: '2026-01-01', balance: '0.0000' },
        open,
        today,
      ),
    ).toBe('paid');
    expect(
      derivedStatus(
        { status: 'sent', dueDate: '2026-01-01', balance: '0.0000' },
        open,
        today,
      ),
    ).toBe('sent');
  });

  it('drafts and voids keep their status; so does a document with no due date', () => {
    expect(
      derivedStatus(
        { status: 'draft', dueDate: '2026-01-01', balance: '100' },
        open,
        today,
      ),
    ).toBe('draft');
    expect(
      derivedStatus(
        { status: 'void', dueDate: '2026-01-01', balance: '100' },
        open,
        today,
      ),
    ).toBe('void');
    expect(
      derivedStatus(
        { status: 'sent', dueDate: null, balance: '100' },
        open,
        today,
      ),
    ).toBe('sent');
  });

  it('bills use their own open statuses', () => {
    expect(
      derivedStatus(
        { status: 'open', dueDate: '2026-09-01', balance: '10' },
        ['open', 'partial'],
        today,
      ),
    ).toBe('overdue');
  });

  it('the SQL twin states the same rule, NULL-safe on the due date', () => {
    const sql = derivedStatusSql('i', open);
    expect(sql).toContain("i.status IN ('sent', 'partial')");
    expect(sql).toContain('i.dueDate IS NOT NULL');
    expect(sql).toContain('i.balance > 0');
  });
});
