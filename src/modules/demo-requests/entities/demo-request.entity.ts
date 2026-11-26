import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';

export const DEMO_STATUSES = [
  'new',
  'contacted',
  'scheduled',
  'rescheduled',
  'completed',
  'no_show',
  'converted',
  'lost',
] as const;
export type DemoStatus = (typeof DEMO_STATUSES)[number];

export const DEMO_BUSINESS_TYPES = [
  'wholesale_distribution',
  'retail',
  'manufacturing',
  'services',
  'other',
] as const;
export const DEMO_TEAM_SIZES = ['1-5', '6-20', '21-50', '50+'] as const;
export const DEMO_CURRENT_SYSTEMS = [
  'excel',
  'tally',
  'peachtree',
  'quickbooks',
  'xero',
  'zoho',
  'odoo',
  'other',
  'none',
] as const;

/**
 * A "Book a demo" request from the public website — a sales lead, NOT
 * company data: no company_id, and when the prospect later signs up the
 * company is linked through converted_company_id (cleared, never cascaded,
 * if that company is deleted).
 */
@Entity('demo_requests')
@Index('idx_demo_requests_status', ['status', 'createdAt'])
@Index('idx_demo_requests_email_key', ['emailKey'])
@Index('idx_demo_requests_phone', ['phoneE164'])
@Index('idx_demo_requests_slot', ['preferredSlotAt'])
@Index('idx_demo_requests_scheduled', ['scheduledAt'])
export class DemoRequest extends BaseEntity {
  @Column({ type: 'varchar', length: 80, name: 'full_name' })
  fullName!: string;

  @Column({ type: 'varchar', length: 120, name: 'business_name' })
  businessName!: string;

  @Column({ type: 'varchar', length: 20, name: 'phone_e164' })
  phoneE164!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  /** trialEmailKey(email): matches the same inbox however it is written. */
  @Column({ type: 'varchar', length: 255, name: 'email_key' })
  emailKey!: string;

  @Column({ type: 'varchar', length: 80 })
  city!: string;

  @Column({ type: 'varchar', length: 32, name: 'business_type' })
  businessType!: string;

  @Column({ type: 'varchar', length: 8, name: 'team_size', nullable: true })
  teamSize!: string | null;

  @Column({
    type: 'varchar',
    length: 24,
    name: 'current_system',
    nullable: true,
  })
  currentSystem!: string | null;

  @Column({ type: 'timestamptz', name: 'preferred_slot_at' })
  preferredSlotAt!: Date;

  @Column({ type: 'text', nullable: true })
  message!: string | null;

  @Column({ type: 'timestamptz', name: 'consent_at' })
  consentAt!: Date;

  // ── Attribution ──
  @Column({ type: 'jsonb', nullable: true })
  utm!: Record<string, string> | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  referrer!: string | null;

  @Column({
    type: 'varchar',
    length: 300,
    name: 'landing_path',
    nullable: true,
  })
  landingPath!: string | null;

  /** Keyed hash of the client IP (abuse throttling), never the IP itself. */
  @Column({ type: 'varchar', length: 64, name: 'ip_hash', nullable: true })
  ipHash!: string | null;

  /** website | admin | … */
  @Column({ type: 'varchar', length: 24, default: 'website' })
  source!: string;

  // ── Pipeline ──
  @Column({ type: 'varchar', length: 16, default: 'new' })
  status!: DemoStatus;

  @Column({ type: 'timestamptz', name: 'scheduled_at', nullable: true })
  scheduledAt!: Date | null;

  @Column({
    type: 'varchar',
    length: 500,
    name: 'meeting_link',
    nullable: true,
  })
  meetingLink!: string | null;

  /** A super-admin user id. */
  @Column({ type: 'uuid', name: 'assigned_to', nullable: true })
  assignedTo!: string | null;

  @Column({ type: 'text', name: 'lost_reason', nullable: true })
  lostReason!: string | null;

  @Column({ type: 'uuid', name: 'converted_company_id', nullable: true })
  convertedCompanyId!: string | null;

  @Column({ type: 'timestamptz', name: 'converted_at', nullable: true })
  convertedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'invite_sent_at', nullable: true })
  inviteSentAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'reminder_sent_at', nullable: true })
  reminderSentAt!: Date | null;

  /** RFC 5545 SEQUENCE of the calendar invite; bumped on every reschedule. */
  @Column({ type: 'integer', name: 'ics_sequence', default: 0 })
  icsSequence!: number;
}
