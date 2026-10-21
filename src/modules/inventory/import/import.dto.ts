import { IsNumberString, IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The text fields sent alongside the file when committing an import.
 *
 * Both concern opening stock, and both are required once the file carries
 * any (InventoryImportService.apply): the date it posts on, and the total
 * value the owner saw in the preview — the commit refuses to post a figure
 * other than the one they confirmed.
 */
export class CommitImportDto {
  @ApiPropertyOptional({ example: '2026-10-21' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'openingStockDate must be a date like 2026-10-21',
  })
  openingStockDate?: string;

  @ApiPropertyOptional({ example: '102000.0000' })
  @IsOptional()
  @IsNumberString()
  confirmOpeningStockValue?: string;
}
