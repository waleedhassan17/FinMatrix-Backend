import {
  Body,
  Controller,
  Get,
  HttpCode,
  ParseIntPipe,
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
import { BillsService } from './bills.service';
import { PayBillsDto } from './dto/bill.dto';

@ApiTags('bill-payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('bill-payments')
export class BillPaymentsController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query('billId') billId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.bills.listPayments(companyId, billId, page, limit);
  }

  @Post()
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pay bills via Accounts Payable.' })
  createBillPayment(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PayBillsDto,
  ) {
    // Reusing the bills pay logic as it matches exactly the requested domain
    return this.bills.pay(companyId, user.id, dto);
  }
}
