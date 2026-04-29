import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PayrollRun } from './entities/payroll-run.entity';
import { Paystub } from './entities/paystub.entity';
import { Employee } from '../employees/entities/employee.entity';
import { CreatePayrollRunDto, UpdatePayrollRunDto } from './dto/payroll.dto';
import { toDecimal } from '../../common/utils/money.util';

@Injectable()
export class PayrollService {
  constructor(
    @InjectRepository(PayrollRun) private readonly runRepo: Repository<PayrollRun>,
    @InjectRepository(Paystub) private readonly stubRepo: Repository<Paystub>,
    private readonly dataSource: DataSource,
  ) {}

  async list(companyId: string, page: number, limit: number) {
    const qb = this.runRepo.createQueryBuilder('r').where('r.companyId = :cid', { cid: companyId });
    qb.orderBy('r.payDate', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getById(companyId: string, id: string) {
    const run = await this.runRepo.findOne({ where: { id, companyId }, relations: ['paystubs'] });
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  async create(companyId: string, dto: CreatePayrollRunDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const runRepo = em.getRepository(PayrollRun);
      const stubRepo = em.getRepository(Paystub);
      const empRepo = em.getRepository(Employee);

      let totalGross = toDecimal(0);
      let totalDeductions = toDecimal(0);
      let totalNet = toDecimal(0);

      const runData = {
        companyId,
        payPeriod: dto.payPeriod,
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        payDate: dto.payDate,
        status: 'draft' as any,
        totalGross: '0',
        totalDeductions: '0',
        totalNet: '0',
        createdBy: userId,
      };
      const run = Object.assign(new PayrollRun(), runData);
      await runRepo.save(run);

      for (const line of dto.paystubs) {
        const emp = await empRepo.findOne({ where: { id: line.employeeId, companyId } });
        if (!emp) continue;

        const gross = toDecimal(line.grossPay ?? emp.salary);
        const tax = toDecimal(line.taxDeduction ?? '0');
        const health = toDecimal(line.healthInsuranceDeduction ?? '0');
        const retirement = toDecimal(line.retirementDeduction ?? '0');
        const deductions = tax.plus(health).plus(retirement);
        const net = gross.minus(deductions);

        totalGross = totalGross.plus(gross);
        totalDeductions = totalDeductions.plus(deductions);
        totalNet = totalNet.plus(net);

        const stub = stubRepo.create({
          payrollRunId: run.id,
          employeeId: line.employeeId,
          hoursWorked: line.hoursWorked ?? '0',
          grossPay: gross.toFixed(4),
          taxDeduction: tax.toFixed(4),
          healthInsuranceDeduction: health.toFixed(4),
          retirementDeduction: retirement.toFixed(4),
          netPay: net.toFixed(4),
        } as any);
        await stubRepo.save(stub);
      }

      run.totalGross = totalGross.toFixed(4);
      run.totalDeductions = totalDeductions.toFixed(4);
      run.totalNet = totalNet.toFixed(4);
      await runRepo.save(run);
      return run;
    });
  }

  async getPayStubs(companyId: string, payrollRunId: string) {
    const run = await this.getById(companyId, payrollRunId);
    return run.paystubs ?? [];
  }

  async updateStatus(companyId: string, id: string, dto: UpdatePayrollRunDto) {
    const run = await this.getById(companyId, id);
    const current = run.status as string;
    if (dto.status === 'processed' && current !== 'draft') throw new BadRequestException('Can only process draft runs');
    if (dto.status === 'posted' && current !== 'processed') throw new BadRequestException('Can only post processed runs');
    run.status = dto.status as any;
    return this.runRepo.save(run);
  }

  async getWorksheet(companyId: string) {
    const empRepo = this.dataSource.getRepository(Employee);
    const employees = await empRepo.find({ where: { companyId, status: 'active' } });
    
    return employees.map(emp => {
      const gross = toDecimal(emp.salary);
      // Rough default deductions for the worksheet estimation
      const tax = gross.times(0.15); // 15% estimated tax
      const net = gross.minus(tax);
      return {
        employeeId: emp.id,
        firstName: emp.firstName,
        lastName: emp.lastName,
        department: emp.department,
        baseSalary: emp.salary,
        estimatedGross: gross.toFixed(4),
        estimatedTaxes: tax.toFixed(4),
        estimatedNet: net.toFixed(4),
      };
    });
  }
}
