import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { InventoryRequestStatus, ShadowSyncStatus } from '../../../types';
import { InventoryUpdateRequestLine } from './inventory-update-request-line.entity';

export type ProofVerificationMethod = 'otp' | 'customer_id' | 'manual' | 'bill_photo';

@Entity('inventory_update_requests')
@Index(['companyId', 'status'])
@Index(['companyId', 'personnelId'])
@Index(['companyId', 'submittedAt'])
export class InventoryUpdateRequest extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'delivery_id' })
  deliveryId!: string;

  @Column({ type: 'uuid', name: 'personnel_id' })
  personnelId!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: InventoryRequestStatus;

  @Column({ type: 'timestamptz', name: 'submitted_at' })
  submittedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'reviewed_at' })
  reviewedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'reviewed_by' })
  reviewedBy!: string | null;

  @Column({ type: 'text', nullable: true, name: 'approval_notes' })
  approvalNotes!: string | null;

  @Column({ type: 'text', nullable: true, name: 'reject_reason' })
  rejectReason!: string | null;

  // ---- Denormalized snapshot fields (set at submission, immutable) ----
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'delivery_reference' })
  deliveryReference!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'personnel_name' })
  personnelName!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'route_label' })
  routeLabel!: string | null;

  // ---- Shadow-inventory sync state ----
  @Column({ type: 'varchar', length: 16, default: 'pending', name: 'shadow_status' })
  shadowStatus!: ShadowSyncStatus | 'pending' | 'rejected';

  // ---- Reviewer comment (modern alias for approvalNotes/rejectReason) ----
  @Column({ type: 'text', nullable: true, name: 'reviewer_comment' })
  reviewerComment!: string | null;

  // ---- Proof block (the customer-signed bill photo) ----
  @Column({ type: 'varchar', length: 200, nullable: true, name: 'proof_signed_by' })
  proofSignedBy!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'bill_photo', name: 'proof_verification_method' })
  proofVerificationMethod!: ProofVerificationMethod;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'proof_verified_by' })
  proofVerifiedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'proof_verified_at' })
  proofVerifiedAt!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'proof_bill_photo_url' })
  proofBillPhotoUrl!: string | null;

  @Column({ type: 'text', nullable: true, name: 'proof_bill_photo_storage_key' })
  proofBillPhotoStorageKey!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'proof_bill_photo_captured_at' })
  proofBillPhotoCapturedAt!: Date | null;

  @OneToMany(() => InventoryUpdateRequestLine, (l) => l.request, { cascade: true })
  lines!: InventoryUpdateRequestLine[];
}
