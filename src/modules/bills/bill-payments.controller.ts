import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { BillsService } from './bills.service';
import { PayBillsDto } from './dto/bill.dto';

/**
 * PDF as well as images: a bank transfer confirmation usually arrives as a
 * PDF, while a cash payment has no screenshot at all and is evidenced by a
 * photo of the signed voucher.
 */
const ALLOWED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];
// UPLOAD_MAX_SIZE_MB is declared in env.validation.ts with a default of 5 but
// was never read anywhere; this wires it up rather than inventing a third
// hardcoded limit (bill-photo carries its own 8 MB constant).
const MAX_FILE_SIZE =
  Number(process.env.UPLOAD_MAX_SIZE_MB ?? 5) * 1024 * 1024;

@ApiTags('bill-payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('bill-payments')
export class BillPaymentsController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query('billId') billId: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.bills.listPayments(companyId, billId, page, limit);
  }

  /**
   * Step one of recording a payment: upload the evidence and get back an id.
   *
   * Kept off the pay endpoint deliberately — that one stays JSON, so the
   * financial path is not also a multipart parser.
   */
  @Post('proofs')
  @Roles('admin')
  @ApiOperation({ summary: 'Upload a payment proof; returns an id for POST /bill-payments.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['proof'],
      properties: { proof: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('proof', {
      limits: { fileSize: MAX_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIMES.includes(file.mimetype)) {
          cb(
            new UnsupportedMediaTypeException(
              'A payment proof must be a JPG, PNG, WEBP or PDF.',
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadProof(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile()
    file?: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'PAYMENT_PROOF_REQUIRED',
        message:
          'A payment proof (receipt or screenshot) is required to record a bill payment.',
      });
    }
    return this.bills.createPaymentProof(companyId, user.id, file);
  }

  /**
   * The route StorageService baked into the proof's URL at upload time. Auth
   * stays on it, which is why the app downloads with its token rather than
   * pointing an <Image> straight at the URL.
   */
  @Get('proofs/:proofId/file')
  @Roles('admin', 'staff')
  async readProof(
    @CurrentCompany() companyId: string,
    @Param('proofId', ParseUUIDPipe) proofId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { file, proof } = await this.bills.readPaymentProof(companyId, proofId);
    res.set({
      'Content-Type': file.mimeType ?? proof.mimeType,
      'Content-Disposition': `inline; filename="${proof.originalName.replace(/"/g, '')}"`,
    });
    return new StreamableFile(file.stream);
  }

  @Post()
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pay bills via Accounts Payable.' })
  createBillPayment(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PayBillsDto,
  ) {
    // Reusing the bills pay logic as it matches exactly the requested domain.
    // The proof requirement lives in the service, not here — POST /bills/pay
    // is a second door into the same method and must be covered too.
    return this.bills.pay(companyId, user.id, dto);
  }
}
