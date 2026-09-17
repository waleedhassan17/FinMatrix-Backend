import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { DeliveryPriority, DeliveryStatus } from '../../../types';
import type { DeliveryPaidStatus } from '../delivery-collection.util';
import { DeliveryItem } from './delivery-item.entity';

@Entity('deliveries')
@Index(['companyId', 'status'])
@Index(['companyId', 'personnelId'])
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
export class Delivery extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'customer_name' })
  customerName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  zone!: string | null;

  // -------- Destination address + geocoded coordinates --------
  @Column({ type: 'varchar', length: 300, nullable: true })
  address!: string | null;

  @Column({ type: 'double precision', nullable: true, name: 'dest_lat' })
  destLat!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'dest_lng' })
  destLng!: number | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'geocoded_at' })
  geocodedAt!: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'reference_no' })
  referenceNo!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'personnel_id' })
  personnelId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'unassigned' })
  status!: DeliveryStatus;

  @Column({ type: 'varchar', length: 16, default: 'normal' })
  priority!: DeliveryPriority;

  @Column({ type: 'date', nullable: true, name: 'preferred_date' })
  preferredDate!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'preferred_time_slot' })
  preferredTimeSlot!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'assigned_at' })
  assignedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'text', nullable: true, name: 'cancel_reason' })
  cancelReason!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  // -------- Ledger link (phase1.md: Goods in Transit model) --------
  // How much of the sale is settled. Before approval it is the rider's answer
  // (normalised by resolveCollection) and decides what approval records; once
  // the ledger is committed it is derived from the invoice and is display only.
  @Column({ type: 'varchar', length: 8, nullable: true, name: 'paid_status' })
  paidStatus!: DeliveryPaidStatus | null;

  // True when the advance covers the whole order. Kept alongside
  // advanceAmount because legacy rows (and the credit-exposure query) read it.
  @Column({ type: 'boolean', default: false })
  prepaid!: boolean;

  // Paid before dispatch, fully or in part. Recorded at creation as a receipt
  // held in 2400 Customer Advances and applied to the invoice at approval.
  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'advance_amount' })
  advanceAmount!: string;

  // The receipt holding the advance. NULL on legacy prepaid rows, whose
  // advance was a bare journal — they keep the legacy release at approval.
  @Column({ type: 'uuid', nullable: true, name: 'advance_payment_id' })
  advancePaymentId!: string | null;

  // Cash taken at the door: the rider's figure until approval, then the
  // amount approval actually recorded.
  @Column({ type: 'decimal', precision: 18, scale: 4, nullable: true, name: 'amount_collected' })
  amountCollected!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'sales_order_id' })
  salesOrderId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'invoice_id' })
  invoiceId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'git_journal_entry_id' })
  gitJournalEntryId!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'stock_committed_at' })
  stockCommittedAt!: Date | null;

  // 'none' → 'in_transit' (Stage 1 posted) → 'committed' (Stage 3 posted)
  //                                        ↘ 'returned' (rejected/reversed)
  @Column({ type: 'varchar', length: 16, default: 'none', name: 'ledger_status' })
  ledgerStatus!: 'none' | 'in_transit' | 'committed' | 'returned';

  // -------- Bill-photo capture (replaces digital signature) --------
  @Column({ type: 'text', nullable: true, name: 'bill_photo_url' })
  billPhotoUrl!: string | null;

  @Column({ type: 'text', nullable: true, name: 'bill_photo_storage_key' })
  billPhotoStorageKey!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'bill_photo_captured_at' })
  billPhotoCapturedAt!: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'bill_signed_by' })
  billSignedBy!: string | null;

  @OneToMany(() => DeliveryItem, (i) => i.delivery, { cascade: true })
  items!: DeliveryItem[];
}
