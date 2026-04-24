import { IsString, IsOptional, IsUUID, IsNumberString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ShadowSyncStatus } from '../../../types';

export class CreateSnapshotDto {
  @ApiProperty() @IsUUID() personnelId!: string;
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsNumberString() originalQty!: string;
  @ApiProperty() @IsNumberString() currentQty!: string;
}

export class UpdateSnapshotDto {
  @ApiPropertyOptional() @IsOptional() @IsNumberString() currentQty?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['synced', 'pending'] as ShadowSyncStatus[]) syncStatus?: ShadowSyncStatus;
}
