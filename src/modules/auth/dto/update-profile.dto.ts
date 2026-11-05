import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsPkPhone } from '../../../common/validation/phone';

/**
 * The signed-in user's own profile, as the My account page edits it.
 *
 * The form always sends the whole profile, so this is replace-not-merge: a
 * phone that is left out (or blank) removes the one on file. Email and
 * username are deliberately absent — they are how the person signs in, and
 * changing either needs its own verified flow.
 */
export class UpdateProfileDto {
  @ApiProperty({ example: 'Ali Khan', minLength: 2, maxLength: 120 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  // The column is varchar(120).
  @MaxLength(120, { message: 'Name must be 120 characters or fewer' })
  displayName!: string;

  @ApiPropertyOptional({
    example: '03124890176',
    description:
      'Pakistani mobile, any common format; stored as +923XXXXXXXXX. ' +
      'Omitted or blank removes the phone on file.',
  })
  @IsOptional()
  @IsString()
  @IsPkPhone()
  phone?: string;
}
