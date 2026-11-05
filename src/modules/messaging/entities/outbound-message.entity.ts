import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  MessageChannel,
  MessageLanguage,
  MessageStatus,
  RecipientType,
} from '../messaging.constants';

export interface MessageAttachment {
  /** DocumentRendererRegistry name: invoice, purchase_order, remittance, receipt, statement. */
  renderer: string;
  args: Record<string, unknown>;
}

@Entity('outbound_messages')
@Index('IDX_outbound_messages_status_next', ['status', 'nextAttemptAt'])
@Index('IDX_outbound_messages_doc', ['companyId', 'docType', 'docId'])
@Index('IDX_outbound_messages_provider_id', ['providerMessageId'])
@Index('IDX_outbound_messages_company_created', ['companyId', 'createdAt'])
export class OutboundMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 32, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'varchar', length: 32, name: 'doc_type' })
  docType!: string;

  @Column({ type: 'uuid', name: 'doc_id' })
  docId!: string;

  @Column({ type: 'integer', name: 'doc_version', default: 1 })
  docVersion!: number;

  @Column({ type: 'varchar', length: 16, name: 'recipient_type' })
  recipientType!: RecipientType;

  @Column({ type: 'uuid', name: 'recipient_id', nullable: true })
  recipientId!: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    name: 'to_phone_e164',
    nullable: true,
  })
  toPhoneE164!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'whatsapp_api' })
  channel!: MessageChannel;

  @Column({ type: 'varchar', length: 64, name: 'template_name' })
  templateName!: string;

  @Column({ type: 'varchar', length: 2, default: 'en' })
  language!: MessageLanguage;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  params!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  attachment!: MessageAttachment | null;

  @Column({ type: 'text', name: 'media_storage_key', nullable: true })
  mediaStorageKey!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: MessageStatus;

  @Column({
    type: 'varchar',
    length: 128,
    name: 'provider_message_id',
    nullable: true,
  })
  providerMessageId!: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({
    type: 'timestamptz',
    name: 'next_attempt_at',
    default: () => 'now()',
  })
  nextAttemptAt!: Date;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'idempotency_key',
    unique: true,
  })
  idempotencyKey!: string;

  @Column({ type: 'timestamptz', name: 'scheduled_for', nullable: true })
  scheduledFor!: Date | null;

  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
