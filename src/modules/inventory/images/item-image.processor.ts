import {
  Logger,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Sharp, SharpOptions } from 'sharp';

type SharpFactory = (input?: Buffer, options?: SharpOptions) => Sharp;

export interface ImageRendition {
  buffer: Buffer;
  width: number;
  height: number;
  size: number;
}

export interface ProcessedItemImage {
  display: ImageRendition;
  thumb: ImageRendition;
}

/** Decided from the file's bytes, never from the client's declared mimetype. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
/** Long edge of the rendition shown on the item page. */
export const DISPLAY_EDGE = 1600;
/** Long edge of the rendition used by lists, pickers and PDF lines. */
export const THUMB_EDGE = 480;
/**
 * A 40 MP ceiling — above any phone camera, far below a decompression bomb.
 * A 12 MP photo decodes to ~36 MB of pixels; this caps the worst case at ~120.
 */
const MAX_INPUT_PIXELS = 40_000_000;

const logger = new Logger('ItemImageProcessor');
let sharpModule: Promise<SharpFactory | null> | null = null;

/**
 * sharp is a native module. It is loaded on first use, not at boot, so a
 * deploy target whose build did not fetch the binary (an Alpine image, a
 * serverless bundle) still starts the API — photo uploads alone fail, with a
 * 503 that says why, instead of every route failing with it.
 */
function loadSharp(): Promise<SharpFactory | null> {
  sharpModule ??= import('sharp')
    .then((mod) => {
      const sharp = (mod.default ?? mod) as unknown as SharpFactory & {
        concurrency(n: number): number;
        cache(on: boolean): unknown;
      };
      // One libvips thread and no operation cache: a web dyno has 512 MB, and
      // photo uploads are rare enough that latency matters less than headroom.
      sharp.concurrency(1);
      sharp.cache(false);
      return sharp as SharpFactory;
    })
    .catch((err: Error) => {
      logger.error(
        `sharp is unavailable, item photos cannot be processed: ${err.message}`,
      );
      return null;
    });
  return sharpModule;
}

const unreadable = (message: string) =>
  new UnsupportedMediaTypeException({ code: 'IMAGE_UNREADABLE', message });

/**
 * Normalise an uploaded photo into the two JPEG renditions FinMatrix stores.
 *
 *   • `.rotate()` applies the EXIF orientation, so a portrait phone photo is
 *     upright everywhere — including react-pdf, which ignores EXIF.
 *   • Output carries NO metadata (sharp's default). Phone photos embed GPS
 *     coordinates; a quotation sent to a customer must not.
 *   • Transparency is flattened onto white: product shots on white is what a
 *     catalogue looks like, and JPEG has no alpha.
 *   • JPEG rather than WEBP because both PDF renderers (react-pdf on the web,
 *     the Android print WebView in the app) must be able to embed it.
 *
 * The thumbnail is made from the display rendition rather than the original,
 * so the large decode happens once.
 */
export async function processItemImage(
  input: Buffer,
): Promise<ProcessedItemImage> {
  const sharp = await loadSharp();
  if (!sharp) {
    throw new ServiceUnavailableException({
      code: 'IMAGE_PROCESSING_UNAVAILABLE',
      message:
        'Photos cannot be processed on this server right now. Please try again later.',
    });
  }

  const options: SharpOptions = {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: 'error',
  };
  let format: string | undefined;
  try {
    format = (await sharp(input, options).metadata()).format;
  } catch {
    throw unreadable(
      'That file could not be read as a photo. Use a JPG, PNG or WEBP image.',
    );
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) {
    throw unreadable('Item photos must be JPG, PNG or WEBP images.');
  }

  try {
    const display = await sharp(input, options)
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: DISPLAY_EDGE,
        height: DISPLAY_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    const thumb = await sharp(display.data)
      .resize({
        width: THUMB_EDGE,
        height: THUMB_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      display: {
        buffer: display.data,
        width: display.info.width,
        height: display.info.height,
        size: display.info.size,
      },
      thumb: {
        buffer: thumb.data,
        width: thumb.info.width,
        height: thumb.info.height,
        size: thumb.info.size,
      },
    };
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (/pixel limit/i.test(message)) {
      throw unreadable(
        'That photo is too large. Use an image under 40 megapixels.',
      );
    }
    throw unreadable(
      'That file could not be read as a photo. Use a JPG, PNG or WEBP image.',
    );
  }
}
