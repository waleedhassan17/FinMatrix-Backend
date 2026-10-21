import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../../common/decorators/current-company.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../../common/guards/company.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RequiresFeature } from '../../../common/features/requires-feature.decorator';
import { InventoryImportService } from './inventory-import.service';
import { CommitImportDto } from './import.dto';
import { MAX_IMPORT_FILE_BYTES } from './import-columns';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/**
 * What browsers and phones actually report for a spreadsheet. Android's file
 * picker often says application/octet-stream, so the extension is accepted
 * as an alternative — and either way it is the file's BYTES that
 * readImportFile goes by.
 */
const ACCEPTED_MIMES = [
  XLSX_MIME,
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
];

interface UploadedSheet {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

const importFile = () =>
  FileInterceptor('file', {
    limits: { fileSize: MAX_IMPORT_FILE_BYTES },
    fileFilter: (_req, file, cb) => {
      const name = file.originalname.toLowerCase();
      if (name.endsWith('.xls')) {
        cb(
          new UnsupportedMediaTypeException({
            code: 'IMPORT_UNSUPPORTED_FILE',
            message:
              'This is an old Excel 97–2003 (.xls) file. Open it in Excel, choose Save As → Excel Workbook (.xlsx), and upload that.',
          }),
          false,
        );
        return;
      }
      if (
        name.endsWith('.xlsx') ||
        name.endsWith('.csv') ||
        ACCEPTED_MIMES.includes(file.mimetype)
      ) {
        cb(null, true);
        return;
      }
      cb(
        new UnsupportedMediaTypeException({
          code: 'IMPORT_UNSUPPORTED_FILE',
          message: 'Upload an Excel (.xlsx) or CSV file.',
        }),
        false,
      );
    },
  });

const fileBody = (extra: Record<string, object> = {}) =>
  ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' }, ...extra },
    },
  });

/**
 * multer decodes the filename as latin1, so "Ṣofa list.xlsx" arrives mangled.
 * Re-reading the bytes as UTF-8 recovers it; pure-ASCII names are unchanged.
 */
const utf8Name = (name: string) => {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
};

function requireFile(file: UploadedSheet | undefined) {
  if (!file) {
    throw new BadRequestException({
      code: 'IMPORT_FILE_REQUIRED',
      message: 'Choose an Excel (.xlsx) or CSV file to import.',
    });
  }
  return { buffer: file.buffer, originalname: utf8Name(file.originalname) };
}

/**
 * Import inventory items from a spreadsheet. Staff may import as they may
 * create and edit items one at a time; opening stock in the file is the
 * owner's alone, which InventoryImportService enforces per row with a warning
 * the preview shows.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@RequiresFeature('inventory')
@Controller('inventory/import')
export class InventoryImportController {
  constructor(private readonly svc: InventoryImportService) {}

  /**
   * The .xlsx template; `prefill=true` fills it with every item instead, for
   * the export → edit in Excel → import round trip.
   */
  @Get('template')
  @Roles('admin', 'staff')
  @ApiOperation({
    summary:
      'Download the item import template (or, with prefill=true, all items).',
  })
  async template(
    @CurrentCompany() companyId: string,
    @Query('prefill') prefill: string | undefined,
    @Res() res: Response,
  ) {
    const filled = prefill === 'true' || prefill === '1';
    const buffer = await this.svc.template(companyId, filled);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filled ? 'inventory-items' : 'inventory-import-template'}.xlsx"`,
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
  }

  /** What importing this file would do. Writes nothing. */
  @Post('preview')
  @HttpCode(200)
  @Roles('admin', 'staff')
  @ApiOperation({
    summary:
      'Preview an item import: per-row create/update/unchanged/error, nothing saved.',
  })
  @ApiConsumes('multipart/form-data')
  @fileBody()
  @UseInterceptors(importFile())
  preview(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: UploadedSheet,
  ) {
    return this.svc.preview(companyId, user, requireFile(file));
  }

  /**
   * Apply every valid row of the file in one transaction. Send an
   * Idempotency-Key: a retried commit then replays the first answer instead
   * of running again.
   */
  @Post()
  @HttpCode(200)
  @Roles('admin', 'staff')
  @ApiOperation({
    summary:
      'Import items: applies every valid row; rows with errors are skipped and reported.',
  })
  @ApiConsumes('multipart/form-data')
  @fileBody({
    openingStockDate: { type: 'string', example: '2026-10-21' },
    confirmOpeningStockValue: { type: 'string', example: '102000.0000' },
  })
  @UseInterceptors(importFile())
  commit(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CommitImportDto,
    @UploadedFile() file?: UploadedSheet,
  ) {
    return this.svc.commit(companyId, user, requireFile(file), dto);
  }
}
