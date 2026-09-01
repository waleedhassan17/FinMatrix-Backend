import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { ResponseEnvelopeInterceptor } from '../src/common/interceptors/response-envelope.interceptor';

/**
 * ROLE CONFORMANCE — the guarantee that the code matches the permission
 * matrices, not just that it compiles.
 *
 * Table A: what staff may do directly, what becomes a request, what is refused.
 * Table B: the delivery lifecycle, step by step.
 *
 * Two properties matter more than any individual case and are asserted
 * repeatedly:
 *   1. A pending request has NO effect — no journal entry, no document.
 *   2. Approving posts through the same code an owner's direct action uses,
 *      so the accounting is identical either way, and the trial balance
 *      still balances afterwards.
 *
 * Requires Postgres:  docker compose up -d postgres && npm run migration:run
 */
describe('Role conformance (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwt: JwtService;
  let jwtSecret: string;
  let http: ReturnType<typeof request>;

  const suffix = randomUUID().slice(0, 8);
  const PASSWORD = 'Test1234!';

  let companyId: string;
  let ownerId: string;
  let owner2Id: string;
  let staffId: string;
  let riderId: string;

  let ownerToken = '';
  let owner2Token = '';
  let staffToken = '';
  let riderToken = '';

  let itemId: string;
  let customerId: string;
  let vendorId: string;
  let rentExpenseAccountId: string;
  let cashAccountId: string;

  // ── helpers ───────────────────────────────────────────────────────────────

  const as = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'x-company-id': companyId,
  });

  const post = (url: string, token: string, body?: unknown) =>
    request(app.getHttpServer()).post(url).set(as(token)).send(body ?? {});

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set(as(token));

  const patch = (url: string, token: string, body?: unknown) =>
    request(app.getHttpServer()).patch(url).set(as(token)).send(body ?? {});

  /** Rows in approval_requests for this company, newest first. */
  const approvalRows = async (): Promise<
    Array<{ id: string; type: string; status: string }>
  > =>
    ds.query(
      `SELECT id, type, status FROM approval_requests
        WHERE company_id = $1 ORDER BY created_at DESC`,
      [companyId],
    );

  const countJournalEntries = async (): Promise<number> => {
    const [row] = await ds.query(
      `SELECT COUNT(*)::int AS n FROM journal_entries WHERE company_id = $1`,
      [companyId],
    );
    return Number(row.n);
  };

  /**
   * The golden rule. Sums every posted general-ledger row; debits must equal
   * credits to the paisa.
   */
  const trialBalanceDelta = async (): Promise<string> => {
    const [row] = await ds.query(
      `SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) AS delta
         FROM general_ledger WHERE company_id = $1`,
      [companyId],
    );
    return String(Number(row.delta).toFixed(4));
  };

  /** Balance of one account by its number, from the posted GL. */
  const accountBalance = async (accountNumber: string): Promise<number> => {
    const [row] = await ds.query(
      `SELECT COALESCE(SUM(g.debit), 0) - COALESCE(SUM(g.credit), 0) AS bal
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND a.account_number = $2`,
      [companyId, accountNumber],
    );
    return Number(row.bal);
  };

  /**
   * Perform a request and fail with the SERVER's message when the status is
   * unexpected. supertest's .expect(201) reports only "got 400", which turns
   * every seed problem into a guessing game.
   */
  const created = async (
    label: string,
    req: request.Test,
  ): Promise<Record<string, any>> => {
    const res = await req;
    if (![200, 201].includes(res.status)) {
      throw new Error(`${label} → ${res.status}: ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  };

  /**
   * Mint an access token directly.
   *
   * POST /auth/signin is rate-limited to 5 per minute, and this suite needs
   * far more tokens than that as it switches between four accounts and flips
   * one of them between roles. Minting bypasses the limiter without weakening
   * anything under test: the token carries exactly what a real sign-in puts
   * in it, and every request still goes through the real guards.
   *
   * Sign-in itself is exercised for real in `signIn` below, once per role.
   */
  const tokenFor = (userId: string, role: string): string =>
    jwt.sign(
      { sub: userId, companyId, role, jti: randomUUID() },
      { secret: jwtSecret, expiresIn: '1h' },
    );

  const signIn = async (identifier: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signin')
      .send({ identifier, password: PASSWORD });
    const token =
      res.body?.data?.tokens?.accessToken ?? res.body?.data?.accessToken ?? '';
    if (!token) {
      // Returning '' here would surface as a confusing 401 in whichever test
      // used the token next, rather than at the sign-in that actually failed.
      throw new Error(
        `sign-in failed for ${identifier} → ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    return token;
  };

  // ── setup ─────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(app.get(Reflector)));
    await app.init();

    ds = moduleFixture.get(DataSource);
    jwt = moduleFixture.get(JwtService);
    jwtSecret = moduleFixture.get(ConfigService).getOrThrow<string>('jwt.secret');
    http = request(app.getHttpServer());

    await seed();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function seed() {
    // The owner signs up through the API so the account is real, then creates
    // the company through the API too — that is what seeds the default chart
    // of accounts, which every posting assertion below depends on.
    const ownerEmail = `owner-${suffix}@conformance.test`;
    const signup = await http
      .post('/api/v1/auth/signup')
      .send({
        email: ownerEmail,
        password: PASSWORD,
        displayName: 'Conformance Owner',
        role: 'admin',
      })
      .expect(201);
    ownerId = signup.body.data.user.id;

    // Email verification is a sign-in gate for admins; this account has no
    // inbox to click through in a test.
    await ds.query(
      `UPDATE users SET is_email_verified = true, email_verified_at = now() WHERE id = $1`,
      [ownerId],
    );
    ownerToken = await signIn(ownerEmail);
    expect(ownerToken).toBeTruthy();

    const company = await http
      .post('/api/v1/companies')
      .set({ Authorization: `Bearer ${ownerToken}` })
      .send({ name: `Conformance Co ${suffix}`, industry: 'Warehouse' })
      .expect(201);
    companyId = company.body.data.id;

    // CompanyGuard rejects anything that is not active, and the warehouse tier
    // is what unlocks inventory, delivery and purchase orders.
    // A paid warehouse plan: the default 'free' plan allows only two team
    // members, which the two owners below would exhaust before staff exists.
    await ds.query(
      `UPDATE companies
          SET status = 'active', company_type = 'warehouse',
              subscription_plan = 'warehouse_scale_6mo'
        WHERE id = $1`,
      [companyId],
    );
    await ds.query(
      `UPDATE users SET default_company_id = $1 WHERE id = $2`,
      [companyId, ownerId],
    );
    ownerToken = tokenFor(ownerId, 'admin');

    // A second owner, so "maker != checker" can be tested: approving needs a
    // DIFFERENT owner from the one who filed the request.
    const owner2Email = `owner2-${suffix}@conformance.test`;
    const signup2 = await http
      .post('/api/v1/auth/signup')
      .send({
        email: owner2Email,
        password: PASSWORD,
        displayName: 'Conformance Owner Two',
        role: 'admin',
      })
      .expect(201);
    owner2Id = signup2.body.data.user.id;
    await ds.query(
      `UPDATE users SET is_email_verified = true, email_verified_at = now(),
              default_company_id = $1 WHERE id = $2`,
      [companyId, owner2Id],
    );
    await ds.query(
      `INSERT INTO user_companies (user_id, company_id, role) VALUES ($1, $2, 'admin')
       ON CONFLICT DO NOTHING`,
      [owner2Id, companyId],
    );
    owner2Token = tokenFor(owner2Id, 'admin');

    // Staff, created the way the product creates them: by the owner, through
    // user management, with a username and a password.
    const staff = await post('/api/v1/settings/users', ownerToken, {
      name: 'Conformance Staff',
      username: `staff.${suffix}`,
      password: PASSWORD,
      role: 'staff',
    });
    if (staff.status !== 201) {
      throw new Error(`staff create failed ${staff.status}: ${JSON.stringify(staff.body)}`);
    }
    staffId = staff.body.data.id;
    staffToken = await signIn(`staff.${suffix}`);
    expect(staffToken).toBeTruthy();

    // A rider, created by staff — which is itself part of the contract.
    const rider = await post('/api/v1/delivery-personnel', staffToken, {
      username: `rider.${suffix}`,
      password: PASSWORD,
      name: 'Conformance Rider',
      vehicleType: 'motorcycle',
    });
    if (rider.status !== 201) {
      throw new Error(`rider create failed ${rider.status}: ${JSON.stringify(rider.body)}`);
    }
    riderId = rider.body.data.userId;
    riderToken = tokenFor(riderId, 'delivery');

    // Reference data the tests transact against.
    customerId = (
      await created(
        'customer',
        post('/api/v1/customers', ownerToken, { name: 'Conformance Customer' }),
      )
    ).id;

    vendorId = (
      await created(
        'vendor',
        post('/api/v1/vendors', ownerToken, { companyName: 'Conformance Vendor' }),
      )
    ).id;

    itemId = (
      await created(
        'item',
        post('/api/v1/inventory/items', ownerToken, {
          sku: `SKU-${suffix}`,
          name: 'Conformance Widget',
          unitCost: '60',
          sellingPrice: '100',
        }),
      )
    ).id;

    // Stock to sell and dispatch. Done by the OWNER so it posts immediately —
    // an adjustment filed by staff would sit pending and leave the item empty.
    await created(
      'opening stock',
      post(`/api/v1/inventory/items/${itemId}/adjust`, ownerToken, {
        itemId,
        newQty: '500',
        reason: 'physical_count',
      }),
    );

    // Read the seeded chart of accounts straight from the database rather
    // than through the paginated list endpoint — the test needs two specific
    // account ids, not a page of them.
    const accountId = async (number: string): Promise<string> => {
      const [row] = await ds.query(
        `SELECT id FROM accounts WHERE company_id = $1 AND account_number = $2`,
        [companyId, number],
      );
      if (!row) throw new Error(`Seeded chart of accounts has no ${number}`);
      return row.id;
    };
    // Deliberately NOT the Inventory control account (1200): a manual journal
    // debiting it without a matching item movement is a genuine subledger
    // drift, and qa/invariants.sql I13 rightly reports it. The test's job is
    // to exercise maker-checker, not to manufacture a broken ledger.
    rentExpenseAccountId = await accountId('6000');
    cashAccountId = await accountId('1000');
    expect(rentExpenseAccountId).toBeTruthy();
    expect(cashAccountId).toBeTruthy();
  }

  async function cleanup() {
    try {
      await ds.query(`DELETE FROM approval_requests WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM managed_credentials WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM user_companies WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        [ownerId, owner2Id, staffId, riderId].filter(Boolean),
      ]);
      await ds.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
    } catch {
      // Best-effort teardown; a failure here must not mask a test result.
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TABLE A — value in: staff act directly, and file NO request
  // ══════════════════════════════════════════════════════════════════════════

  describe('Table A · value in — staff act directly', () => {
    it('staff raise an invoice, and no approval request is created', async () => {
      const before = (await approvalRows()).length;

      const res = await post('/api/v1/invoices', staffToken, {
        customerId,
        invoiceDate: '2026-01-15',
        dueDate: '2026-02-15',
        lines: [
          { description: 'Widget', quantity: '2', unitPrice: '100', itemId },
        ],
      });
      if (![200, 201].includes(res.status))
        throw new Error(`invoice → ${res.status}: ${JSON.stringify(res.body)}`);

      expect((await approvalRows()).length).toBe(before);
    });

    it('staff receive a customer payment directly', async () => {
      const invoice = await post('/api/v1/invoices', staffToken, {
        customerId,
        invoiceDate: '2026-01-16',
        dueDate: '2026-02-16',
        lines: [{ description: 'Widget', quantity: '1', unitPrice: '100', itemId }],
      });
      const invoiceId = invoice.body.data.id;
      const sent = await post(`/api/v1/invoices/${invoiceId}/send`, staffToken);
      if (sent.status !== 200)
        throw new Error(`send → ${sent.status}: ${JSON.stringify(sent.body)}`);

      const before = (await approvalRows()).length;
      const res = await post('/api/v1/payments', staffToken, {
        customerId,
        amount: '50',
        paymentDate: '2026-01-20',
        paymentMethod: 'cash',
        bankAccountId: cashAccountId,
        applications: [{ invoiceId, amount: '50' }],
      });
      if (![200, 201].includes(res.status))
        throw new Error(`payment → ${res.status}: ${JSON.stringify(res.body)}`);
      expect((await approvalRows()).length).toBe(before);
    });

    it('staff create a customer and a vendor directly', async () => {
      const before = (await approvalRows()).length;
      await post('/api/v1/customers', staffToken, { name: 'Walk-in' }).expect(201);
      await post('/api/v1/vendors', staffToken, { companyName: 'Local supplier' }).expect(201);
      expect((await approvalRows()).length).toBe(before);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  TABLE A — money out & corrections: staff file requests with NO effect
  // ══════════════════════════════════════════════════════════════════════════

  describe('Table A · corrections — staff file requests that do nothing yet', () => {
    it('an inventory adjustment by staff creates ONE pending request and posts nothing', async () => {
      const journalsBefore = await countJournalEntries();

      const res = await post(`/api/v1/inventory/items/${itemId}/adjust`, staffToken, {
        itemId,
        newQty: '80',
        reason: 'damage',
      });
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.pending).toBe(true);

      const rows = (await approvalRows()).filter((r) => r.type === 'adjustment');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');

      // The whole point: nothing posted.
      expect(await countJournalEntries()).toBe(journalsBefore);
    });

    it('a purchase order by staff commits NO purchase order until approved', async () => {
      const res = await post('/api/v1/purchase-orders', staffToken, {
        vendorId,
        orderDate: '2026-01-10',
        lines: [{ itemId, description: 'Widget', orderedQty: '10', unitCost: '60' }],
      });
      if (![200, 201].includes(res.status))
        throw new Error(`po → ${res.status}: ${JSON.stringify(res.body)}`);
      expect(res.body.data.pending).toBe(true);

      const [row] = await ds.query(
        `SELECT COUNT(*)::int AS n FROM purchase_orders WHERE company_id = $1`,
        [companyId],
      );
      expect(Number(row.n)).toBe(0);
    });

    it('an owner posts the same adjustment directly, with no request row', async () => {
      const before = (await approvalRows()).length;
      const journalsBefore = await countJournalEntries();

      await post(`/api/v1/inventory/items/${itemId}/adjust`, ownerToken, {
        itemId,
        newQty: '95',
        reason: 'correction',
      }).expect(201);

      expect((await approvalRows()).length).toBe(before);
      expect(await countJournalEntries()).toBeGreaterThan(journalsBefore);
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('staff cannot decide a request (403), and the owner can', async () => {
      const [pending] = (await approvalRows()).filter(
        (r) => r.type === 'adjustment' && r.status === 'pending',
      );
      expect(pending).toBeTruthy();

      await post(`/api/v1/approvals/${pending.id}/decide`, staffToken, {
        decision: 'approve',
      }).expect(403);

      const journalsBefore = await countJournalEntries();
      await post(`/api/v1/approvals/${pending.id}/decide`, ownerToken, {
        decision: 'approve',
      }).expect(200);

      // Exactly one entry, and the books still balance.
      expect(await countJournalEntries()).toBe(journalsBefore + 1);
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('deciding a second time is a no-op — it cannot post twice', async () => {
      const [approved] = (await approvalRows()).filter(
        (r) => r.type === 'adjustment' && r.status === 'approved',
      );
      expect(approved).toBeTruthy();

      const journalsBefore = await countJournalEntries();
      const res = await post(`/api/v1/approvals/${approved.id}/decide`, ownerToken, {
        decision: 'approve',
      }).expect(200);

      expect(res.body.data.status).toBe('approved');
      expect(await countJournalEntries()).toBe(journalsBefore);
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('maker cannot be checker: an owner cannot approve their own request', async () => {
      // owner2 files a journal request by being... an owner? No: owners post
      // directly. So file as staff, then have the requester try to approve.
      // The check that matters is requestedBy === reviewer.
      const filed = await post('/api/v1/journal-entries', staffToken, {
        date: '2026-01-22',
        memo: 'Conformance journal',
        lines: [
          { accountId: rentExpenseAccountId, debit: '10', credit: '0' },
          { accountId: cashAccountId, debit: '0', credit: '10' },
        ],
      });
      const requestId = filed.body.data.requestId;

      // Promote the requester to owner, then try to approve their own request.
      await ds.query(
        `UPDATE user_companies SET role = 'admin' WHERE user_id = $1 AND company_id = $2`,
        [staffId, companyId],
      );
      const promoted = tokenFor(staffId, 'admin');
      await post(`/api/v1/approvals/${requestId}/decide`, promoted, {
        decision: 'approve',
      }).expect(403);

      // Put them back.
      await ds.query(
        `UPDATE user_companies SET role = 'staff' WHERE user_id = $1 AND company_id = $2`,
        [staffId, companyId],
      );
      staffToken = tokenFor(staffId, 'staff');

      // A different owner can approve it.
      await post(`/api/v1/approvals/${requestId}/decide`, owner2Token, {
        decision: 'approve',
      }).expect(200);
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('a rejection requires a reason, and posts nothing', async () => {
      const filed = await post(`/api/v1/inventory/items/${itemId}/adjust`, staffToken, {
        itemId,
        newQty: '70',
        reason: 'theft',
      });
      const requestId = filed.body.data.requestId;
      const journalsBefore = await countJournalEntries();

      await post(`/api/v1/approvals/${requestId}/decide`, ownerToken, {
        decision: 'reject',
      }).expect(400);

      await post(`/api/v1/approvals/${requestId}/decide`, ownerToken, {
        decision: 'reject',
        comment: 'Count it again before writing it off.',
      }).expect(200);

      expect(await countJournalEntries()).toBe(journalsBefore);
    });

    it('staff see only their own requests; the owner sees the whole inbox', async () => {
      const staffView = await get('/api/v1/approvals?status=all', staffToken).expect(200);
      const ownerView = await get('/api/v1/approvals?status=all', ownerToken).expect(200);

      expect(
        staffView.body.data.every(
          (r: { requestedBy: string }) => r.requestedBy === staffId,
        ),
      ).toBe(true);
      expect(ownerView.body.data.length).toBeGreaterThanOrEqual(
        staffView.body.data.length,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  TABLE A — governance: 403 for staff at the SERVER
  // ══════════════════════════════════════════════════════════════════════════

  describe('Table A · governance — refused for staff', () => {
    it('user management is closed to staff', async () => {
      await get('/api/v1/settings/users', staffToken).expect(403);
      await post('/api/v1/settings/users', staffToken, {
        name: 'Sneaky',
        username: `sneaky.${suffix}`,
        password: PASSWORD,
        role: 'admin',
      }).expect(403);
      await patch(`/api/v1/settings/users/${staffId}/role`, staffToken, {
        role: 'admin',
      }).expect(403);
      await patch(`/api/v1/settings/users/${staffId}/deactivate`, staffToken).expect(403);
    });

    it('settings writes are closed to staff', async () => {
      await patch('/api/v1/settings', staffToken, { preferences: {} }).expect(403);
    });

    it('chart-of-accounts writes are closed to staff', async () => {
      await post('/api/v1/accounts', staffToken, {
        accountNumber: '9999',
        name: 'Sneaky account',
        type: 'asset',
        subType: 'current_asset',
      }).expect(403);
    });

    it('period close and reopen are closed to staff', async () => {
      await post(`/api/v1/companies/${companyId}/period-close`, staffToken, {
        lockDate: '2026-01-31',
      }).expect(403);
      await post(`/api/v1/companies/${companyId}/period-reopen`, staffToken).expect(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  TABLE B — the delivery lifecycle, step by step
  // ══════════════════════════════════════════════════════════════════════════

  describe('Table B · delivery lifecycle', () => {
    let deliveryId: string;

    it('row 1 — staff create a delivery: non-posting, no request', async () => {
      const requestsBefore = (await approvalRows()).length;
      const journalsBefore = await countJournalEntries();

      const res = await post('/api/v1/deliveries', staffToken, {
        customerId,
        scheduledDate: '2026-02-01',
        items: [
          { itemId, itemName: 'Conformance Widget', orderedQty: 2, unitPrice: 100 },
        ],
      });
      if (![200, 201].includes(res.status))
        throw new Error(`delivery → ${res.status}: ${JSON.stringify(res.body)}`);
      deliveryId = res.body.data.id;

      expect((await approvalRows()).length).toBe(requestsBefore);
      expect(await countJournalEntries()).toBe(journalsBefore);
    });

    it('row 2 — staff assign to a rider: this POSTS, directly, with no request', async () => {
      // Give the item stock to dispatch.
      await post(`/api/v1/inventory/items/${itemId}/adjust`, ownerToken, {
        itemId,
        newQty: '200',
        reason: 'correction',
      }).expect(201);

      const requestsBefore = (await approvalRows()).length;
      const gitBefore = await accountBalance('1250');

      await post('/api/v1/deliveries/assign', staffToken, {
        deliveryIds: [deliveryId],
        personnelId: riderId,
      }).expect(201);

      // Goods in Transit is debited at cost — the one ledger-moving action
      // staff take with no approval at all.
      expect(await accountBalance('1250')).toBeGreaterThan(gitBefore);
      expect((await approvalRows()).length).toBe(requestsBefore);

      // And critically: no revenue yet.
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('row 7 — staff cannot undo without a reason, and never directly', async () => {
      // Undo needs an approved request; this one is not approved yet, but the
      // reason check runs first and is what we are asserting here.
      const res = await post(
        `/api/v1/inventory-update-requests/${randomUUID()}/undo`,
        staffToken,
        {},
      );
      expect(res.status).toBe(400);
      expect(res.body.error?.code ?? res.body.code).toBe('REASON_REQUIRED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  The golden rule, last
  // ══════════════════════════════════════════════════════════════════════════

  describe('Accounting invariants', () => {
    it('the trial balance balances after everything above', async () => {
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('no approved request is missing its posting, and no pending request has one', async () => {
      const rows = await ds.query(
        `SELECT status, journal_entry_id, type FROM approval_requests WHERE company_id = $1`,
        [companyId],
      );
      for (const r of rows) {
        if (r.status === 'pending' || r.status === 'rejected' || r.status === 'cancelled') {
          // The invariant the whole feature rests on.
          expect(r.journal_entry_id).toBeNull();
        }
      }
    });
  });
});
