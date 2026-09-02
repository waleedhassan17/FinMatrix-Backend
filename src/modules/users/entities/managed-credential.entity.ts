import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * The custodian's copy of an owner-created account's password.
 *
 * Staff and riders never choose their own credentials: whoever created the
 * account holds them and reads them back out when the holder forgets. This row
 * is that copy — a convenience for the custodian, NEVER an authentication
 * path. `users.password_hash` remains the only thing sign-in consults, so a
 * corrupted or missing row here cannot let anyone in, and cannot lock anyone
 * out either.
 *
 * `secret` is ciphertext (see CredentialVaultService): AES-256-GCM under a key
 * that lives outside the database. Treat the decrypted value like a password
 * everywhere it is handled — never log it, never put it in an audit payload,
 * never include it in a list response.
 */
@Entity('managed_credentials')
@Index(['companyId'])
export class ManagedCredential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tenant that may read this credential back. */
  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** `v1:<iv>:<authTag>:<ciphertext>`, all base64. Never plain text. */
  @Column({ type: 'text' })
  secret!: string;

  /** Who issued or last re-issued this password. */
  @Column({ type: 'uuid', name: 'issued_by' })
  issuedBy!: string;

  @Column({ type: 'timestamptz', name: 'issued_at', default: () => 'now()' })
  issuedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
