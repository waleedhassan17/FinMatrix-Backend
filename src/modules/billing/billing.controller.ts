import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { BankDetailsQueryDto, SubmitPaymentDto } from './dto/billing.dto';
import { isPlanKey, PlanKey } from './plan-config';

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB

/**
 * Company-facing billing endpoints. Deliberately NOT behind CompanyGuard so an
 * `inactive` (expired) account can still reach the renew flow — renewing is the
 * one action an inactive account may take (phase2.md step 6). Tenancy is taken
 * from the JWT (`user.companyId`); business endpoints remain blocked by
 * CompanyGuard elsewhere.
 */
@ApiTags('Billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  private companyIdOf(user: AuthenticatedUser): string {
    if (!user.companyId) {
      throw new ForbiddenException('You must belong to a company to manage billing.');
    }
    return user.companyId;
  }

  private assertAdmin(user: AuthenticatedUser) {
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only a company administrator can manage billing.');
    }
  }

  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.getStatus(this.companyIdOf(user));
  }

  @Get('plan-limits')
  planLimits(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.getPlanLimits(this.companyIdOf(user));
  }

  @Get('bank-details')
  bankDetails(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BankDetailsQueryDto,
  ) {
    this.companyIdOf(user);
    return this.billing.getBankDetails(query.plan as PlanKey);
  }

  @Post('submit')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('screenshot', {
      limits: { fileSize: MAX_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIMES.includes(file.mimetype)) {
          cb(
            new UnsupportedMediaTypeException(
              `Only ${ALLOWED_MIMES.join(', ')} images are accepted`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    // The `plan` text field travels in the multipart body (multer populates
    // req.body → @Body). A query param is accepted as a fallback.
    @Body() body: SubmitPaymentDto,
    @Query('plan') planQuery?: string,
  ) {
    this.assertAdmin(user);
    const companyId = this.companyIdOf(user);
    const candidate = body?.plan ?? planQuery;
    if (!isPlanKey(candidate)) {
      throw new BadRequestException('A valid plan (standard | pro) is required.');
    }
    return this.billing.createSubmission(companyId, user.id, candidate, file);
  }

  @Get('submissions')
  submissions(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.getMySubmissions(this.companyIdOf(user));
  }

  @Get('submissions/:id/screenshot')
  async screenshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const companyId = this.companyIdOf(user);
    await this.billing.assertOwnsSubmission(id, companyId);
    const { stream, mime, length } = await this.billing.getScreenshot(id);
    res.setHeader('Content-Type', mime);
    if (length) res.setHeader('Content-Length', String(length));
    stream.pipe(res);
  }
}
