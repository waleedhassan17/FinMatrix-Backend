import sharp from 'sharp';
import { DISPLAY_EDGE, THUMB_EDGE, processItemImage } from './item-image.processor';

/** A solid-colour image of the given size and format. */
const image = (width: number, height: number, format: 'jpeg' | 'png' | 'webp', alpha = false) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 200, g: 120, b: 40 },
    },
  })
    [format]()
    .toBuffer();

describe('processItemImage', () => {
  it('turns any accepted format into a display JPEG and a thumbnail JPEG', async () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const out = await processItemImage(await image(800, 600, format));
      expect((await sharp(out.display.buffer).metadata()).format).toBe('jpeg');
      expect((await sharp(out.thumb.buffer).metadata()).format).toBe('jpeg');
      expect([out.display.width, out.display.height]).toEqual([800, 600]);
      expect([out.thumb.width, out.thumb.height]).toEqual([THUMB_EDGE, 360]);
    }
  });

  it('shrinks a large photo, keeping its shape, and never enlarges a small one', async () => {
    const big = await processItemImage(await image(4000, 3000, 'jpeg'));
    expect([big.display.width, big.display.height]).toEqual([DISPLAY_EDGE, 1200]);

    const small = await processItemImage(await image(200, 100, 'jpeg'));
    expect([small.display.width, small.display.height]).toEqual([200, 100]);
    expect([small.thumb.width, small.thumb.height]).toEqual([200, 100]);
  });

  it('applies the EXIF orientation and strips the metadata', async () => {
    // Orientation 6 = "rotate 90° clockwise to display": how a phone saves a
    // portrait photo. The stored pixels are landscape.
    const portraitFromPhone = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const out = await processItemImage(portraitFromPhone);
    expect([out.display.width, out.display.height]).toEqual([20, 40]);
    const meta = await sharp(out.display.buffer).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it('puts a transparent PNG on white, since JPEG has no alpha', async () => {
    const out = await processItemImage(await image(10, 10, 'png', true));
    const { data } = await sharp(out.display.buffer).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]].every((v) => v > 245)).toBe(true);
  });

  it('refuses bytes that are not an image, with a 415 a person can read', async () => {
    await expect(processItemImage(Buffer.from('%PDF-1.7 not a photo'))).rejects.toMatchObject({
      status: 415,
      response: { code: 'IMAGE_UNREADABLE' },
    });
  });

  it('refuses an image format it does not store, decided from the bytes', async () => {
    const gif = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .gif()
      .toBuffer();
    await expect(processItemImage(gif)).rejects.toMatchObject({ status: 415 });
  });
});
