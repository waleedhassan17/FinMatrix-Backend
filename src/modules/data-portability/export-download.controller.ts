import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { PublicRoute } from '../../common/decorators/public.decorator';
import { CompanyExportService } from './company-export.service';

/**
 * Streams a finished backup to whoever holds its signed link.
 *
 * Its own controller, deliberately without CompanyGuard or RolesGuard: a
 * browser's <a href> and a phone's download manager send no Authorization
 * header, so the token in the query string is the authorisation — minted by
 * the API for that one export, expiring with the file (ExportTokenSigner).
 */
@ApiTags('Data portability')
@PublicRoute()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('data-portability/exports')
export class ExportDownloadController {
  constructor(private readonly exports: CompanyExportService) {}

  @Get(':id/download')
  @ApiOperation({
    summary: 'Download a backup ZIP (signed link; no auth header).',
  })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const file = await this.exports.openDownload(id, token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    if (file.size != null) res.setHeader('Content-Length', String(file.size));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Streamed with @Res() rather than returned as a StreamableFile: the
    // response envelope interceptor would wrap a returned value in JSON.
    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  }
}
