import { safeMessage } from './report-failure';

describe('reportFailure scrubbing', () => {
  it('keeps one short line and masks figures', () => {
    const msg = safeMessage(
      new Error('Row 14: debit 1,20,000.50 does not match 98765\nstack line'),
    );
    expect(msg).toBe('Row 14: debit # does not match #');
    expect(safeMessage('x'.repeat(500)).length).toBe(200);
  });
});
