import { EntityManager } from 'typeorm';

export interface AttachmentRef {
  /** Path inside the ZIP, under attachments/. */
  zipPath: string;
  storageKey: string;
}

/**
 * Every stored file that belongs to a company, found through the rows that
 * own it. `stored_files` itself carries no company_id (it is a blob store
 * behind StorageService), so this is the only tenant-safe way to enumerate:
 * each query below is filtered by the owning table's company_id.
 *
 *   bill_payment_proofs            receipts attached when paying bills
 *   bill_payments.proof_storage_key older payments that kept the key inline
 *   inventory_item_images          item photos (display rendition only)
 *   deliveries.bill_photo_*        the bill photographed at a delivery
 *   inventory_update_requests      the bill photographed with a stock request
 *   companies.logo                 when it is a stored file, not a URL
 *
 * Original names are kept, prefixed by the owning record so two "receipt.jpg"
 * never collide, and sanitised so a name cannot escape the attachments folder.
 */
export async function listCompanyAttachments(
  manager: EntityManager,
  companyId: string,
  company: { logo: string | null },
): Promise<AttachmentRef[]> {
  if (!companyId)
    throw new Error('listCompanyAttachments requires a companyId');
  const refs: AttachmentRef[] = [];

  const proofs: Array<{
    id: string;
    storage_key: string;
    original_name: string | null;
    mime_type: string | null;
  }> = await manager.query(
    `SELECT id, storage_key, original_name, mime_type
       FROM bill_payment_proofs WHERE company_id = $1 ORDER BY created_at, id`,
    [companyId],
  );
  for (const p of proofs) {
    refs.push({
      zipPath: `attachments/payment-proofs/${p.id}-${safeName(p.original_name, extFor(p.mime_type, p.storage_key))}`,
      storageKey: p.storage_key,
    });
  }

  const inlineProofs: Array<{ id: string; proof_storage_key: string }> =
    await manager.query(
      `SELECT id, proof_storage_key FROM bill_payments
        WHERE company_id = $1 AND proof_storage_key IS NOT NULL ORDER BY created_at, id`,
      [companyId],
    );
  for (const p of inlineProofs) {
    refs.push({
      zipPath: `attachments/payment-proofs/bill-payment-${p.id}${extFor(null, p.proof_storage_key)}`,
      storageKey: p.proof_storage_key,
    });
  }

  const images: Array<{
    id: string;
    item_id: string;
    storage_key: string;
    original_name: string | null;
    mime_type: string | null;
    sku: string | null;
  }> = await manager.query(
    `SELECT i.id, i.item_id, i.storage_key, i.original_name, i.mime_type, it.sku
       FROM inventory_item_images i
       LEFT JOIN inventory_items it ON it.id = i.item_id AND it.company_id = $1
      WHERE i.company_id = $1 ORDER BY i.created_at, i.id`,
    [companyId],
  );
  for (const im of images) {
    refs.push({
      zipPath: `attachments/item-photos/${safeName(im.sku ?? im.item_id, '')}-${safeName(im.original_name, extFor(im.mime_type, im.storage_key))}`,
      storageKey: im.storage_key,
    });
  }

  const deliveries: Array<{
    id: string;
    reference_no: string | null;
    bill_photo_storage_key: string;
  }> = await manager.query(
    `SELECT id, reference_no, bill_photo_storage_key FROM deliveries
      WHERE company_id = $1 AND bill_photo_storage_key IS NOT NULL ORDER BY created_at, id`,
    [companyId],
  );
  for (const d of deliveries) {
    refs.push({
      zipPath: `attachments/delivery-bill-photos/${safeName(d.reference_no ?? d.id, '')}-${d.id.slice(0, 8)}${extFor(null, d.bill_photo_storage_key)}`,
      storageKey: d.bill_photo_storage_key,
    });
  }

  const requests: Array<{ id: string; proof_bill_photo_storage_key: string }> =
    await manager.query(
      `SELECT id, proof_bill_photo_storage_key FROM inventory_update_requests
        WHERE company_id = $1 AND proof_bill_photo_storage_key IS NOT NULL ORDER BY created_at, id`,
      [companyId],
    );
  for (const r of requests) {
    refs.push({
      zipPath: `attachments/stock-request-photos/${r.id}${extFor(null, r.proof_bill_photo_storage_key)}`,
      storageKey: r.proof_bill_photo_storage_key,
    });
  }

  if (company.logo && isStorageKey(company.logo)) {
    refs.push({
      zipPath: `attachments/logo${extFor(null, company.logo)}`,
      storageKey: company.logo,
    });
  }

  return dedupe(refs);
}

/** A StorageService key, as opposed to an external URL or a data URI. */
export function isStorageKey(value: string): boolean {
  if (/^(https?:|data:)/i.test(value)) return false;
  return (
    value.startsWith('cld:') ||
    value.startsWith('db:') ||
    /^[\w./-]+$/.test(value)
  );
}

/** The extension for a file, from its MIME type or, failing that, its key. */
export function extFor(mime: string | null, key: string): string {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'application/pdf':
      return '.pdf';
  }
  const m = /\.([a-z0-9]{1,5})$/i.exec(key);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * A file name that is safe inside the archive: no path separators, no
 * control characters, no leading dots, at most 100 characters, with the
 * extension preserved (added when the name has none).
 */
export function safeName(name: string | null | undefined, ext: string): string {
  const raw = (name ?? '').trim();
  // eslint-disable-next-line no-control-regex
  let cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '');
  if (!cleaned) cleaned = 'file';
  if (cleaned.length > 100) {
    const dot = cleaned.lastIndexOf('.');
    const keepExt =
      dot > 0 && cleaned.length - dot <= 6 ? cleaned.slice(dot) : '';
    cleaned = cleaned.slice(0, 100 - keepExt.length) + keepExt;
  }
  if (ext && !cleaned.toLowerCase().endsWith(ext.toLowerCase())) cleaned += ext;
  return cleaned;
}

/** One entry per stored file, and no two entries on the same path. */
function dedupe(refs: AttachmentRef[]): AttachmentRef[] {
  const byKey = new Set<string>();
  const paths = new Map<string, number>();
  const out: AttachmentRef[] = [];
  for (const r of refs) {
    if (byKey.has(r.storageKey)) continue;
    byKey.add(r.storageKey);
    let zipPath = r.zipPath;
    const n = paths.get(zipPath) ?? 0;
    paths.set(zipPath, n + 1);
    if (n > 0) {
      const dot = zipPath.lastIndexOf('.');
      zipPath =
        dot > zipPath.lastIndexOf('/')
          ? `${zipPath.slice(0, dot)}-${n + 1}${zipPath.slice(dot)}`
          : `${zipPath}-${n + 1}`;
    }
    out.push({ zipPath, storageKey: r.storageKey });
  }
  return out;
}
