import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PhysicalCountLine } from './physical-count-line.entity';

@Entity('physical_counts')
@Index(['companyId', 'countDate'])
export class PhysicalCount extends BaseCompanyEntity {
  @Column({ type: 'date', name: 'count_date' })
  countDate!: string;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => PhysicalCountLine, (l) => l.count, { cascade: true })
  lines!: PhysicalCountLine[];
}
