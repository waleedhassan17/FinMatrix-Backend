import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Delete } from '@nestjs/common';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { InvoicesService } from './invoices.service';
import { InvoicePdfService } from './invoice-pdf.service';
import {
  CreateInvoiceDto,
  ListInvoicesQueryDto,
  UpdateInvoiceDto,
  VoidInvoiceDto,
} from './dto/invoice.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';
import { Customer } from '../customers/entities/customer.entity';
import { Company } from '../companies/entities/company.entity';

@ApiTags('invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
// Financial data: company staff only — the delivery role must never read
// or write here (handler-level @Roles overrides where narrower).
@Roles('admin', 'staff')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly approvals: ApprovalRequestsService,
    private readonly pdf: InvoicePdfService,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
  ) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListInvoicesQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.invoices.list(companyId, query, pagination);
  }

  @Get(':invoiceId')
  get(
    @CurrentCompany() companyId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    return this.invoices.getById(companyId, invoiceId);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.invoices.create(companyId, user.id, dto);
  }

  @Patch(':invoiceId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.invoices.update(companyId, invoiceId, dto);
  }

  @Post(':invoiceId/send')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send invoice: status->sent, auto journal entry.' })
  send(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    return this.invoices.send(companyId, invoiceId, user.id);
  }

  /**
   * Raising and sending an invoice is value IN and stays direct for staff.
   * VOIDING one reverses a posted sale, so it is gated like every other
   * correction.
   */
  @Post(':invoiceId/void')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void invoice (fails if amountPaid > 0).' })
  void(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: VoidInvoiceDto,
  ) {
    if (user.role === 'admin') {
      return this.invoices.void(companyId, invoiceId, user.id, dto);
    }
    return this.approvals.createRequest(
      'void',
      { entity: 'invoice', targetId: invoiceId, ...dto },
      `Void an invoice — ${dto.reason ?? 'no reason given'}`,
      user,
      companyId,
    );
  }

  @Get(':invoiceId/pdf')
  async pdfStream(
    @CurrentCompany() companyId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Res() res: Response,
  ) {
    const invoice = await this.invoices.getById(companyId, invoiceId);
    const customer = await this.customerRepo.findOneByOrFail({
      id: invoice.customerId,
      companyId,
    });
    const company = await this.companyRepo.findOneByOrFail({ id: companyId });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${invoice.invoiceNumber}.pdf"`,
    );
    const stream = this.pdf.render(invoice, customer, company);
    stream.pipe(res);
  }

  @Delete(':invoiceId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    return this.invoices.delete(companyId, invoiceId, user.id);
  }
}
