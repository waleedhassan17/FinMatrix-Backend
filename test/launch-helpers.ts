/**
 * Shared plumbing for the launch acceptance suites (trial, demo requests,
 * account admin). Plain HTTP against a RUNNING API plus a direct Postgres
 * client for the state pokes a test needs (verify an inbox, move a date).
 *
 *   API_BASE      default http://localhost:3101/api/v1
 *   DATABASE_URL  required (the API's own database — a scratch copy, never
 *                 a real one)
 *   MAILPIT_URL   optional, default http://localhost:8025: when reachable and
 *                 the API sends SMTP there, emails are asserted too.
 *
 * No credentials live here: each run creates its own throwaway super-admin
 * directly in the database and removes nothing it did not create.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { randomUUID } from 'crypto';
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

export const BASE = process.env.API_BASE || 'http://localhost:3101/api/v1';
export const PG_URL = process.env.DATABASE_URL || process.env.PG_URL || '';
export const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
export const PASSWORD = 'Qa@12345';
export const DAY = 24 * 60 * 60 * 1000;
export const RUN = Date.now().toString(36);

export interface Res {
  status: number;
  body: any;
}

let pass = 0;
let fail = 0;
const fails: string[] = [];
export function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(
      `  ✗ ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra)?.slice(0, 400) : ''}`,
    );
  }
}
export function section(title: string) {
  console.log(`\n── ${title}`);
}
export function finish(suite: string): never {
  console.log(`\n${suite}: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failed:\n  - ' + fails.join('\n  - '));
    process.exit(1);
  }
  process.exit(0);
}

let ipSeq = Math.floor(Math.random() * 200);
/** A fresh client IP (X-Forwarded-For) so per-IP risk checks stay per test. */
export function freshIp(): string {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

export async function req(
  method: string,
  path: string,
  opts: {
    token?: string;
    companyId?: string;
    json?: unknown;
    ip?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['x-company-id'] = opts.companyId;
  if (opts.ip) headers['X-Forwarded-For'] = opts.ip;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    /* not JSON */
  }
  return { status: r.status, body };
}

export const data = (r: Res) => r.body?.data ?? r.body;
/** The error code of a failed call, wherever the envelope put it. */
export const code = (r: Res) =>
  r.body?.error?.code ?? r.body?.code ?? r.body?.data?.code;
export const errBody = (r: Res) => r.body?.error ?? r.body;

export class Db {
  private client: any;
  async open() {
    if (!PG_URL) throw new Error('DATABASE_URL is required');
    this.client = new Client({ connectionString: PG_URL });
    await this.client.connect();
    return this;
  }
  async sql<T = any>(q: string, p: unknown[] = []): Promise<T[]> {
    return (await this.client.query(q, p)).rows;
  }
  async one<T = any>(q: string, p: unknown[] = []): Promise<T> {
    return (await this.sql<T>(q, p))[0];
  }
  async close() {
    await this.client?.end();
  }
}

/** A throwaway super-admin for this run, created straight in the database. */
export async function superAdmin(db: Db) {
  const email = `super_${RUN}_${randomUUID().slice(0, 6)}@example.com`;
  const password = `Sa!${randomUUID()}`;
  const hash = await bcrypt.hash(password, 10);
  const [row] = await db.sql(
    `INSERT INTO users (email, password_hash, display_name, role, is_active, is_email_verified)
     VALUES ($1, $2, 'QA Super Admin', 'super_admin', true, true) RETURNING id`,
    [email, hash],
  );
  const login = await req('POST', '/auth/signin', {
    json: { email, password },
  });
  const token = data(login)?.tokens?.accessToken as string;
  if (!token) throw new Error(`super-admin sign-in failed: ${login.status}`);
  return { id: row.id as string, email, token };
}

let phoneSeq = Math.floor(Math.random() * 9_000_000);
/** A unique, valid Pakistani mobile in local form (03XX…). */
export function freshPhone(): string {
  phoneSeq = (phoneSeq + 7919) % 10_000_000;
  return `0321${String(phoneSeq).padStart(7, '0')}`;
}
export const canonical = (local: string) => `+92${local.slice(1)}`;

let ownerSeq = 0;
export interface Owner {
  email: string;
  userId: string;
  token: string;
  companyId: string;
  phone: string | null;
  ip: string;
}

/**
 * Sign up an owner, verify the inbox (SQL), sign in and set up a company —
 * what every registration does before choosing a path.
 */
export async function owner(
  db: Db,
  opts: {
    email?: string;
    phone?: string | null;
    taxId?: string;
    verified?: boolean;
    companyName?: string;
  } = {},
): Promise<Owner> {
  ownerSeq += 1;
  const email = opts.email ?? `owner_${RUN}_${ownerSeq}@example.com`;
  const ip = freshIp();
  const signup = await req('POST', '/auth/signup', {
    ip,
    json: {
      email,
      password: PASSWORD,
      displayName: `QA Owner ${ownerSeq}`,
      role: 'admin',
    },
  });
  const userId = data(signup)?.user?.id as string;
  if (!userId) {
    throw new Error(
      `signup failed: ${signup.status} ${JSON.stringify(signup.body)?.slice(0, 300)}`,
    );
  }
  if (opts.verified !== false) {
    await db.sql(
      `UPDATE users SET is_email_verified = true, email_verified_at = now() WHERE id = $1`,
      [userId],
    );
  }
  const token =
    opts.verified === false
      ? (data(signup)?.tokens?.accessToken as string)
      : await signin(email, PASSWORD, ip);
  const phone = opts.phone === undefined ? freshPhone() : opts.phone;
  let companyId = '';
  if (opts.verified !== false) {
    const co = await req('POST', '/companies', {
      token,
      ip,
      json: {
        name: opts.companyName ?? `QA Co ${RUN}-${ownerSeq}`,
        industry: 'Wholesale',
        ...(phone ? { phone } : {}),
        ...(opts.taxId ? { taxId: opts.taxId } : {}),
      },
    });
    companyId = data(co)?.id as string;
    if (!companyId) {
      throw new Error(
        `company setup failed: ${co.status} ${JSON.stringify(co.body)?.slice(0, 300)}`,
      );
    }
  }
  // A token minted before the company existed carries no companyId; sign in
  // again so company routes see it (what both clients do after setup).
  const sessionToken = companyId ? await signin(email, PASSWORD, ip) : token;
  return { email, userId, token: sessionToken, companyId, phone, ip };
}

export async function signin(
  email: string,
  password = PASSWORD,
  ip: string = freshIp(),
) {
  const r = await req('POST', '/auth/signin', {
    ip,
    json: { email, password },
  });
  const token = data(r)?.tokens?.accessToken as string;
  if (!token) throw new Error(`signin failed for ${email}: ${r.status}`);
  return token;
}

/** Start the free trial the way the web client does. */
export const startTrial = (o: Owner) =>
  req('POST', '/companies/start-trial', {
    token: o.token,
    companyId: o.companyId,
    json: { companyId: o.companyId },
    ip: o.ip,
  });

// ── Mailpit (optional) ──

let mailpitOk: boolean | null = null;
export async function mailpitAvailable(): Promise<boolean> {
  if (mailpitOk !== null) return mailpitOk;
  if (process.env.EXPECT_MAIL !== 'true') return (mailpitOk = false);
  try {
    const r = await fetch(`${MAILPIT}/api/v1/info`);
    mailpitOk = r.ok;
  } catch {
    mailpitOk = false;
  }
  return mailpitOk;
}

/** Messages sent to `to` (newest first), optionally waiting for one. */
export async function mailTo(
  to: string,
  opts: { subject?: RegExp; waitMs?: number } = {},
): Promise<Array<{ Subject: string; ID: string; Attachments: number }>> {
  const deadline = Date.now() + (opts.waitMs ?? 4000);
  for (;;) {
    const r = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const body: any = await r.json();
    const list = (body.messages ?? []).filter(
      (m: any) => !opts.subject || opts.subject.test(m.Subject),
    );
    if (list.length || Date.now() > deadline) return list;
    await new Promise((res) => setTimeout(res, 300));
  }
}

export async function mailText(id: string): Promise<string> {
  const r = await fetch(`${MAILPIT}/api/v1/message/${id}`);
  const body: any = await r.json();
  return `${body.Text ?? ''}\n${body.HTML ?? ''}`;
}

export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Debits and credits of a company's Trial Balance, as strings. */
export async function trialBalance(db: Db, companyId: string) {
  const [row] = await db.sql(
    `SELECT coalesce(sum(debit), 0)::text AS d, coalesce(sum(credit), 0)::text AS c,
            count(*)::int AS lines
       FROM general_ledger WHERE company_id = $1`,
    [companyId],
  );
  return row as { d: string; c: string; lines: number };
}
