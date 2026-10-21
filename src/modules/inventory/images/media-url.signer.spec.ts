import { ConfigService } from '@nestjs/config';
import { MediaUrlSigner } from './media-url.signer';

const config = (values: Record<string, string>) =>
  ({ get: (key: string, fallback?: string) => values[key] ?? fallback }) as unknown as ConfigService;

const signer = (extra: Record<string, string> = {}) =>
  new MediaUrlSigner(
    config({
      JWT_SECRET: 'x'.repeat(40),
      APP_URL: 'https://api.example.com/',
      API_PREFIX: '/api/v1/',
      ...extra,
    }),
  );

const IMAGE = '0b6f2b0e-3d4c-4c38-9a7c-0d1e2f3a4b5c';
const NOW = Date.UTC(2026, 9, 21, 10, 30);

/** Pull exp and sig back out of a URL the signer issued. */
const parts = (url: string) => {
  const u = new URL(url);
  return { path: u.pathname, exp: u.searchParams.get('exp')!, sig: u.searchParams.get('sig')! };
};

describe('MediaUrlSigner', () => {
  it('builds both URLs on the API host, ending in .jpg', () => {
    const { imageUrl, thumbnailUrl } = signer().urlsFor(IMAGE, NOW);
    expect(parts(imageUrl!).path).toBe(`/api/v1/media/item-images/${IMAGE}/display.jpg`);
    expect(parts(thumbnailUrl!).path).toBe(`/api/v1/media/item-images/${IMAGE}/thumb.jpg`);
    // The web PDF renderer only embeds an https URL that says .jpg/.png.
    expect(imageUrl).toMatch(/^https:\/\/.+\.jpg\?/);
  });

  it('answers null for an item with no photo', () => {
    expect(signer().urlsFor(null)).toEqual({ imageUrl: null, thumbnailUrl: null });
  });

  it('verifies its own signature', () => {
    const s = signer();
    const { exp, sig } = parts(s.urlsFor(IMAGE, NOW).thumbnailUrl!);
    expect(s.verify(IMAGE, 'thumb', exp, sig, NOW)).toBe(true);
  });

  it('refuses a signature moved to another image or rendition', () => {
    const s = signer();
    const { exp, sig } = parts(s.urlsFor(IMAGE, NOW).thumbnailUrl!);
    expect(s.verify(IMAGE, 'display', exp, sig, NOW)).toBe(false);
    expect(s.verify('11111111-2222-4333-8444-555555555555', 'thumb', exp, sig, NOW)).toBe(false);
  });

  it('refuses a stretched expiry or a tampered signature', () => {
    const s = signer();
    const { exp, sig } = parts(s.urlsFor(IMAGE, NOW).thumbnailUrl!);
    expect(s.verify(IMAGE, 'thumb', String(Number(exp) + 86_400), sig, NOW)).toBe(false);
    expect(s.verify(IMAGE, 'thumb', exp, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'), NOW)).toBe(false);
    expect(s.verify(IMAGE, 'thumb', exp, undefined, NOW)).toBe(false);
    expect(s.verify(IMAGE, 'thumb', 'soon', sig, NOW)).toBe(false);
  });

  it('expires after at least seven days and refuses links from the far future', () => {
    const s = signer();
    const { exp, sig } = parts(s.urlsFor(IMAGE, NOW).thumbnailUrl!);
    const day = 86_400_000;
    expect(s.verify(IMAGE, 'thumb', exp, sig, NOW + 7 * day)).toBe(true);
    expect(s.verify(IMAGE, 'thumb', exp, sig, NOW + 9 * day)).toBe(false);
    // A link "issued" ten days ahead could only come from a forged clock.
    const far = MediaUrlSigner.expiryFor(NOW + 10 * day);
    expect(s.verify(IMAGE, 'thumb', String(far), sig, NOW)).toBe(false);
  });

  it('issues the identical URL all day, so caches keep hitting', () => {
    const s = signer();
    const morning = s.urlsFor(IMAGE, Date.UTC(2026, 9, 21, 0, 1)).thumbnailUrl;
    const night = s.urlsFor(IMAGE, Date.UTC(2026, 9, 21, 23, 59)).thumbnailUrl;
    const tomorrow = s.urlsFor(IMAGE, Date.UTC(2026, 9, 22, 0, 1)).thumbnailUrl;
    expect(night).toBe(morning);
    expect(tomorrow).not.toBe(morning);
  });

  it('a different key cannot verify, and MEDIA_URL_SECRET takes precedence over JWT_SECRET', () => {
    const issued = parts(signer().urlsFor(IMAGE, NOW).thumbnailUrl!);
    const other = signer({ MEDIA_URL_SECRET: 'm'.repeat(40) });
    expect(other.verify(IMAGE, 'thumb', issued.exp, issued.sig, NOW)).toBe(false);
  });
});
