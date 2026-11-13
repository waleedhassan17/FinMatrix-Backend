import {
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CreateMigrationDto,
  IssuesQueryDto,
  PatchMappingsDto,
  ResolveIssueDto,
  SignOffDto,
} from './dto/migration.dto';
import {
  MigrationBatchService,
  UploadedMigrationFile,
} from './migration-batch.service';

const MAX_FILE_BYTES = Number(
  process.env.MIGRATION_MAX_FILE_BYTES ?? 26_214_400,
);
const MAX_FILES = 20;
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * multer refuses an oversized file with a bare 413. The Migration Center's
 * clients map codes to sentences, so the refusal carries its own code.
 */
@Injectable()
class MigrationUploadInterceptor extends FilesInterceptor('files', MAX_FILES, {
  limits: { fileSize: MAX_FILE_BYTES },
}) {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (err) {
      if (err instanceof PayloadTooLargeException) {
        throw new PayloadTooLargeException({
          code: 'MIGRATION_FILE_TOO_LARGE',
          message: `A file is larger than the ${Math.round(MAX_FILE_BYTES / 1_048_576)} MB limit. Split it into smaller files.`,
        });
      }
      throw err;
    }
  }
}

/**
 * Migration Center (§1.3). Owner only on every plan: staff never see it in
 * either app, and every route here refuses them.
 */
@ApiTags('Migration Center')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Roles('admin')
@Controller('migrations')
export class MigrationsController {
  constructor(private readonly svc: MigrationBatchService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a migration batch (fresh start: the books must be empty).',
  })
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMigrationDto,
  ) {
    return this.svc.create(companyId, user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Migration batches, newest first.' })
  list(@CurrentCompany() companyId: string) {
    return this.svc.list(companyId);
  }

  @Get('template')
  @ApiOperation({ summary: 'Download the starter workbook (XLSX).' })
  async template(
    @CurrentCompany() companyId: string,
    @Query('cutoverDate') cutoverDate: string | undefined,
    @Res() res: Response,
  ) {
    const buffer = await this.svc.template(companyId, cutoverDate);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="FinMatrix-Starter-Workbook.xlsx"',
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One batch: step, readiness, counts, files, checks.',
  })
  get(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.get(companyId, id);
  }

  @Post(':id/files')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload one or more files (XLSX, CSV, Tally XML, or a ZIP of them).',
  })
  @UseInterceptors(MigrationUploadInterceptor)
  addFiles(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: UploadedMigrationFile[],
  ) {
    return this.svc.addFiles(companyId, user, id, files);
  }

  @Delete(':id/files/:fileId')
  @ApiOperation({ summary: 'Remove an uploaded file.' })
  removeFile(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    return this.svc.removeFile(companyId, user, id, fileId);
  }

  @Get(':id/mappings')
  @ApiOperation({
    summary:
      'Sheet, column, value and account mappings with confidence and origin.',
  })
  mappings(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getMappings(companyId, id);
  }

  @Patch(':id/mappings')
  @ApiOperation({ summary: 'Confirm or correct mappings.' })
  patchMappings(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchMappingsDto,
  ) {
    return this.svc.patchMappings(companyId, user, id, dto.mappings);
  }

  @Get(':id/issues')
  @ApiOperation({ summary: 'Problems grouped by code, paged.' })
  issues(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: IssuesQueryDto,
  ) {
    return this.svc.listIssues(companyId, id, q);
  }

  @Patch(':id/issues/:issueId')
  @ApiOperation({
    summary:
      'Resolve an issue: edit a value, choose a mapping, or skip with a reason.',
  })
  resolveIssue(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() dto: ResolveIssueDto,
  ) {
    return this.svc.resolveIssue(companyId, user, id, issueId, dto);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run the nine hard checks; returns readiness and every check.',
  })
  validate(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.validate(companyId, user, id);
  }

  @Post(':id/dry-run')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Full commit inside a transaction that is always rolled back; returns the certificate preview.',
  })
  dryRun(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.dryRun(companyId, user, id);
  }

  @Post(':id/sign-off')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The owner confirms the certificate and the spot checks.',
  })
  signOff(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignOffDto,
  ) {
    return this.svc.signOff(companyId, user, id, dto);
  }

  @Post(':id/commit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Post the batch (ready and signed off only).' })
  commit(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.commit(companyId, user, id);
  }

  @Post(':id/rollback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Undo a committed batch (before close only).' })
  rollback(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.rollback(companyId, user, id);
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close the migration; it can no longer be undone.' })
  close(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.close(companyId, user, id);
  }

  @Get(':id/certificate')
  @ApiOperation({
    summary: 'Reconciliation certificate PDF (a preview before commit).',
  })
  async certificate(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.svc.certificate(companyId, user, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Certificate-Preview', file.preview ? 'true' : 'false');
    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  }
}
