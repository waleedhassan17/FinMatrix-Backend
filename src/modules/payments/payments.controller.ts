import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { ListPaymentsQueryDto, ReceivePaymentDto } from './dto/payment.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @Roles('admin')
  @ApiOperation({
    summary: 'Receive customer payment. Auto-applies if no applications given.',
  })
  receive(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReceivePaymentDto,
  ) {
    return this.payments.receive(companyId, user.id, dto);
  }

  @Get('customer/:customerId/outstanding')
  @ApiOperation({ summary: 'List unpaid invoices for a customer.' })
  outstanding(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.payments.outstanding(companyId, customerId);
  }

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListPaymentsQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.payments.list(companyId, query, pagination);
  }

  @Get(':paymentId')
  get(
    @CurrentCompany() companyId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    return this.payments.getById(companyId, paymentId);
  }
}
