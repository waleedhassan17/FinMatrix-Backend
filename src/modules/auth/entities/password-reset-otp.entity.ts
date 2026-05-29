import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';

/**
 * Forgot-password OTP flow (Stage 1).
 *
 *  1. request  -> a 6-digit OTP is generated, its hash stored in `otpHash`.
 *  2. verify   -> the OTP is checked; on success `verifiedAt` is set and a
 *                 single-use `resetTokenHash` is issued for the final step.
 *  3. reset    -> the reset token is exchanged for a password change; `usedAt`
 *                 is set so the whole record can never be replayed.
 *
 * Only hashes are stored at rest. `attempts` bounds brute-forcing of the OTP.
 */
@Entity('password_reset_otps')
export class PasswordResetOtp extends BaseEntity {
  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 255, name: 'otp_hash' })
  otpHash!: string;

  @Column({ type: 'varchar', length: 255, name: 'reset_token_hash', nullable: true })
  resetTokenHash!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'verified_at', nullable: true })
  verifiedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt!: Date | null;
}
