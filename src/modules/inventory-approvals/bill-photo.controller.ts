import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  UnsupportedMediaTypeException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { InventoryApprovalsService } from './inventory-approvals.service';
import { SubmitBillPhotoDto } from './dto/inventory-approval.dto';

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB

@ApiTags('Deliveries — Bill Photo')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('deliveries')
export class BillPhotoController {
  constructor(private readonly svc: InventoryApprovalsService) {}

  /**
   * POST /api/v1/deliveries/:deliveryId/bill-photo
   *
   * Delivery personnel uploads a photo of the customer-signed bill.
   * Creates a pending InventoryUpdateRequest for admin review.
   */
  @Post(':deliveryId/bill-photo')
  @Roles('delivery')
  @UseInterceptors(
    FileInterceptor('photo', {
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
  @ApiOperation({
    summary: 'Submit bill photo (delivery personnel)',
    description:
      'Upload a photo of the manually signed bill. Creates a pending inventory update request for admin approval.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'deliveryId', type: 'string', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['photo', 'signedBy', 'source', 'changes'],
      properties: {
        photo: { type: 'string', format: 'binary', description: 'Bill photo (jpeg/png/webp, max 8 MB)' },
        signedBy: { type: 'string', description: 'Customer name on the signed bill' },
        source: { type: 'string', enum: ['camera', 'gallery'] },
        note: { type: 'string', description: 'Optional note' },
        changes: {
          type: 'string',
          description:
            'JSON-stringified array: [{ itemId, itemName, beforeQty, deliveredQty, returnedQty }]',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Bill photo submitted successfully',
    schema: {
      example: {
        success: true,
        data: {
          requestId: 'uuid',
          deliveryId: 'uuid',
          photoUrl: 'https://...',
          uploadedAt: '2026-03-16T08:35:00Z',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Missing/invalid fields' })
  @ApiResponse({ status: 403, description: 'Delivery not assigned to caller' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  @ApiResponse({ status: 409, description: 'Duplicate request for this delivery' })
  @ApiResponse({ status: 413, description: 'File too large (max 8 MB)' })
  @ApiResponse({ status: 415, description: 'Unsupported media type' })
  async submitBillPhoto(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: SubmitBillPhotoDto,
  ) {
    if (!file) {
      throw new BadRequestException('photo file is required');
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new PayloadTooLargeException('File exceeds 8 MB limit');
    }

    const result = await this.svc.submitBillPhoto(
      companyId,
      deliveryId,
      user.id,
      user.email, // fallback; displayName isn't on JWT payload
      file,
      body,
    );

    return { success: true, data: result };
  }
}
