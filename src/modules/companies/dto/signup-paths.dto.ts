import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /companies/:id/submit — sign-up path B, "Request account
 * approval". Both fields are optional so the clients already in the field,
 * which send no body, keep working.
 */
export class SubmitForApprovalDto {
  @ApiPropertyOptional({
    description:
      "The plan the owner agreed with FinMatrix (a plan key), or 'unsure'.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  requestedPlan?: string;

  @ApiPropertyOptional({ description: 'Anything the owner wants to add.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Body for POST /companies/:id/activation-request. */
export class ActivationRequestDto {
  @ApiPropertyOptional({
    description: "The plan the owner wants (a plan key), or 'unsure'.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  requestedPlan?: string;

  @ApiPropertyOptional({ description: 'A note for the FinMatrix team.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
