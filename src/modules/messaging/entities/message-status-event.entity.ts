import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Append-only (a trigger refuses UPDATE): what the provider said, and when. */
@Entity('message_status_events')
@Index('IDX_message_status_events_message', ['messageId', 'occurredAt'])
export class MessageStatusEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'message_id' })
  messageId!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: string;

  @Column({ type: 'timestamptz', name: 'occurred_at', default: () => 'now()' })
  occurredAt!: Date;

  @Column({ type: 'jsonb', nullable: true })
  raw!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 32, name: 'error_code', nullable: true })
  errorCode!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
