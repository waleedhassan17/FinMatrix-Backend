import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { StockTransferStatus } from '../../../types';
import { StockTransferLine } from './stock-transfer-line.entity';

@Entity('stock_transfers')
@Index(['companyId', 'transferDate'])
export class StockTransfer extends BaseCompanyEntity {
  @Column({ type: 'uuid', nullable: true, name: 'from_location_id' })
  fromLocationId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'to_location_id' })
  toLocationId!: string | null;

  @Column({ type: 'date', name: 'transfer_date' })
  transferDate!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reference!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: StockTransferStatus;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => StockTransferLine, (l) => l.transfer, { cascade: true })
  lines!: StockTransferLine[];
}
