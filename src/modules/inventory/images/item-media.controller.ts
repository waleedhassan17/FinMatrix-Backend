import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { PublicRoute } from '../../../common/decorators/public.decorator';
import { InventoryImagesService } from './inventory-images.service';
import { ItemImageVariant, MediaUrlSigner } from './media-url.signer';

const FILE_PATTERN = /^(thumb|display)\.jpg$/;

/**
 * Serves item photos to whoever holds a signed link.
 *
 * Its own controller, and deliberately not on InventoryController: that one is
 * guarded by CompanyGuard, RolesGuard and the inventory feature gate, all of
 * which read the session — and these requests have none. An `<img>` tag, the
 * Android image cache and react-pdf all fetch with no Authorization header.
 * The signature checked below IS the authorisation.
 *
 * The throttle is raised rather than removed: the limit is per route per IP,
 * and a shop's whole staff often shares one IP, so a busy item grid would
 * otherwise trip the default 100/min. 1,200/min still stops a scraper.
 */
@ApiTags('Inventory')
@PublicRoute()
@Throttle({ default: { limit: 1200, ttl: 60_000 } })
@Controller('media')
export class ItemMediaController {
  constructor(
    private readonly images: InventoryImagesService,
    private readonly signer: MediaUrlSigner,
  ) {}

  @Get('item-images/:imageId/:file')
  @ApiOperation({
    summary: 'Stream an item photo (signed link; no auth header).',
  })
  async itemImage(
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Param('file') file: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() res: Response,
  ) {
    const match = FILE_PATTERN.exec(file);
    if (!match)
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Not found.',
      });
    const variant = match[1] as ItemImageVariant;

    if (!this.signer.verify(imageId, variant, exp, sig)) {
      throw new ForbiddenException({
        code: 'MEDIA_LINK_INVALID',
        message:
          'This photo link has expired. Reload the page to get a fresh one.',
      });
    }

    const stored = await this.images.openVariant(imageId, variant);
    res.setHeader('Content-Type', 'image/jpeg');
    if (stored.size != null)
      res.setHeader('Content-Length', String(stored.size));
    // A rendition never changes — replacing a photo makes a new image id — so
    // the bytes behind this URL are immutable for as long as the link lives.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    // helmet sends `same-origin` on every response, which makes the browser
    // refuse this image on the web app's own (different) origin.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Streamed with @Res() rather than returned as a StreamableFile: the
    // response envelope interceptor would wrap a returned value in JSON.
    stored.stream.on('error', () => res.destroy());
    stored.stream.pipe(res);
  }
}
