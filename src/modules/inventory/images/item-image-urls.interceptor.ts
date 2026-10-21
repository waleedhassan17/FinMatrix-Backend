import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { InventoryItem } from '../entities/inventory-item.entity';
import { MediaUrlSigner } from './media-url.signer';

/** How far into a response body to look for items. */
const MAX_DEPTH = 3;

/**
 * Gives every InventoryItem in an inventory response its photo URLs.
 *
 * Items leave InventoryController in several shapes — bare (get, create,
 * update, toggle), as a page (`{data: [...]}`) and wrapped beside the movement
 * that changed them (`{item, movement, …}` from opening stock, adjust and
 * reverse). The app replaces its list row with whatever each of those returns,
 * so a single route that forgot the URLs would make the thumbnail vanish the
 * moment someone adjusted stock. Doing it here, once, on the way out, means no
 * route can forget.
 *
 * Signing is pure CPU — no query — because the item already carries imageId.
 */
@Injectable()
export class ItemImageUrlsInterceptor implements NestInterceptor {
  constructor(private readonly signer: MediaUrlSigner) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const now = Date.now();
    return next.handle().pipe(map((body) => this.decorate(body, now, 0)));
  }

  private decorate(value: unknown, now: number, depth: number): unknown {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object')
      return value;
    if (value instanceof InventoryItem) {
      return Object.assign(value, this.signer.urlsFor(value.imageId, now));
    }
    if (Array.isArray(value)) {
      for (const entry of value) this.decorate(entry, now, depth + 1);
      return value;
    }
    const record = value as Record<string, unknown>;
    if ('data' in record) this.decorate(record.data, now, depth + 1);
    if ('item' in record) this.decorate(record.item, now, depth + 1);
    return value;
  }
}
