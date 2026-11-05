import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  EventRules,
  MessageLanguage,
  QuietHours,
  ReminderSchedule,
} from '../messaging.constants';

/** One row per company that has opened Connect settings. No row = off. */
@Entity('company_messaging_settings')
export class CompanyMessagingSettings {
  @PrimaryColumn({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  /** First time Connect was switched on; the "before Connect" DSO baseline. */
  @Column({ type: 'timestamptz', name: 'enabled_at', nullable: true })
  enabledAt!: Date | null;

  @Column({
    type: 'varchar',
    length: 8,
    name: 'sender_mode',
    default: 'shared',
  })
  senderMode!: 'shared' | 'own';

  @Column({
    type: 'varchar',
    length: 64,
    name: 'phone_number_id',
    nullable: true,
  })
  phoneNumberId!: string | null;

  @Column({ type: 'varchar', length: 64, name: 'waba_id', nullable: true })
  wabaId!: string | null;

  /** AES-256-GCM (token-crypto.util). Write-only over the API. */
  @Column({ type: 'text', name: 'access_token_enc', nullable: true })
  accessTokenEnc!: string | null;

  @Column({
    type: 'varchar',
    length: 2,
    name: 'default_language',
    default: 'en',
  })
  defaultLanguage!: MessageLanguage;

  @Column({ type: 'jsonb', name: 'event_rules' })
  eventRules!: Partial<EventRules>;

  @Column({ type: 'jsonb', name: 'quiet_hours' })
  quietHours!: QuietHours | null;

  @Column({ type: 'jsonb', name: 'reminder_schedule' })
  reminderSchedule!: ReminderSchedule;

  @Column({ type: 'integer', name: 'monthly_cap', nullable: true })
  monthlyCap!: number | null;

  @Column({
    type: 'timestamptz',
    name: 'contacts_opt_in_confirmed_at',
    nullable: true,
  })
  contactsOptInConfirmedAt!: Date | null;

  @Column({
    type: 'uuid',
    name: 'contacts_opt_in_confirmed_by',
    nullable: true,
  })
  contactsOptInConfirmedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
