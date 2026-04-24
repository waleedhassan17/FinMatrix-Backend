import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Company } from './company.entity';
import { UserRole } from '../../../types';

@Entity('user_companies')
@Index(['userId', 'companyId'], { unique: true })
export class UserCompany {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 16, default: 'admin' })
  role!: UserRole;

  @CreateDateColumn({ type: 'timestamptz', name: 'joined_at' })
  joinedAt!: Date;

  @ManyToOne(() => User, (u) => u.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Company, (c) => c.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;
}
