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
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isReconciled?: boolean;
}

export class BankTransactionQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() bankAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isReconciled?: boolean;
}

export class CreateTransferDto {
  @ApiProperty() @IsUUID() fromAccountId!: string;
  @ApiProperty() @IsUUID() toAccountId!: string;
  @ApiProperty() @IsNumberString() amount!: string;
  @ApiProperty() @IsString() date!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;
}

export class ReconcileDto {
  @ApiProperty() @IsUUID() bankAccountId!: string;
  @ApiProperty() @IsString() statementDate!: string;
  @ApiProperty() @IsNumberString() beginningBalance!: string;
  @ApiProperty() @IsNumberString() endingBalance!: string;
  @ApiProperty() @IsString({ each: true }) clearedTransactionIds!: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() adjustmentTransactionId?: string | null;
}

export class BankAccountQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
