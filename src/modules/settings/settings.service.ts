import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CompanySettings } from './entities/company-settings.entity';
import { UpdateSettingsDto } from './dto/settings.dto';
import { clampMonth } from '../reports/fiscal-year';

/** 'MM-01' — the shape `fiscalYearStart` has always had on the wire. */
const fiscalYearStartOf = (month: number) =>
  `${String(month).padStart(2, '0')}-01`;

/**
 * The month a `fiscalYearStart` value names: 'MM' or 'MM-DD'. Fiscal years
 * start on the 1st, so a day other than the 1st is refused rather than
 * silently moved.
 */
function parseFiscalYearStart(value: string): number {
  const m = /^\s*(\d{1,2})(?:-(\d{1,2}))?\s*$/.exec(value ?? '');
  const month = m ? parseInt(m[1], 10) : NaN;
  const day = m?.[2] ? parseInt(m[2], 10) : 1;
  if (!m || month < 1 || month > 12 || day !== 1) {
    throw new BadRequestException({
      code: 'INVALID_FISCAL_YEAR_START',
      message:
        "fiscalYearStart must be a month, as 'MM' or 'MM-01' (a fiscal year starts on the 1st).",
    });
  }
  return month;
}

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(CompanySettings)
    private readonly repo: Repository<CompanySettings>,
  ) {}

  async get(companyId: string) {
    const found = await this.repo.findOne({ where: { companyId } });
    const s =
      found ??
      (await this.repo.save(
        Object.assign(new CompanySettings(), {
          companyId,
          defaultCurrency: 'USD',
          dateFormat: 'YYYY-MM-DD',
          timezone: 'UTC',
          features: {},
        } as any),
      ));
    return this.withCanonicalFiscalYear(companyId, s);
  }

  async update(companyId: string, dto: UpdateSettingsDto) {
    const { fiscalYearStart, ...rest } = dto;
    if (fiscalYearStart !== undefined) {
      // Written THROUGH to the one field the fiscal year is read from.
      const month = parseFiscalYearStart(fiscalYearStart);
      await this.repo.manager.query(
        `UPDATE companies SET fiscal_year_start_month = $2 WHERE id = $1`,
        [companyId, month],
      );
    }
    const s = await this.get(companyId);
    Object.assign(s, rest);
    return this.repo.save(s);
  }

  /**
   * The fiscal year has ONE source of truth: `companies.fiscal_year_start_month`
   * (set at company setup; NULL = January). `company_settings.fiscal_year_start`
   * used to be a second, independent copy that nothing kept in step — a
   * company could start its year in July in one and January in the other.
   * It is now derived from the company field on every read, and the column is
   * kept only as a mirror so the row on disk agrees; no code reads it.
   */
  private async withCanonicalFiscalYear(companyId: string, s: CompanySettings) {
    const [row] = await this.repo.manager.query(
      `SELECT fiscal_year_start_month AS month FROM companies WHERE id = $1`,
      [companyId],
    );
    s.fiscalYearStart = fiscalYearStartOf(clampMonth(row?.month));
    return s;
  }
}
