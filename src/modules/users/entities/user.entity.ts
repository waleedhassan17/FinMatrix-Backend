import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';
import { UserRole } from '../../../types';
import { UserCompany } from '../../companies/entities/user-company.entity';

@Entity('users')
export class User extends BaseEntity {
  // Nullable since staff accounts: the owner creates those from User
  // management with a username, and a warehouse hand may have no work email.
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  /** Sign-in handle for owner-created accounts. Null for self-signup users. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', length: 255, name: 'password_hash' })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 120, name: 'display_name' })
  displayName!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'admin' })
  role!: UserRole;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_email_verified' })
  isEmailVerified!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'email_verified_at' })
  emailVerifiedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'default_company_id' })
  defaultCompanyId!: string | null;

  @OneToMany(() => UserCompany, (uc) => uc.user)
  memberships!: UserCompany[];
}
