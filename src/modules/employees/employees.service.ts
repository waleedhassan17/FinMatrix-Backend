import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Employee } from './entities/employee.entity';
import { CreateEmployeeDto, UpdateEmployeeDto, EmployeeQueryDto } from './dto/employee.dto';

@Injectable()
export class EmployeesService {
  constructor(
    @InjectRepository(Employee) private readonly repo: Repository<Employee>,
  ) {}

  async list(companyId: string, query: EmployeeQueryDto, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('e').where('e.companyId = :cid', { cid: companyId });
    if (query.q) qb.andWhere('(e.firstName ILIKE :q OR e.lastName ILIKE :q OR e.email ILIKE :q)', { q: `%${query.q}%` });
    if (query.department) qb.andWhere('e.department = :d', { d: query.department });
    if (query.status) qb.andWhere('e.status = :s', { s: query.status });
    qb.orderBy('e.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getById(companyId: string, id: string) {
    const e = await this.repo.findOne({ where: { id, companyId } });
    if (!e) throw new NotFoundException('Employee not found');
    return e;
  }

  async create(companyId: string, dto: CreateEmployeeDto) {
    const e = this.repo.create({ ...dto, companyId, status: 'active', isActive: true } as any);
    return this.repo.save(e);
  }

  async update(companyId: string, id: string, dto: UpdateEmployeeDto) {
    const e = await this.getById(companyId, id);
    Object.assign(e, dto);
    return this.repo.save(e);
  }

  async toggleActive(companyId: string, id: string) {
    const e = await this.getById(companyId, id);
    e.isActive = !e.isActive;
    e.status = e.isActive ? 'active' : 'terminated';
    if (!e.isActive && !e.terminationDate) e.terminationDate = new Date().toISOString().split('T')[0];
    return this.repo.save(e);
  }

  async departments(companyId: string) {
    const rows = await this.repo.createQueryBuilder('e')
      .select('e.department', 'department')
      .addSelect('COUNT(*)', 'count')
      .where('e.companyId = :cid', { cid: companyId })
      .andWhere('e.department IS NOT NULL')
      .groupBy('e.department')
      .getRawMany();
    return rows;
  }
}
