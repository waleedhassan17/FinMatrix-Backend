import type {
  KpiAssessment,
  KpiAssessmentLevel,
  KpiStatus,
} from './reports.types';

/**
 * The ONLY place a KPI is judged.
 *
 * reports-kpi.service.ts computes a figure; this file says how it reads:
 * healthy, worth watching, or at risk, against a rule of thumb a small
 * business owner would recognise. The Expo app and the website both show the
 * result as a pill and quote `guide` beside the formula, so the two can never
 * disagree about whether a current ratio of 1.2× is fine.
 *
 * These are GUIDES, not standards: a supermarket lives happily on a current
 * ratio a manufacturer could not, and the sentence says "generally" where it
 * should. A figure with no sensible rule (revenue, payables days) is neutral.
 */

/** Higher is better: at least `healthy` is healthy, at least `watch` is watch. */
interface HigherBand {
  kind: 'higher';
  healthy: number;
  watch: number;
  guide: string;
}

/** Lower is better: at most `healthy` is healthy, at most `watch` is watch. */
interface LowerBand {
  kind: 'lower';
  healthy: number;
  watch: number;
  guide: string;
}

/** Read on sign alone: above zero is healthy, zero or below is `nonPositive`. */
interface SignBand {
  kind: 'sign';
  nonPositive: Exclude<KpiAssessmentLevel, 'healthy' | 'neutral'>;
  guide: string;
}

interface NeutralBand {
  kind: 'neutral';
  guide: string;
}

/**
 * Healthy inside a range, because too little and too much are both a problem
 * — days of stock cover: a week from running out, or a year's worth on the
 * shelf. Below `riskBelow` is at risk and below `watchBelow` is watch; up to
 * `healthyUpTo` is healthy, up to `watchUpTo` watch, and above it at risk.
 */
interface RangeBand {
  kind: 'range';
  riskBelow: number;
  watchBelow: number;
  healthyUpTo: number;
  watchUpTo: number;
  guide: string;
}

type Band = HigherBand | LowerBand | SignBand | NeutralBand | RangeBand;

