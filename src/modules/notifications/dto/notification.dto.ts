import { IsBoolean, IsOptional, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class NotificationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isRead?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['info', 'warning', 'success', 'error']) type?: string;
}
