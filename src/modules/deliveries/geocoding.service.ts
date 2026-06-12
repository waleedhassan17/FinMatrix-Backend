import { Injectable, Logger } from '@nestjs/common';

export interface GeoPoint {
  lat: number;
  lng: number;
}

interface AddressLike {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

/**
 * Thin wrapper around the Google Geocoding API.
 *
 * Production setup:
 *   1. Enable the "Geocoding API" in Google Cloud Console.
 *   2. Set GOOGLE_MAPS_API_KEY (a *server* key, IP-restricted) in the
 *      backend environment.
 *
 * Every method degrades gracefully — if the key is missing or the call
 * fails, geocoding returns null so delivery creation is never blocked.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly apiKey =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_GEOCODING_API_KEY ||
    '';

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  /** Join a structured address into a single geocodable string. */
  static formatAddress(addr: AddressLike | null | undefined): string {
    if (!addr) return '';
    return [addr.street, addr.city, addr.state, addr.postalCode, addr.country]
      .map((p) => (p == null ? '' : String(p).trim()))
      .filter(Boolean)
      .join(', ');
  }

  /**
   * Convert a free-form address into coordinates. Returns null on any
   * failure (missing key, network error, no result) so callers can keep
   * working without a pin.
   */
  async geocode(address: string): Promise<GeoPoint | null> {
    const query = (address || '').trim();
    if (!query) return null;
    if (!this.apiKey) {
      this.logger.warn('GOOGLE_MAPS_API_KEY not set — skipping geocoding');
      return null;
    }
    try {
      const url =
        'https://maps.googleapis.com/maps/api/geocode/json' +
        `?address=${encodeURIComponent(query)}&key=${this.apiKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(`Geocoding HTTP ${res.status} for "${query}"`);
        return null;
      }
      const data: any = await res.json();
      if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
        this.logger.warn(`Geocoding status "${data.status}" for "${query}"`);
        return null;
      }
      const loc = data.results[0]?.geometry?.location;
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
        return null;
      }
      return { lat: loc.lat, lng: loc.lng };
    } catch (err) {
      this.logger.warn(`Geocoding failed for "${query}": ${(err as Error).message}`);
      return null;
    }
  }
}
