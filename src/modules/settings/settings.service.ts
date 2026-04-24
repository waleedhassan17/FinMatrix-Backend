import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CompanySettings } from './entities/company-settings.entity';
import { UpdateSettingsDto } from './dto/settings.dto';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(CompanySettings) private readonly repo: Repository<CompanySettings>,
  ) {}

  async get(companyId: string) {
    const found = await this.repo.findOne({ where: { companyId } });
    if (found) return found;
    const s = Object.assign(new CompanySettings(), {
      companyId,
      defaultCurrency: 'USD',
      dateFormat: 'YYYY-MM-DD',
      timezone: 'UTC',
      features: {},
    } as any);
    return this.repo.save(s);
  }

  async update(companyId: string, dto: UpdateSettingsDto) {
    const s = await this.get(companyId);
    Object.assign(s, dto);
    return this.repo.save(s);
  }
}
