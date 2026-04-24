import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PK_PHONE_REGEX } from '../../auth/dto/signup.dto';

class AddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() street?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() postalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
}

export class CreateCompanyDto {
  @ApiProperty({ example: 'Ali Traders' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() industry?: string;

  @ApiPropertyOptional({ type: AddressDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional({ example: '+92-42-1234567' })
  @IsOptional()
  @IsString()
  @Matches(PK_PHONE_REGEX, {
    message: 'Phone must match Pakistani format +92-XXX-XXXXXXX',
  })
  phone?: string;

  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() taxId?: string;

  @ApiPropertyOptional({ description: 'URL or base64 logo string' })
  @IsOptional()
  @IsString()
  logo?: string;
}

export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {}

export class JoinCompanyDto {
  @ApiProperty({ example: 'AB12CD' })
  @IsString()
  @MinLength(4)
  code!: string;
}
