import { assessKpi, KPI_BENCHMARKS } from './kpi-benchmarks';

describe('assessKpi — the benchmark table', () => {
  it.each([
    // Higher is better: the healthy floor is healthy, the watch floor is watch.
    ['currentRatio', 1.5, 'healthy'],
    ['currentRatio', 1.49, 'watch'],
    ['currentRatio', 1, 'watch'],
    ['currentRatio', 0.99, 'risk'],
    ['quickRatio', 1, 'healthy'],
    ['quickRatio', 0.7, 'watch'],
    ['quickRatio', 0.69, 'risk'],
    ['runwayMonths', 6, 'healthy'],
    ['runwayMonths', 3, 'watch'],
    ['runwayMonths', 2.9, 'risk'],
    ['inventoryTurnover', 6, 'healthy'],
    ['inventoryTurnover', 3, 'watch'],
    ['inventoryTurnover', 2.5, 'risk'],
    // Lower is better: the healthy ceiling is healthy, the watch ceiling is watch.
    ['debtToEquity', 1, 'healthy'],
    ['debtToEquity', 2, 'watch'],
    ['debtToEquity', 2.01, 'risk'],
    ['dso', 45, 'healthy'],
    ['dso', 75, 'watch'],
    ['dso', 76, 'risk'],
    ['dio', 60, 'healthy'],
    ['dio12', 120, 'watch'],
    ['dio12', 121, 'risk'],
    ['ccc', 60, 'healthy'],
    ['ccc', -10, 'healthy'],
    ['ccc', 121, 'risk'],
    ['overduePct', 20, 'healthy'],
    ['overduePct', 40, 'watch'],
    ['overduePct', 40.01, 'risk'],
    ['weightedAvgDaysOverdue', 30, 'healthy'],
    ['weightedAvgDaysOverdue', 60, 'watch'],
    ['weightedAvgDaysOverdue', 61, 'risk'],
    ['top5SharePct', 50, 'healthy'],
    ['top5SharePct', 70, 'watch'],
    ['top5SharePct', 70.5, 'risk'],
    // Inside a range: too little stock and too much both count against it.
    ['daysOfCover', 0, 'risk'],
    ['daysOfCover', 6, 'risk'],
    ['daysOfCover', 7, 'watch'],
    ['daysOfCover', 13, 'watch'],
    ['daysOfCover', 14, 'healthy'],
    ['daysOfCover', 60, 'healthy'],
    ['daysOfCover', 61, 'watch'],
    ['daysOfCover', 120, 'watch'],
    ['daysOfCover', 121, 'risk'],
    ['daysOfCover', 387, 'risk'],
    // Read on sign alone.
    ['workingCapital', 1, 'healthy'],
    ['workingCapital', 0, 'risk'],
    ['cashAndBank', -5, 'risk'],
    ['grossMarginPct', 12, 'healthy'],
    ['grossProfit', 0, 'risk'],
    ['netIncome', -1, 'risk'],
    ['netIncome', 500, 'healthy'],
    ['netMarginPct', -3, 'risk'],
    ['endingCash', 0, 'risk'],
    ['operatingCashFlow', -1, 'watch'],
    // No rule of thumb: stated, never judged.
    ['revenue', 1_000_000, 'neutral'],
    ['operatingExpenses', 5, 'neutral'],
    ['dpo', 400, 'neutral'],
  ])('%s at %d reads %s', (key, value, level) => {
    expect(assessKpi(key, value).level).toBe(level);
  });

  it('lets the status speak where the status is the verdict', () => {
    // Runway while cash is not falling has no value, and nothing to fear.
    expect(assessKpi('runwayMonths', null, 'cash_positive').level).toBe(
      'healthy',
    );
    // Debt-to-equity is undefined when equity is negative — that is the risk.
    expect(assessKpi('debtToEquity', null, 'negative_equity').level).toBe(
      'risk',
    );
  });

  it('judges nothing it cannot see', () => {
    expect(assessKpi('dso', null, 'no_denominator').level).toBe('neutral');
    // Nothing sold in the window: no selling rate to measure cover against.
    expect(assessKpi('daysOfCover', null).level).toBe('neutral');
    expect(assessKpi('currentRatio', Number.NaN).level).toBe('neutral');
    expect(assessKpi('currentRatio', Number.POSITIVE_INFINITY).level).toBe(
      'neutral',
    );
  });

  it('is neutral, with a plain sentence, for a key it has no rule for', () => {
    expect(assessKpi('somethingNew', 12)).toEqual({
      level: 'neutral',
      guide: 'No rule of thumb applies to this figure.',
    });
  });

  it('quotes one sentence of guidance for every benchmark', () => {
    for (const [key, band] of Object.entries(KPI_BENCHMARKS)) {
      expect(assessKpi(key, 1).guide).toBe(band.guide);
      expect(band.guide).toMatch(/^[A-Z].*\.$/);
    }
  });
});
