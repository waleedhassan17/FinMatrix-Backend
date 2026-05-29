import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';

/**
 * Single-use, time-limited email verification token.
 * Only the SHA-256 hash of the token is stored at rest.
 */
@Entity('email_verifications')
export class EmailVerification extends BaseEntity {
  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255, name: 'token_hash' })
  tokenHash!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt!: Date | null;
}
