import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { stringify } from 'csv-stringify/sync';
import { DataSource, EntityManager, In } from 'typeorm';
import { PlatformAuditService } from '../../common/audit/platform-audit.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { likeContains } from '../../common/utils/like.util';
import {
  normalizePhone,
  trialEmailKey,
} from '../../common/validation/contact-normalize';
import {
  demoBookingEnabled,
  demoSlotCapacity,
  demoSlotMinutes,
  supportEmail,
  turnstileSecret,
  webAppUrl,
} from '../../config/launch.settings';
import { hashIp } from '../billing/trial/trial.service';
import { MailService } from '../mail/mail.service';
import {
  assertTransition,
  canAutoConvert,
  OPEN_DEMO_STATUSES,
  SLOT_HOLDING_STATUSES,
} from './demo-state';
import {
  allSlots,
  checkFormToken,
  isBookableSlot,
  issueFormToken,
  pktDate,
  pktTime,
} from './demo-slots';
import { demoTemplates, type DemoMailPerson } from './demo-templates';
import { buildDemoIcs } from './ics';
import { DemoRequest, type DemoStatus } from './entities/demo-request.entity';
import { DemoRequestNote } from './entities/demo-request-note.entity';

/** Max open demo bookings one phone or email may hold. */
const MAX_OPEN_PER_PERSON = 2;

export interface BookDemoInput {
  fullName: string;
  businessName: string;
  phone: string;
  email: string;
  city: string;
  businessType: string;
  teamSize?: string | null;
  currentSystem?: string | null;
  language: 'en' | 'ur';
  slot: string;
  message?: string | null;
  consent: boolean;
  website?: string | null; // honeypot
  formToken?: string | null;
  turnstileToken?: string | null;
  utm?: Record<string, string> | null;
  referrer?: string | null;
  landingPath?: string | null;
}

/** The ONE answer a booking gets, whatever happened to it. */
const RECEIVED = { received: true } as const;

/**
 * Book a Demo: the public booking flow and the super-admin lead pipeline.
 *
 * The public endpoint never reveals whether an email or phone is known: a
 * honeypot hit, a too-fast submission and a person over the open-booking cap
 * all get the same `{ received: true }` as a real booking — only a slot that
 * has just been taken is answered differently, so the person can pick another.
 */
@Injectable()
export class DemoRequestsService {
  private readonly logger = new Logger(DemoRequestsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly audit: PlatformAuditService,
  ) {}

  private repo() {
    return this.dataSource.getRepository(DemoRequest);
  }

  private assertEnabled() {
    if (!demoBookingEnabled()) {
      throw new ServiceUnavailableException({
        code: 'DEMO_BOOKING_DISABLED',
        message: 'Demo booking is not available right now.',
      });
    }
  }

  // ── Public ──────────────────────────────────────────────────────────────

  /** Open slots between from and to (default: the whole booking window). */
  async slots(from?: string, to?: string) {
    this.assertEnabled();
    const now = new Date();
    const fromT = from ? new Date(from).getTime() : 0;
    const toT = to ? new Date(to).getTime() : Number.MAX_SAFE_INTEGER;
    const candidates = allSlots(now).filter(
      (s) => s.getTime() >= fromT && s.getTime() <= toT,
    );
    const taken = await this.takenCounts(this.dataSource.manager, candidates);
    const capacity = demoSlotCapacity();
    return {
      timezone: 'Asia/Karachi',
      minutes: demoSlotMinutes(),
      formToken: issueFormToken(),
      slots: candidates
        .filter((s) => (taken.get(s.getTime()) ?? 0) < capacity)
        .map((s) => ({
          at: s.toISOString(),
          date: pktDate(s),
          time: pktTime(s),
        })),
    };
  }

