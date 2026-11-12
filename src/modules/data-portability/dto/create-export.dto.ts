import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class CreateExportDto {
  @ApiPropertyOptional({
    description:
      'Also include FinMatrix-Export.xlsx, one sheet per CSV. Larger and slower; the CSVs are the canonical data.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeXlsx?: boolean;
}
