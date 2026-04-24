import { IsString, IsOptional, IsUUID, IsEnum, IsNumberString, IsBoolean, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBankAccountDto {
  @ApiProperty() @IsString() @Length(1, 200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) bankName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 128) accountNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['checking', 'savings', 'credit_card']) accountType?: string;
  @ApiProperty() @IsUUID() linkedAccountId!: string;
}

export class UpdateBankAccountDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateBankTransactionDto {
  @ApiProperty() @IsUUID() bankAccountId!: string;
  @ApiProperty() @IsString() date!: string;
  @ApiProperty() @IsEnum(['deposit', 'check', 'expense', 'transfer', 'fee']) type!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() payee?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiProperty() @IsNumberString() amount!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;
}

export class ReconcileDto {
  @ApiProperty() @IsString() endDate!: string;
  @ApiProperty() @IsNumberString() endingBalance!: string;
}

export class BankAccountQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
