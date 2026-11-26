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

  // ── Platform suspension (super-admin) ─────────────────────────────────────
  // Set = suspended everywhere: sign-in, refresh, password reset, OTP and
  // verification all answer ACCOUNT_SUSPENDED, and isActive is false. An
  // owner deactivating their own staff sets isActive=false WITHOUT this.
  @Column({ type: 'timestamptz', nullable: true, name: 'suspended_at' })
  suspendedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'suspended_by' })
  suspendedBy!: string | null;

  @Column({ type: 'text', nullable: true, name: 'suspension_reason' })
  suspensionReason!: string | null;

  /**
   * Bumped to revoke every access token at once (suspension). Access tokens
   * carry it as `tv`; JwtStrategy refuses one whose `tv` no longer matches.
   * Tokens issued before this column existed carry no `tv`, which reads as 0.
   */
  @Column({ type: 'integer', default: 0, name: 'token_version' })
  tokenVersion!: number;

  /**
   * Where the sign-up came from, e.g. `demo_<uuid>` from a demo's "Start your
   * free trial" invite. Links the demo to the company this owner creates.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'signup_ref' })
  signupRef!: string | null;

  @OneToMany(() => UserCompany, (uc) => uc.user)
  memberships!: UserCompany[];
}
