import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('credit_memo_applications')
@Index(['creditMemoId'])
@Index(['invoiceId'])
export class CreditMemoApplication {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'credit_memo_id' })
  creditMemoId!: string;

  @Column({ type: 'uuid', name: 'invoice_id' })
  invoiceId!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  amount!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'applied_at' })
  appliedAt!: Date;
}
