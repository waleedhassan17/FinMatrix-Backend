import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsNumberString, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';
import { CreditOverrideDto } from '../../../common/validation/credit-override.dto';
import { SALES_LINE_KINDS, SalesLineKind } from '../../../common/utils/sales-lines.util';

export class SalesOrderLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty({ example: '1' }) @IsNumberString() quantity!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() unitPrice!: string;
  @ApiPropertyOptional({ example: '0' }) @IsOptional() @IsNumberString() taxRate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;

  @ApiPropertyOptional({
    description:
      'Inventory item id. An order is a commitment and posts nothing, so this ' +
      'drives no COGS here — it is carried to the invoice it becomes, where it does.',
  })
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @ApiPropertyOptional({
    enum: SALES_LINE_KINDS,
    description:
      "'item' sells an inventory item (itemId required); 'service' is a service or " +
      'charge with no stock. In a company that tracks inventory a line without an ' +
      "item must say 'service'.",
  })
  @IsOptional()
  @IsIn(SALES_LINE_KINDS)
  lineKind?: SalesLineKind;
}

export class CreateSalesOrderDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty({ example: '2026-04-23' }) @IsDateString() orderDate!: string;
  @ApiPropertyOptional({ example: '2026-05-10' }) @IsOptional() @IsDateString() expectedDate?: string;

  @ApiPropertyOptional({ enum: ['percent', 'amount', 'none'], default: 'none' })
  @IsOptional() @IsIn(['percent', 'amount', 'none'])
  discountType?: 'percent' | 'amount' | 'none';

  @ApiPropertyOptional({ example: '0' }) @IsOptional() @IsNumberString() discountValue?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiProperty({ type: [SalesOrderLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SalesOrderLineDto)
  lines!: SalesOrderLineDto[];

  @ApiPropertyOptional({
    description:
      'Save even though some items ask for more than is available. Without it a ' +
      'shortfall answers 409 BACKORDER_CONFIRMATION_REQUIRED listing the items.',
  })
  @IsOptional() @IsBoolean() acceptBackorder?: boolean;
}

export class UpdateSalesOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() orderDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['percent', 'amount', 'none'])
  discountType?: 'percent' | 'amount' | 'none';
  @ApiPropertyOptional() @IsOptional() @IsNumberString() discountValue?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [SalesOrderLineDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SalesOrderLineDto)
  lines?: SalesOrderLineDto[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() acceptBackorder?: boolean;
}

export class ListSalesOrdersQueryDto {
  @ApiPropertyOptional()
  @IsOptional() @IsIn(['open', 'partial', 'fulfilled', 'invoiced', 'cancelled'])
  status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class FulfillLineDto {
  @ApiProperty() @IsUUID() lineId!: string;
  @ApiProperty({ example: '5', description: 'Total quantity fulfilled so far for this line.' })
  @IsNumberString() quantityFulfilled!: string;
}

export class FulfillSalesOrderDto {
  @ApiProperty({ type: [FulfillLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => FulfillLineDto)
  lines!: FulfillLineDto[];

  @ApiPropertyOptional({
    type: CreditOverrideDto,
    description: "Owner only: let this go past the customer's credit limit, with a reason (audited).",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreditOverrideDto)
  creditOverride?: CreditOverrideDto;
}

export class ConvertSalesOrderDto {
  @ApiPropertyOptional({ example: '2026-05-23' }) @IsOptional() @IsDateString() dueDate?: string;

  @ApiPropertyOptional({
    type: CreditOverrideDto,
    description: "Owner only: let this go past the customer's credit limit, with a reason (audited).",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreditOverrideDto)
  creditOverride?: CreditOverrideDto;
}
