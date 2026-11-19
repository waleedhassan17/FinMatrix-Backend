import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentCompany } from '../../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CompanyGuard } from '../../../common/guards/company.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { StartUploadDto } from '../dto/migration.dto';
import {
  MigrationUploadsService,
  readRawBody,
  UPLOAD_PART_BYTES,
} from './migration-uploads.service';

/**
 * Large uploads (a Peachtree backup), in 8 MB pieces: start (or resume),
 * send each piece, complete. The background reader takes it from there; the
 * batch's `uploads` show its progress. Owner only, like the rest of the
 * Migration Center. A 2 GB backup is 256 pieces, so this controller allows
 * more requests a minute than the default.
 */
@ApiTags('Migration Center')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Roles('admin')
@Throttle({ default: { limit: 600, ttl: 60_000 } })
@Controller('migrations/:id/uploads')
export class MigrationUploadsController {
  constructor(private readonly uploads: MigrationUploadsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Start uploading a Peachtree backup (.ptb), or resume the one already started with the same name and size.',
  })
  start(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartUploadDto,
  ) {
    return this.uploads.start(companyId, user, id, dto);
  }

  @Get()
  @ApiOperation({ summary: "This migration's recent uploads, newest first." })
  list(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.uploads.listForBatch(companyId, id);
  }

  @Get(':uploadId')
  @ApiOperation({
    summary:
      'One upload: the pieces received (to resume) and the reading progress.',
  })
  status(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ) {
    return this.uploads.status(companyId, id, uploadId);
  }

  @Put(':uploadId/parts/:partNo')
  @HttpCode(200)
  @ApiConsumes('application/octet-stream')
  @ApiOperation({
    summary:
      'One 8 MB piece, as raw bytes. Optional x-part-sha256 header (hex) is checked. Sending a piece again replaces it.',
  })
  async part(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Param('partNo', ParseIntPipe) partNo: number,
    @Headers('x-part-sha256') sha256: string | undefined,
    @Req() req: Request,
  ) {
    const body = await readRawBody(req, UPLOAD_PART_BYTES);
    return this.uploads.putPart(companyId, id, uploadId, partNo, body, sha256);
  }

  @Post(':uploadId/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Every piece is sent: check them and queue the backup to be read.',
  })
  complete(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ) {
    return this.uploads.complete(companyId, id, uploadId);
  }

  @Delete(':uploadId')
  @ApiOperation({ summary: 'Cancel an upload and drop its pieces.' })
  cancel(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ) {
    return this.uploads.cancel(companyId, id, uploadId);
  }
}
