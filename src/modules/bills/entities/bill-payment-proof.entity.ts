import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 * Evidence backing a bill payment — a bank confirmation, a transfer
 * screenshot, or a photo of a signed cash voucher.
 *
 * A separate row rather than a column on bill_payments, because the file has
 * to be uploaded BEFORE the payment exists:
 *
 *   • StorageService.putBuffer() bakes a `publicPath` into the URL it returns,
 *     pointing back at the route that will stream the file. A payment has no
 *     id until pay() runs, so there is nothing to build that path from. This
 *     row's own id supplies it.
 *   • stored_files carries no company_id, so a bare storage key handed to the
 *     pay endpoint could not be checked for tenancy. This row is
 *     company-scoped, which is what makes "does this proof belong to you?"
 *     answerable.
 *
 * `consumedByPaymentId` is stamped when a payment claims the proof, so one
 * upload cannot be replayed to back two payments.
 */
@Entity('bill_payment_proofs')
@Index(['companyId', 'createdAt'])
export class BillPaymentProof extends BaseCompanyEntity {
  /**
   * The StorageService key — `cld:<publicId>` or `db:<uuid>` depending on
   * which backend took the bytes. This, not a stored_files id, is the durable
   * reference: a Cloudinary upload never writes a stored_files row at all.
   */
  @Column({ type: 'varchar', length: 255, name: 'storage_key' })
  storageKey!: string;

  @Column({ type: 'varchar', length: 512 })
  url!: string;

  @Column({ type: 'varchar', length: 128, name: 'mime_type' })
  mimeType!: string;

  @Column({ type: 'varchar', length: 255, name: 'original_name' })
  originalName!: string;

  @Column({ type: 'integer' })
  size!: number;

  @Column({ type: 'uuid', name: 'uploaded_by' })
  uploadedBy!: string;

  /** Null until a payment claims it; set once, never cleared. */
  @Column({ type: 'uuid', nullable: true, name: 'consumed_by_payment_id' })
  consumedByPaymentId!: string | null;
}