export const KPI_BENCHMARKS: Record<string, Band> = {
  cashAndBank: {
    kind: 'sign',
    nonPositive: 'risk',
    guide:
      'What the cash and bank accounts hold; below zero means the business is overdrawn.',
  },
  workingCapital: {
    kind: 'sign',
    nonPositive: 'risk',
    guide:
      'Positive means current assets cover everything falling due within a year.',
  },
  currentRatio: {
    kind: 'higher',
    healthy: 1.5,
    watch: 1,
    guide:
      'Above 1.5× is generally comfortable; below 1×, current debts exceed current assets.',
  },
  quickRatio: {
    kind: 'higher',
    healthy: 1,
    watch: 0.7,
    guide:
      'Above 1× means cash and receivables alone cover current debts, without selling stock.',
  },
  debtToEquity: {
    kind: 'lower',
    healthy: 1,
    watch: 2,
    guide:
      'Below 1× means the owners fund more of the business than creditors do; above 2× is highly leveraged.',
  },
  dso: {
    kind: 'lower',
    healthy: 45,
    watch: 75,
    guide:
      'Under 45 days suits 30-day terms; above 75 days, customers are paying slowly.',
  },
  dpo: {
    kind: 'neutral',
    guide:
      'How long you take to pay suppliers. Longer helps cash, but past agreed terms it strains suppliers.',
  },
  dio: {
    kind: 'lower',
    healthy: 60,
    watch: 120,
    guide:
      'Under 60 days of stock on hand is lean; above 120 days, stock is moving slowly.',
  },
  dio12: {
    kind: 'lower',
    healthy: 60,
    watch: 120,
    guide:
      'Under 60 days of stock on hand is lean; above 120 days, stock is moving slowly.',
  },
  ccc: {
    kind: 'lower',
    healthy: 60,
    watch: 120,
    guide:
      'Days cash is tied up between paying for stock and collecting from customers; shorter is better.',
  },
  runwayMonths: {
    kind: 'higher',
    healthy: 6,
    watch: 3,
    guide:
      'Months the cash lasts at the recent rate of spending; under 3 months needs action now.',
  },
  inventoryTurnover: {
    kind: 'higher',
    healthy: 6,
    watch: 3,
    guide:
      'Times the stock sold through in 12 months; under 3× ties up cash in slow stock.',
  },
  revenue: { kind: 'neutral', guide: 'All revenue posted in the period.' },
  grossProfit: {
    kind: 'sign',
    nonPositive: 'risk',
    guide:
      'What sales earned over what the goods sold cost; at or below zero, every sale loses money.',
  },
  netIncome: {
    kind: 'sign',
    nonPositive: 'risk',
    guide: 'What is left after every cost of the period; below zero is a loss.',
  },
  operatingExpenses: {
    kind: 'neutral',
    guide:
      'Running costs, excluding the cost of goods sold and non-operating items.',
  },
  grossMarginPct: {
    kind: 'sign',
    nonPositive: 'risk',
    guide: 'The share of revenue left after the cost of goods sold.',
  },
  netMarginPct: {
    kind: 'sign',
    nonPositive: 'risk',
    guide: 'The share of revenue kept as profit after every expense.',
  },
  operatingCashFlow: {
    kind: 'sign',
    nonPositive: 'watch',
    guide:
      'Cash the day-to-day business brought in; below zero, trading is using cash rather than making it.',
  },
  endingCash: {
    kind: 'sign',
    nonPositive: 'risk',
    guide:
      'Cash and bank at the end of the period; below zero means overdrawn.',
  },
  overduePct: {
    kind: 'lower',
    healthy: 20,
    watch: 40,
    guide: 'The share of the open balance that is past its due date.',
  },
  weightedAvgDaysOverdue: {
    kind: 'lower',
    healthy: 30,
    watch: 60,
    guide: 'How late the overdue balance is, weighted by amount.',
  },
  top5SharePct: {
    kind: 'lower',
    healthy: 50,
    watch: 70,
    guide:
      'How much of the total five parties hold; above 50%, losing one would be felt.',
  },
  // One item's stock against its own selling rate. The upper bounds are the
  // company's DIO band, so an item and the whole stock read alike.
  daysOfCover: {
    kind: 'range',
    riskBelow: 7,
    watchBelow: 14,
    healthyUpTo: 60,
    watchUpTo: 120,
    guide:
      'Two weeks to two months of stock at the current selling rate is healthy; under a week risks running out, and over four months ties up cash.',
  },
};

const NO_BENCHMARK = 'No rule of thumb applies to this figure.';

/**
 * How a value reads against its benchmark.
 *
 * A KPI the server could not compute (status other than 'ok') is judged on
 * the status where the status itself is the verdict — runway while cash is
 * not falling is healthy, debt-to-equity with negative equity is at risk —
 * and is otherwise neutral: there is nothing to judge yet.
 */
export function assessKpi(
  key: string,
  value: number | null,
  status: KpiStatus = 'ok',
): KpiAssessment {
  const band = KPI_BENCHMARKS[key];
  if (!band) return { level: 'neutral', guide: NO_BENCHMARK };
  const guide = band.guide;
  if (status === 'cash_positive') return { level: 'healthy', guide };
  if (status === 'negative_equity') return { level: 'risk', guide };
  if (value === null || !Number.isFinite(value))
    return { level: 'neutral', guide };
  switch (band.kind) {
    case 'neutral':
      return { level: 'neutral', guide };
    case 'sign':
      return { level: value > 0 ? 'healthy' : band.nonPositive, guide };
    case 'higher':
      return {
        level:
          value >= band.healthy
            ? 'healthy'
            : value >= band.watch
              ? 'watch'
              : 'risk',
        guide,
      };
    case 'lower':
      return {
        level:
          value <= band.healthy
            ? 'healthy'
            : value <= band.watch
              ? 'watch'
              : 'risk',
        guide,
      };
    case 'range':
      return {
        level:
          value < band.riskBelow
            ? 'risk'
            : value < band.watchBelow
              ? 'watch'
              : value <= band.healthyUpTo
                ? 'healthy'
                : value <= band.watchUpTo
                  ? 'watch'
                  : 'risk',
        guide,
      };
  }
}
