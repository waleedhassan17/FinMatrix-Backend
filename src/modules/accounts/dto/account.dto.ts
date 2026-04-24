import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { AccountType } from '../../../types';

export const ACCOUNT_TYPES: AccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
];

export class CreateAccountDto {
  @ApiProperty({ example: '1500' })
  @IsString()
  @MinLength(2)
  accountNumber!: string;

  @ApiProperty({ example: 'Prepaid Rent' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ enum: ACCOUNT_TYPES })
  @IsIn(ACCOUNT_TYPES)
  type!: AccountType;

  @ApiProperty({ example: 'Prepaid' })
  @IsString()
  subType!: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiPropertyOptional({ example: '0' })
  @IsOptional()
  @IsNumberString()
  openingBalance?: string;
}

export class UpdateAccountDto extends PartialType(CreateAccountDto) {
  // accountNumber and type are immutable per spec — ignore if present.
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListAccountsQueryDto {
  @ApiPropertyOptional({ enum: ACCOUNT_TYPES })
  @IsOptional()
  @IsIn(ACCOUNT_TYPES)
  type?: AccountType;

  @ApiPropertyOptional() @IsOptional() @IsString() subType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
