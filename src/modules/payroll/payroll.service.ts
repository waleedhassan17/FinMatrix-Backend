import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Employee, EmployeeStatus, PayType } from './entities/employee.entity';
import { PayrollRun, PayrollStatus } from './entities/payroll-run.entity';
import { PayrollItem } from './entities/payroll-item.entity';
import {
  CreateEmployeeDto, CreatePayrollRunDto, ListEmployeesQueryDto, UpdateEmployeeDto,
} from './dto/payroll.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';

const ACCT_SALARY_EXPENSE = '6200';
const ACCT_CASH = '1000';
const ACCT_TAX_PAYABLE = '2300';
const num = (v: any) => parseFloat(v ?? '0') || 0;

@Injectable()
export class PayrollService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    @InjectRepository(Employee) private readonly empRepo: Repository<Employee>,
    @InjectRepository(PayrollRun) private readonly runRepo: Repository<PayrollRun>,
    @InjectRepository(PayrollItem) private readonly itemRepo: Repository<PayrollItem>,
  ) {}

  // ── Employees ──────────────────────────────────────────────────
  async listEmployees(companyId: string, query: ListEmployeesQueryDto, pagination: PaginationParams) {
    const qb = this.empRepo.createQueryBuilder('e').where('e.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('e.status = :s', { s: query.status });
    if (query.department) qb.andWhere('e.department = :d', { d: query.department });
    if (query.search) qb.andWhere("(e.firstName ILIKE :q OR e.lastName ILIKE :q)", { q: `%${query.search}%` });
    qb.orderBy('e.firstName', 'ASC').take(pagination.limit).skip(pagination.skip);
    const [data, total] = await qb.getManyAndCount();
    return { data, pagination: { page: pagination.page, limit: pagination.limit, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) } };
  }

  async getEmployee(companyId: string, id: string): Promise<Employee> {
    const e = await this.empRepo.findOne({ where: { id, companyId } });
    if (!e) throw new NotFoundException({ code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found' });
    return e;
  }

  async createEmployee(companyId: string, dto: CreateEmployeeDto): Promise<Employee> {
    const e = this.empRepo.create({
      companyId, firstName: dto.firstName, lastName: dto.lastName, email: dto.email ?? null,
      phone: dto.phone ?? null, department: dto.department ?? null, position: dto.position ?? null,
      hireDate: dto.hireDate ?? null, status: 'active' as EmployeeStatus,
      payType: (dto.payType ?? 'salary') as PayType, salary: dto.salary ?? '0', hourlyRate: dto.hourlyRate ?? '0',
      payFrequency: dto.payFrequency ?? 'monthly', deductions: dto.deductionAmount ? { amount: num(dto.deductionAmount) } : null,
      isActive: true,
    });
    return this.empRepo.save(e);
  }

  async updateEmployee(companyId: string, id: string, dto: UpdateEmployeeDto): Promise<Employee> {
    const e = await this.getEmployee(companyId, id);
    Object.assign(e, {
      firstName: dto.firstName ?? e.firstName, lastName: dto.lastName ?? e.lastName,
      email: dto.email ?? e.email, phone: dto.phone ?? e.phone, department: dto.department ?? e.department,
      position: dto.position ?? e.position, hireDate: dto.hireDate ?? e.hireDate,
      payType: (dto.payType ?? e.payType) as PayType, salary: dto.salary ?? e.salary, hourlyRate: dto.hourlyRate ?? e.hourlyRate,
      payFrequency: dto.payFrequency ?? e.payFrequency,
      status: (dto.status ?? e.status) as EmployeeStatus,
      isActive: dto.status ? dto.status === 'active' : e.isActive,
      deductions: dto.deductionAmount !== undefined ? { amount: num(dto.deductionAmount) } : e.deductions,
    });
    return this.empRepo.save(e);
  }

  async deleteEmployee(companyId: string, id: string) {
    const e = await this.getEmployee(companyId, id);
    // An employee who has been paid is part of the books — never hard-delete
    // (it would orphan payroll runs/payslips). QuickBooks-style: deactivate.
    const historyCount = await this.itemRepo.count({ where: { employeeId: id } });
    if (historyCount > 0) {
      throw new BadRequestException({
        code: 'EMPLOYEE_HAS_PAYROLL_HISTORY',
        message:
          'This employee appears on payroll runs and cannot be deleted. Set their status to inactive instead to preserve history.',
      });
    }
    await this.empRepo.remove(e);
    return { id, deleted: true };
  }

  // ── Payroll runs ───────────────────────────────────────────────
  async listRuns(companyId: string) {
    const data = await this.runRepo.find({ where: { companyId }, order: { payDate: 'DESC' } });
    return { data };
  }

  async getRun(companyId: string, id: string) {
    const run = await this.runRepo.findOne({ where: { id, companyId }, relations: { items: true } });
    if (!run) throw new NotFoundException({ code: 'PAYROLL_RUN_NOT_FOUND', message: 'Payroll run not found' });
    const emps = await this.empRepo.findByIds(run.items.map((i) => i.employeeId));
    const empMap = Object.fromEntries(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
    return { ...run, items: run.items.map((i) => ({ ...i, employeeName: empMap[i.employeeId] ?? '' })) };
  }

  private grossFor(emp: Employee, hours: number): Decimal {
    if (emp.payType === 'hourly') return toDecimal(emp.hourlyRate).times(hours || 0);
    const periods = emp.payFrequency === 'weekly' ? 52 : emp.payFrequency === 'biweekly' ? 26 : 12;
    return toDecimal(emp.salary).dividedBy(periods);
  }

  /**
   * Withheld tax/deductions for one pay period. QuickBooks-style: the amount
   * comes from what the USER set up on the employee — we never hardcode a
   * tax slab or a default rate. No deductions configured → 0 withheld.
   *
   * EXTENSION POINT: auto-calculation (e.g. FBR slabs) plugs in here later —
   * derive from `gross` + a company tax table instead of the stored amount.
   */
  private deductionFor(emp: Employee, gross: Decimal): Decimal {
    void gross;
    const d: any = emp.deductions;
    if (d && typeof d.amount === 'number') return new Decimal(d.amount);
    if (Array.isArray(d)) return d.reduce((s: Decimal, x: any) => s.plus(num(x?.amount)), new Decimal(0));
    return new Decimal(0);
  }

  async createRun(companyId: string, userId: string, dto: CreatePayrollRunDto): Promise<PayrollRun> {
    return this.dataSource.transaction(async (manager) => {
      let employees: Employee[];
      const hoursMap = new Map<string, number>();
      if (dto.items?.length) {
        const ids = dto.items.map((i) => i.employeeId);
        employees = await manager.find(Employee, { where: ids.map((id) => ({ id, companyId })) });
        dto.items.forEach((i) => hoursMap.set(i.employeeId, num(i.hours)));
      } else {
        employees = await manager.find(Employee, { where: { companyId, status: 'active' as EmployeeStatus } });
      }
      if (employees.length === 0) throw new BadRequestException({ code: 'NO_EMPLOYEES', message: 'No employees to pay' });

      // Idempotency at the period level: once a period is PAID, a second run
      // for the same period label is almost certainly a double-pay mistake.
      const paidTwin = await manager.findOne(PayrollRun, {
        where: { companyId, payPeriod: dto.payPeriod, status: 'paid' as PayrollStatus },
      });
      if (paidTwin) {
        throw new BadRequestException({
          code: 'PERIOD_ALREADY_PAID',
          message: `Payroll for "${dto.payPeriod}" has already been processed. Use a different pay period label for an off-cycle run.`,
        });
      }

      let totalGross = new Decimal(0), totalDed = new Decimal(0), totalNet = new Decimal(0);
      const itemDrafts = employees.map((emp) => {
        const hours = hoursMap.get(emp.id) ?? (emp.payType === 'hourly' ? 160 : 0);
        const gross = this.grossFor(emp, hours);
        const ded = this.deductionFor(emp, gross);
        const net = gross.minus(ded);
        totalGross = totalGross.plus(gross); totalDed = totalDed.plus(ded); totalNet = totalNet.plus(net);
        return { employeeId: emp.id, hours: new Decimal(hours).toFixed(4), gross: gross.toFixed(4), deductions: ded.toFixed(4), net: net.toFixed(4) };
      });

      const run = manager.create(PayrollRun, {
        companyId, payPeriod: dto.payPeriod, periodStart: dto.periodStart, periodEnd: dto.periodEnd, payDate: dto.payDate,
        totalGross: totalGross.toFixed(4), totalDeductions: totalDed.toFixed(4), totalNet: totalNet.toFixed(4),
        status: 'draft' as PayrollStatus, journalEntryId: null, createdBy: userId,
      });
      await manager.save(run);
      run.items = itemDrafts.map((d) => manager.create(PayrollItem, { payrollRunId: run.id, ...d }));
      await manager.save(run.items);
      return run;
    });
  }

  async processRun(companyId: string, id: string, userId: string): Promise<PayrollRun> {
    return this.dataSource.transaction(async (manager) => {
      // Row-lock the run: two concurrent process calls (double-tap, retry
      // after timeout) serialize here, and the second one sees status='paid'
      // and is rejected — the journal entry can never post twice.
      const run = await manager
        .getRepository(PayrollRun)
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.id = :id AND r.companyId = :cid', { id, cid: companyId })
        .getOne();
      if (!run) throw new NotFoundException({ code: 'PAYROLL_RUN_NOT_FOUND', message: 'Payroll run not found' });
      if (run.status === 'paid') throw new BadRequestException({ code: 'ALREADY_PAID', message: 'Payroll already processed' });
      if (run.journalEntryId) throw new BadRequestException({ code: 'ALREADY_POSTED', message: 'This payroll run already posted a journal entry.' });

      const expense = await this.accounts.getByNumberOrFail(companyId, ACCT_SALARY_EXPENSE, manager);
      const cash = await this.accounts.getByNumberOrFail(companyId, ACCT_CASH, manager);
      const lines = [
        { accountId: expense.id, description: 'Payroll gross wages', debit: run.totalGross, credit: '0', lineOrder: 0 },
        { accountId: cash.id, description: 'Net pay', debit: '0', credit: run.totalNet, lineOrder: 1 },
      ];
      if (toDecimal(run.totalDeductions).greaterThan(0)) {
        const tax = await this.accounts.getByNumberOrFail(companyId, ACCT_TAX_PAYABLE, manager);
        lines.push({ accountId: tax.id, description: 'Payroll deductions withheld', debit: '0', credit: run.totalDeductions, lineOrder: 2 });
      }
      const entry = await this.posting.createEntry(manager, {
        companyId, createdBy: userId, date: run.payDate, memo: `Payroll ${run.payPeriod}`,
        status: 'posted', lines, sourceType: 'payroll', sourceId: run.id,
      });
      run.journalEntryId = entry.id;
      run.status = 'paid';
      await manager.save(run);
      return run;
    });
  }

  async deleteRun(companyId: string, id: string) {
    const run = await this.runRepo.findOne({ where: { id, companyId } });
    if (!run) throw new NotFoundException({ code: 'PAYROLL_RUN_NOT_FOUND', message: 'Payroll run not found' });
    if (run.status === 'paid') throw new BadRequestException({ code: 'CANNOT_DELETE', message: 'Cannot delete a processed payroll run' });
    await this.runRepo.remove(run);
    return { id, deleted: true };
  }
}
