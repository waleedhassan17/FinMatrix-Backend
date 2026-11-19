import { matchMasters, nearestMasters } from './master-matcher';

describe('matchMasters', () => {
  const existing = [
    { id: 'c1', code: 'C-0001', name: 'Al-Noor Traders' },
    { id: 'c2', code: null, name: 'Bismillah Store' },
  ];

  it('matches by code first, then exact normalised name', () => {
    const r = matchMasters(
      [
        { code: 'c-0001', name: 'Al Noor Traders (new name)' },
        { code: null, name: 'bismillah  store' },
        { code: 'C-0009', name: 'New Party' },
      ],
      existing,
    );
    expect(r[0]).toEqual({ recordId: 'c1', by: 'code', duplicateOf: null });
    expect(r[1]).toEqual({ recordId: 'c2', by: 'name', duplicateOf: null });
    expect(r[2]).toEqual({ recordId: null, by: null, duplicateOf: null });
  });

  it('flags duplicates within the file by code or name, pointing at the first row', () => {
    const r = matchMasters(
      [
        { code: 'X1', name: 'Alpha' },
        { code: 'X1', name: 'Alpha Ltd' },
        { code: null, name: 'ALPHA' },
        { code: 'X2', name: 'Beta' },
      ],
      [],
    );
    expect(r.map((m) => m.duplicateOf)).toEqual([null, 0, 0, null]);
  });

  it('never merges on a loose name', () => {
    const r = matchMasters([{ code: null, name: 'Al-Noor Trader' }], existing);
    expect(r[0].recordId).toBeNull();
    expect(nearestMasters('Al-Noor Trader', existing).map((m) => m.id)).toEqual(
      ['c1'],
    );
  });
});