  private async takenCounts(
    q: Pick<EntityManager, 'query'>,
    slots: Date[],
  ): Promise<Map<number, number>> {
    if (!slots.length) return new Map();
    const rows: Array<{ at: Date; n: number }> = await q.query(
      `SELECT coalesce(scheduled_at, preferred_slot_at) AS at, count(*)::int AS n
         FROM demo_requests
        WHERE status = ANY($1)
          AND coalesce(scheduled_at, preferred_slot_at) = ANY($2::timestamptz[])
        GROUP BY 1`,
      [SLOT_HOLDING_STATUSES, slots.map((s) => s.toISOString())],
    );
    return new Map(rows.map((r) => [new Date(r.at).getTime(), Number(r.n)]));
  }

  async book(input: BookDemoInput, ip: string | null) {
    this.assertEnabled();
    // 1. Bots: honeypot filled, or the form came back too fast — accept and drop.
    if ((input.website ?? '').trim() !== '') {
      this.logger.warn('Demo booking dropped: honeypot');
      return RECEIVED;
    }
    const token = checkFormToken(input.formToken ?? undefined);
    if (token === 'too_fast') {
      this.logger.warn('Demo booking dropped: filled in under 3 s');
      return RECEIVED;
    }
    if (token === 'invalid') {
      throw new BadRequestException({
        code: 'DEMO_FORM_EXPIRED',
        message: 'This form has expired. Reload the page and try again.',
      });
    }
    // 2. Turnstile, when configured.
    if (turnstileSecret()) {
      const ok = await this.verifyTurnstile(input.turnstileToken, ip);
      if (!ok) {
        throw new BadRequestException({
          code: 'DEMO_VERIFICATION_FAILED',
          message: 'Please complete the verification and try again.',
        });
      }
    }
    if (input.consent !== true) {
      throw new BadRequestException({
        code: 'DEMO_CONSENT_REQUIRED',
        message: 'Please agree to be contacted about your demo.',
      });
    }
    const phone = normalizePhone(input.phone);
    if (!phone || !/^\+923\d{9}$/.test(phone)) {
      throw new BadRequestException({
        code: 'DEMO_INVALID_PHONE',
        message: 'Enter a valid Pakistani mobile number, e.g. 0300 1234567.',
      });
    }
    const emailKey = trialEmailKey(input.email);
    if (!emailKey) {
      throw new BadRequestException({
        code: 'DEMO_INVALID_EMAIL',
        message: 'Enter a valid email address.',
      });
    }
    const slot = new Date(input.slot);
    if (!Number.isFinite(slot.getTime()) || !isBookableSlot(slot)) {
      throw new BadRequestException({
        code: 'DEMO_INVALID_SLOT',
        message: 'Choose one of the times offered.',
      });
    }

    // 3. One person may hold only a couple of open bookings — silently.
    const open = await this.repo().count({
      where: [
        { phoneE164: phone, status: In([...OPEN_DEMO_STATUSES]) },
        { emailKey, status: In([...OPEN_DEMO_STATUSES]) },
      ],
    });
    if (open >= MAX_OPEN_PER_PERSON) {
      this.logger.warn('Demo booking dropped: open-booking cap reached');
      return RECEIVED;
    }

    // 4. The slot, under a lock so two people cannot both take the last place.
    const saved = await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `demo-slot:${slot.toISOString()}`,
      ]);
      const taken =
        (await this.takenCounts(em, [slot])).get(slot.getTime()) ?? 0;
      if (taken >= demoSlotCapacity()) {
        throw new ConflictException({
          code: 'DEMO_SLOT_TAKEN',
          message: 'That time was just taken. Please choose another.',
        });
      }
      const repo = em.getRepository(DemoRequest);
      return repo.save(
        repo.create({
          fullName: input.fullName.trim(),
          businessName: input.businessName.trim(),
          phoneE164: phone,
          email: input.email.trim().toLowerCase(),
          emailKey,
          city: input.city.trim(),
          businessType: input.businessType,
          teamSize: input.teamSize ?? null,
          currentSystem: input.currentSystem ?? null,
          language: input.language === 'ur' ? 'ur' : 'en',
          preferredSlotAt: slot,
          message: (input.message ?? '').trim() || null,
          consentAt: new Date(),
          utm: cleanUtm(input.utm),
          referrer: (input.referrer ?? '').slice(0, 500) || null,
          landingPath: (input.landingPath ?? '').slice(0, 300) || null,
          ipHash: hashIp(ip),
          source: 'website',
          status: 'new',
        }),
      );
    });

    // 5. Emails, after commit. Never break the booking.
    await this.safeMail(
      saved.email,
      demoTemplates.confirmation(person(saved), slot),
    );
    const admin = this.adminInbox();
    if (admin) {
      await this.safeMail(
        admin,
        demoTemplates.adminNotice({
          fullName: saved.fullName,
          businessName: saved.businessName,
          phone: saved.phoneE164,
          email: saved.email,
          city: saved.city,
          businessType: saved.businessType,
          teamSize: saved.teamSize,
          currentSystem: saved.currentSystem,
          language: saved.language,
          preferredAt: slot,
          message: saved.message,
        }),
      );
    }
    this.logger.log(`Demo booked: ${saved.id} for ${slot.toISOString()}`);
    return RECEIVED;
  }

  private async verifyTurnstile(
    token: string | null | undefined,
    ip: string | null,
  ): Promise<boolean> {
    if (!token) return false;
    try {
      const body = new URLSearchParams({
        secret: turnstileSecret(),
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      });
      const r = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        { method: 'POST', body },
      );
      const json = (await r.json()) as { success?: boolean };
      return json.success === true;
    } catch (err) {
      this.logger.error(`Turnstile check failed: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Admin: read ─────────────────────────────────────────────────────────

  async list(filter: {
    status?: string;
    city?: string;
    businessType?: string;
    currentSystem?: string;
    from?: string;
    to?: string;
    q?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);
    const qb = this.repo()
      .createQueryBuilder('d')
      .orderBy('d.createdAt', 'DESC');
    if (filter.status && filter.status !== 'all') {
      qb.andWhere('d.status = :status', { status: filter.status });
    }
    if (filter.city)
      qb.andWhere('d.city ILIKE :city', { city: likeContains(filter.city) });
    if (filter.businessType)
      qb.andWhere('d.businessType = :bt', { bt: filter.businessType });
    if (filter.currentSystem)
      qb.andWhere('d.currentSystem = :cs', { cs: filter.currentSystem });
    if (filter.from) qb.andWhere('d.createdAt >= :from', { from: filter.from });
    if (filter.to) qb.andWhere('d.createdAt <= :to', { to: filter.to });
    if (filter.q?.trim()) {
      qb.andWhere(
        `(d.fullName ILIKE :q OR d.businessName ILIKE :q OR d.email ILIKE :q OR d.phoneE164 ILIKE :q)`,
        { q: likeContains(filter.q.trim()) },
      );
    }
    const [rows, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const counts: Array<{ status: string; n: number }> =
      await this.dataSource.query(
        `SELECT status, count(*)::int AS n FROM demo_requests GROUP BY status`,
      );
    return {
      items: rows.map((r) => this.view(r)),
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async detail(id: string) {
    const d = await this.getOrFail(id);
    const notes = await this.dataSource.getRepository(DemoRequestNote).find({
      where: { demoRequestId: id },
      order: { createdAt: 'DESC' },
    });
    const history = await this.audit.list({
      targetType: 'demo_request',
      targetId: id,
      limit: 100,
    });
    // Companies whose owner shares this prospect's email or phone.
    const suggestions: Array<{ id: string; name: string; status: string }> =
      await this.dataSource.query(
        `SELECT c.id, c.name, c.status FROM companies c
           JOIN users o ON o.id = c.created_by
          WHERE lower(o.email) = lower($1)
             OR regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') = $2
             OR regexp_replace(coalesce(o.phone, ''), '\\D', '', 'g') = $2
          ORDER BY c.created_at DESC LIMIT 10`,
        [d.email, d.phoneE164.replace(/\D/g, '')],
      );
    return {
      ...this.view(d),
      notes: notes.map((n) => ({
        id: n.id,
        body: n.body,
        authorId: n.authorId,
        createdAt: n.createdAt,
      })),
      history: history.map((h) => ({
        action: h.action,
        at: h.createdAt,
        actorUserId: h.actorUserId,
        details: h.details,
        reason: h.reason,
      })),
      suggestedCompanies: suggestions,
    };
  }

  async exportCsv(
    filter: Parameters<DemoRequestsService['list']>[0],
  ): Promise<string> {
    const { items } = await this.list({ ...filter, page: 1, limit: 200 });
    // Export everything matching, not one page: page through.
    const all = [...items];
    for (let page = 2; all.length === (page - 1) * 200; page++) {
      const more = await this.list({ ...filter, page, limit: 200 });
      all.push(...more.items);
      if (more.items.length < 200) break;
    }
    return stringify(
      all.map((d) => ({
        created_at: d.createdAt.toISOString(),
        status: d.status,
        full_name: d.fullName,
        business_name: d.businessName,
        phone: d.phone,
        email: d.email,
        city: d.city,
        business_type: d.businessType,
        team_size: d.teamSize ?? '',
        current_system: d.currentSystem ?? '',
        language: d.language,
        preferred_slot_pkt: `${pktDate(d.preferredSlotAt)} ${pktTime(d.preferredSlotAt)}`,
        scheduled_pkt: d.scheduledAt
          ? `${pktDate(d.scheduledAt)} ${pktTime(d.scheduledAt)}`
          : '',
        meeting_link: d.meetingLink ?? '',
        lost_reason: d.lostReason ?? '',
        converted_company_id: d.convertedCompanyId ?? '',
        utm_source: d.utm?.source ?? '',
        utm_campaign: d.utm?.campaign ?? '',
      })),
      { header: true },
    );
  }

  // ── Admin: write ────────────────────────────────────────────────────────

  /**
   * A plain status change (contacted, completed, no_show, lost, converted).
   * Scheduling and rescheduling have their own calls — they carry a time.
   */
  async setStatus(
    id: string,
    admin: AuthenticatedUser,
    input: { status: DemoStatus; reason?: string | null },
  ) {
    if (input.status === 'scheduled' || input.status === 'rescheduled') {
      throw new BadRequestException({
        code: 'DEMO_USE_SCHEDULE',
        message: 'Use schedule or reschedule — they need a date and time.',
      });
    }
    const reason = (input.reason ?? '').trim();
    if (input.status === 'lost' && reason.length < 3) {
      throw new BadRequestException({
        code: 'DEMO_LOST_REASON_REQUIRED',
        message: 'Give a reason when marking a demo as lost.',
      });
    }
    const { before, after } = await this.mutate(id, (d) => {
      assertTransition(d.status, input.status);
      d.status = input.status;
      if (input.status === 'lost') d.lostReason = reason;
    });
    // A lost demo that had a time booked: tell the prospect and cancel the invite.
    if (
      input.status === 'lost' &&
      (before.status === 'scheduled' || before.status === 'rescheduled') &&
      before.scheduledAt
    ) {
      await this.sendCalendarMail(after, 'cancel');
    }
    await this.record(admin, after, `demo_${input.status}`, reason || null, {
      from: before.status,
      to: after.status,
    });
    return this.view(after);
  }

  /** Book (or move) the demo at a date and time, with a meeting link. */
  async schedule(
    id: string,
    admin: AuthenticatedUser,
    input: { scheduledAt: string; meetingLink?: string | null },
    mode: 'schedule' | 'reschedule',
  ) {
    const at = new Date(input.scheduledAt);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'DEMO_INVALID_TIME',
        message: 'Choose a time in the future.',
      });
    }
    const link = (input.meetingLink ?? '').trim() || null;
    if (link && !/^https?:\/\/\S+$/i.test(link)) {
      throw new BadRequestException({
        code: 'DEMO_INVALID_LINK',
        message: 'The meeting link must start with http:// or https://',
      });
    }
    const { before, after } = await this.mutate(id, (d) => {
      if (mode === 'schedule') {
        assertTransition(d.status, 'scheduled');
      } else {
        // scheduled/no_show → rescheduled → scheduled, recorded as one move.
        assertTransition(d.status, 'rescheduled');
        assertTransition('rescheduled', 'scheduled');
        d.icsSequence += 1;
      }
      d.status = 'scheduled';
      d.scheduledAt = at;
      d.meetingLink = link ?? d.meetingLink;
      d.reminderSentAt = null;
    });
    await this.sendCalendarMail(after, mode === 'schedule' ? 'new' : 'moved');
    await this.record(
      admin,
      after,
      mode === 'schedule' ? 'demo_scheduled' : 'demo_rescheduled',
      null,
      {
        from: before.status,
        at: at.toISOString(),
        previousAt: before.scheduledAt?.toISOString() ?? null,
        meetingLink: after.meetingLink,
      },
    );
    return this.view(after);
  }

  async addNote(id: string, admin: AuthenticatedUser, body: string) {
    const text = (body ?? '').trim();
    if (!text) {
      throw new BadRequestException({
        code: 'DEMO_NOTE_EMPTY',
        message: 'Write a note first.',
      });
    }
    const d = await this.getOrFail(id);
    const repo = this.dataSource.getRepository(DemoRequestNote);
    const note = await repo.save(
      repo.create({
        demoRequestId: d.id,
        authorId: admin.id,
        body: text.slice(0, 4000),
      }),
    );
    await this.record(admin, d, 'demo_note_added', null, { noteId: note.id });
    return { id: note.id, body: note.body, createdAt: note.createdAt };
  }

  async assign(id: string, admin: AuthenticatedUser, userId: string | null) {
    if (userId) {
      const [u] = await this.dataSource.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'super_admin'`,
        [userId],
      );
      if (!u) {
        throw new BadRequestException({
          code: 'DEMO_INVALID_ASSIGNEE',
          message: 'Demos can be assigned to FinMatrix team members only.',
        });
      }
    }
    const { after } = await this.mutate(id, (d) => {
      d.assignedTo = userId;
    });
    await this.record(admin, after, 'demo_assigned', null, {
      assignedTo: userId,
    });
    return this.view(after);
  }

  /** Link a demo to the company the prospect set up (manual). */
  async linkCompany(id: string, admin: AuthenticatedUser, companyId: string) {
    const [co] = await this.dataSource.query(
      `SELECT id, name FROM companies WHERE id = $1`,
      [companyId],
    );
    if (!co) throw new NotFoundException('Company not found');
    const { after } = await this.mutate(id, (d) => {
      d.convertedCompanyId = companyId;
      if (canAutoConvert(d.status) && d.status !== 'converted') {
        d.status = 'converted';
        d.convertedAt = new Date();
      }
    });
    await this.record(admin, after, 'demo_linked_company', null, {
      companyId,
      companyName: co.name,
    });
    return this.view(after);
  }

  /**
   * Email the prospect a sign-up link pre-filled with their details. If their
   * email or phone has already had a trial, the email offers account approval
   * instead — the invite never bypasses the one-trial rule.
   */
  async sendTrialInvite(id: string, admin: AuthenticatedUser) {
    const d = await this.getOrFail(id);
    if (d.status === 'lost' || d.status === 'converted') {
      throw new ConflictException({
        code: 'DEMO_INVALID_TRANSITION',
        message: `This demo is ${d.status}; no invite is sent.`,
      });
    }
    const [claim] = await this.dataSource.query(
      `SELECT 1 AS x FROM trial_claims
        WHERE status IN ('pending','approved','blocked','granted')
          AND (email_normalized = $1 OR phone_normalized = $2) LIMIT 1`,
      [d.emailKey, d.phoneE164],
    );
    const eligible = !claim;
    const url = this.signupUrl(d);
    await this.safeMail(
      d.email,
      demoTemplates.trialInvite(person(d), url, eligible),
    );
    const { after } = await this.mutate(id, (row) => {
      row.inviteSentAt = new Date();
    });
    await this.record(admin, after, 'demo_trial_invite_sent', null, {
      trialEligible: eligible,
    });
    return { ...this.view(after), signupUrl: url, trialEligible: eligible };
  }

  signupUrl(d: DemoRequest): string {
    const params = new URLSearchParams({
      ref: `demo_${d.id}`,
      name: d.fullName,
      email: d.email,
      business: d.businessName,
      phone: d.phoneE164,
    });
    return `${webAppUrl()}/register?${params.toString()}`;
  }

  // ── Conversion (called by CompaniesService.create) ──────────────────────

  /**
   * An owner who signed up from a demo's invite has just created a company:
   * link it and mark the demo converted. Silently ignores anything that does
   * not match (a stale, unknown or already-closed reference).
   */
  async convertFromSignup(
    em: EntityManager,
    signupRef: string | null | undefined,
    companyId: string,
  ): Promise<void> {
    const m = /^demo_([0-9a-f-]{36})$/i.exec(signupRef ?? '');
    if (!m) return;
    const repo = em.getRepository(DemoRequest);
    const d = await repo.findOne({ where: { id: m[1] } });
    if (!d || !canAutoConvert(d.status) || d.convertedCompanyId) return;
    const from = d.status;
    d.status = 'converted';
    d.convertedAt = new Date();
    d.convertedCompanyId = companyId;
    await repo.save(d);
    await this.audit.recordIn(em, {
      actorLabel: 'system:signup',
      action: 'demo_converted',
      targetType: 'demo_request',
      targetId: d.id,
      companyId,
      details: { from, via: 'trial_invite' },
    });
  }

  // ── Reminder worker ─────────────────────────────────────────────────────

  /** Send the 2-hours-before reminder for demos about to start. Idempotent. */
  async sendDueReminders(now: Date = new Date()): Promise<number> {
    const due = await this.repo()
      .createQueryBuilder('d')
      .where(`d.status = 'scheduled'`)
      .andWhere('d.reminderSentAt IS NULL')
      .andWhere('d.scheduledAt > :now', { now })
      .andWhere('d.scheduledAt <= :soon', {
        soon: new Date(now.getTime() + 2 * 60 * 60_000),
      })
      .getMany();
    let sent = 0;
    for (const d of due) {
      // Claim first so two processes never both send it.
      const claimed = await this.repo()
        .createQueryBuilder()
        .update()
        .set({ reminderSentAt: () => 'now()' })
        .where('id = :id AND reminder_sent_at IS NULL', { id: d.id })
        .execute();
      if (!claimed.affected) continue;
      await this.safeMail(
        d.email,
        demoTemplates.reminder(person(d), d.scheduledAt as Date, d.meetingLink),
      );
      sent += 1;
    }
    return sent;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async getOrFail(id: string): Promise<DemoRequest> {
    const d = await this.repo().findOne({ where: { id } });
    if (!d) {
      throw new NotFoundException({
        code: 'DEMO_NOT_FOUND',
        message: 'Demo request not found',
      });
    }
    return d;
  }

  /** Lock, change, save; returns the row before and after. */
  private async mutate(id: string, change: (d: DemoRequest) => void) {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(DemoRequest);
      const d = await repo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!d) {
        throw new NotFoundException({
          code: 'DEMO_NOT_FOUND',
          message: 'Demo request not found',
        });
      }
      const before = { ...d } as DemoRequest;
      change(d);
      const after = await repo.save(d);
      return { before, after };
    });
  }

  private async sendCalendarMail(
    d: DemoRequest,
    kind: 'new' | 'moved' | 'cancel',
  ) {
    const at = d.scheduledAt as Date;
    const organizer = supportEmail() || 'no-reply@finmatrix.pk';
    const ics = buildDemoIcs({
      uid: `demo-${d.id}@finmatrix`,
      sequence: kind === 'cancel' ? d.icsSequence + 1 : d.icsSequence,
      start: at,
      minutes: demoSlotMinutes(),
      summary: `FinMatrix demo — ${d.businessName}`,
      description:
        `FinMatrix product demo for ${d.businessName}.` +
        (d.meetingLink ? `\nJoin: ${d.meetingLink}` : ''),
      location: d.meetingLink,
      organizerEmail: organizer,
      attendeeEmail: d.email,
      attendeeName: d.fullName,
      method: kind === 'cancel' ? 'CANCEL' : 'REQUEST',
    });
    const email =
      kind === 'cancel'
        ? demoTemplates.cancelled(person(d), at)
        : demoTemplates.scheduled(
            person(d),
            at,
            d.meetingLink,
            kind === 'moved',
          );
    email.attachments = [
      {
        filename: 'finmatrix-demo.ics',
        content: ics,
        contentType: `text/calendar; charset=utf-8; method=${kind === 'cancel' ? 'CANCEL' : 'REQUEST'}`,
      },
    ];
    await this.safeMail(d.email, email);
  }

  private adminInbox(): string {
    return (
      (process.env.ADMIN_EMAIL ?? '').trim() ||
      (process.env.SUPER_ADMIN_EMAIL ?? '').trim()
    );
  }

  private async safeMail(
    to: string,
    email: Parameters<MailService['sendRendered']>[1],
  ) {
    try {
      await this.mail.sendRendered(to, email);
    } catch (err) {
      this.logger.error(`Demo email failed: ${(err as Error).message}`);
    }
  }

  private async record(
    admin: AuthenticatedUser,
    d: DemoRequest,
    action: string,
    reason: string | null,
    details: Record<string, unknown>,
  ) {
    await this.audit.record({
      actorUserId: admin.id,
      actorLabel: admin.email,
      action,
      targetType: 'demo_request',
      targetId: d.id,
      companyId: d.convertedCompanyId,
      reason,
      details: { businessName: d.businessName, ...details },
    });
  }

  view(d: DemoRequest) {
    return {
      id: d.id,
      createdAt: d.createdAt,
      status: d.status,
      fullName: d.fullName,
      businessName: d.businessName,
      phone: d.phoneE164,
      email: d.email,
      city: d.city,
      businessType: d.businessType,
      teamSize: d.teamSize,
      currentSystem: d.currentSystem,
      language: d.language,
      preferredSlotAt: d.preferredSlotAt,
      message: d.message,
      utm: d.utm,
      referrer: d.referrer,
      landingPath: d.landingPath,
      source: d.source,
      scheduledAt: d.scheduledAt,
      meetingLink: d.meetingLink,
      assignedTo: d.assignedTo,
      lostReason: d.lostReason,
      convertedCompanyId: d.convertedCompanyId,
      convertedAt: d.convertedAt,
      inviteSentAt: d.inviteSentAt,
      reminderSentAt: d.reminderSentAt,
    };
  }
}

function person(d: DemoRequest): DemoMailPerson {
  return {
    fullName: d.fullName,
    businessName: d.businessName,
    language: d.language,
  };
}

function cleanUtm(
  utm: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!utm || typeof utm !== 'object') return null;
  const out: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = (utm as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 100);
  }
  return Object.keys(out).length ? out : null;
}
