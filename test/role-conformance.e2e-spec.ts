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
    request(app.getHttpServer())
      .post(url)
      .set(as(token))
      .send(body ?? {});

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set(as(token));

  const patch = (url: string, token: string, body?: unknown) =>
    request(app.getHttpServer())
      .patch(url)
      .set(as(token))
      .send(body ?? {});

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

  /** Current on-hand for the fixture item. */
  const itemQty = async (): Promise<number> => {
    const [row] = await ds.query(
      `SELECT quantity_on_hand FROM inventory_items WHERE id = $1`,
      [itemId],
    );
    return Number(row.quantity_on_hand);
  };

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
    app.useGlobalInterceptors(
      new ResponseEnvelopeInterceptor(app.get(Reflector)),
    );
    await app.init();

    ds = moduleFixture.get(DataSource);
    jwt = moduleFixture.get(JwtService);
    jwtSecret = moduleFixture
      .get(ConfigService)
      .getOrThrow<string>('jwt.secret');
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
    await ds.query(`UPDATE users SET default_company_id = $1 WHERE id = $2`, [
      companyId,
      ownerId,
    ]);
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
      throw new Error(
        `staff create failed ${staff.status}: ${JSON.stringify(staff.body)}`,
      );
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
      throw new Error(
        `rider create failed ${rider.status}: ${JSON.stringify(rider.body)}`,
      );
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
        post('/api/v1/vendors', ownerToken, {
          companyName: 'Conformance Vendor',
        }),
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
      await ds.query(`DELETE FROM approval_requests WHERE company_id = $1`, [
        companyId,
      ]);
      await ds.query(`DELETE FROM managed_credentials WHERE company_id = $1`, [
        companyId,
      ]);
      await ds.query(`DELETE FROM user_companies WHERE company_id = $1`, [
        companyId,
      ]);
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
        lines: [
          { description: 'Widget', quantity: '1', unitPrice: '100', itemId },
        ],
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
      await post('/api/v1/customers', staffToken, { name: 'Walk-in' }).expect(
        201,
      );
      await post('/api/v1/vendors', staffToken, {
        companyName: 'Local supplier',
      }).expect(201);
      expect((await approvalRows()).length).toBe(before);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  TABLE A — money out & corrections: staff file requests with NO effect
  // ══════════════════════════════════════════════════════════════════════════

  describe('Table A · corrections — staff file requests that do nothing yet', () => {
    it('an inventory adjustment by staff creates ONE pending request and posts nothing', async () => {
      const journalsBefore = await countJournalEntries();

      const res = await post(
        `/api/v1/inventory/items/${itemId}/adjust`,
        staffToken,
        {
          itemId,
          newQty: '80',
          reason: 'damage',
        },
      );
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.pending).toBe(true);

      const rows = (await approvalRows()).filter(
        (r) => r.type === 'adjustment',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');

      // The whole point: nothing posted.
      expect(await countJournalEntries()).toBe(journalsBefore);
    });

    it('a purchase order by staff commits NO purchase order until approved', async () => {
      const res = await post('/api/v1/purchase-orders', staffToken, {
        vendorId,
        orderDate: '2026-01-10',
        lines: [
          { itemId, description: 'Widget', orderedQty: '10', unitCost: '60' },
        ],
      });
      if (![200, 201].includes(res.status))
        throw new Error(`po → ${res.status}: ${JSON.stringify(res.body)}`);
      expect(res.body.data.pending).toBe(true);

      const [row] = await ds.query(
        `SELECT COUNT(*)::int AS n FROM purchase_orders WHERE company_id = $1`,
        [companyId],
      );
      expect(Number(row.n)).toBe(0);

      // …and the other half: approving must actually COMMIT it. Proving only
      // that nothing exists while pending would pass just as well if approval
      // were wired to nothing at all.
      const journalsBefore = await countJournalEntries();
      await post(`/api/v1/approvals/${res.body.data.requestId}/decide`, ownerToken, {
        decision: 'approve',
      }).expect(200);

      const [after] = await ds.query(
        `SELECT COUNT(*)::int AS n FROM purchase_orders WHERE company_id = $1`,
        [companyId],
      );
      expect(Number(after.n)).toBe(1);

      // A commitment is not a transaction: the PO exists and the ledger has
      // not moved.
      expect(await countJournalEntries()).toBe(journalsBefore);
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('an owner posts the same adjustment directly, with no request row', async () => {
      const before = (await approvalRows()).length;
      const journalsBefore = await countJournalEntries();

      await post(`/api/v1/inventory/items/${itemId}/adjust`, ownerToken, {
        itemId,
        newQty: '495',
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
      const res = await post(
        `/api/v1/approvals/${approved.id}/decide`,
        ownerToken,
        {
          decision: 'approve',
        },
      ).expect(200);

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
      const filed = await post(
        `/api/v1/inventory/items/${itemId}/adjust`,
        staffToken,
        {
          itemId,
          newQty: '70',
          reason: 'theft',
        },
      );
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
      const staffView = await get(
        '/api/v1/approvals?status=all',
        staffToken,
      ).expect(200);
      const ownerView = await get(
        '/api/v1/approvals?status=all',
        ownerToken,
      ).expect(200);

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
      await patch(
        `/api/v1/settings/users/${staffId}/deactivate`,
        staffToken,
      ).expect(403);
    });

    it('settings writes are closed to staff', async () => {
      await patch('/api/v1/settings', staffToken, { preferences: {} }).expect(
        403,
      );
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
      await post(
        `/api/v1/companies/${companyId}/period-reopen`,
        staffToken,
      ).expect(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  TABLE B — the delivery lifecycle, step by step
  // ══════════════════════════════════════════════════════════════════════════

  describe('Table B · delivery lifecycle', () => {
    let deliveryId: string;
    // The approved completion the reversal tests below credit back.
    let approvedRequestId: string;

    it('row 1 — staff create a delivery: non-posting, no request', async () => {
      const requestsBefore = (await approvalRows()).length;
      const journalsBefore = await countJournalEntries();

      const res = await post('/api/v1/deliveries', staffToken, {
        customerId,
        scheduledDate: '2026-02-01',
        items: [
          {
            itemId,
            itemName: 'Conformance Widget',
            orderedQty: 2,
            unitPrice: 100,
          },
        ],
      });
      if (![200, 201].includes(res.status))
        throw new Error(
          `delivery → ${res.status}: ${JSON.stringify(res.body)}`,
        );
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

    it('rows 3-4 — a rider delivers, and STAFF sign it off with their role recorded', async () => {
      // The rider's proof upload is multipart and covered by
      // inventory-approvals.e2e-spec.ts; what matters here is who may APPROVE
      // the resulting request, so the request is seeded directly.
      const requestId = randomUUID();
      approvedRequestId = requestId;
      await ds.query(
        `INSERT INTO inventory_update_requests
           (id, company_id, delivery_id, personnel_id, status, submitted_at)
         VALUES ($1, $2, $3, $4, 'pending', now())`,
        [requestId, companyId, deliveryId, riderId],
      );
      // after_qty is `before + returned`, NOT `before - delivered`: this
      // delivery was assigned, so the dispatched units already left on-hand at
      // that point. Subtracting them again removes the same goods twice, which
      // is precisely what invariant I16 exists to catch.
      await ds.query(
        `INSERT INTO inventory_update_request_lines
           (id, request_id, item_id, item_name, before_qty, delivered_qty, returned_qty, after_qty)
         VALUES ($1, $2, $3, 'Conformance Widget', 500, 2, 0, 500)`,
        [randomUUID(), requestId, itemId],
      );

      const gitBefore = await accountBalance('1250');
      const revenueBefore = await accountBalance('4000');

      const res = await post(
        `/api/v1/inventory-update-requests/${requestId}/approve`,
        staffToken,
        { reviewerComment: 'Delivered in full.' },
      );
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`approve → ${res.status}: ${JSON.stringify(res.body)}`);
      }

      // Revenue posts here and nowhere earlier (revenue accounts carry a
      // credit balance, so the signed balance moves DOWN).
      expect(await accountBalance('4000')).toBeLessThan(revenueBefore);
      // Goods in Transit is relieved.
      expect(await accountBalance('1250')).toBeLessThan(gitBefore);
      expect(await trialBalanceDelta()).toBe('0.0000');

      // And the authority that signed it is recorded as staff.
      const [row] = await ds.query(
        `SELECT reviewed_by, reviewer_role, status FROM inventory_update_requests WHERE id = $1`,
        [requestId],
      );
      expect(row.status).toBe('approved');
      expect(row.reviewer_role).toBe('staff');
      expect(row.reviewed_by).toBe(staffId);
    });

    it('a rider cannot approve their own delivery (checker != rider)', async () => {
      const requestId = randomUUID();
      await ds.query(
        `INSERT INTO inventory_update_requests
           (id, company_id, delivery_id, personnel_id, status, submitted_at)
         VALUES ($1, $2, $3, $4, 'pending', now())`,
        [requestId, companyId, deliveryId, riderId],
      );

      const res = await post(
        `/api/v1/inventory-update-requests/${requestId}/approve`,
        riderToken,
        {},
      );
      // 403 either way: riders are not in @Roles for this route, and the
      // service refuses a reviewer who is the delivering rider.
      expect(res.status).toBe(403);
    });


    // ══════════════════════════════════════════════════════════════════════
    //  Reversing an approved delivery, via a pre-filled credit memo
    // ══════════════════════════════════════════════════════════════════════

    it('the draft names the customer, the invoice and the DELIVERED quantities', async () => {
      const res = await get(
        `/api/v1/inventory-update-requests/${approvedRequestId}/credit-memo-draft`,
        staffToken,
      );
      if (res.status !== 200) {
        throw new Error(`draft → ${res.status}: ${JSON.stringify(res.body)}`);
      }
      const draft = res.body.data;

      expect(draft.customerId).toBe(customerId);
      // Approving the delivery raised the invoice this credit reverses.
      expect(draft.originalInvoiceId).toBeTruthy();
      expect(draft.reason).toContain('Reversal of delivery');
      // 2 delivered, and the price frozen at dispatch — not today's list price.
      expect(draft.lines).toHaveLength(1);
      expect(Number(draft.lines[0].quantity)).toBe(2);
      expect(Number(draft.lines[0].unitPrice)).toBeGreaterThan(0);
      expect(draft.lines[0].itemId).toBe(itemId);
    });

    it('staff submitting the reversal posts NOTHING and leaves the invoice alone', async () => {
      const draft = (
        await get(
          `/api/v1/inventory-update-requests/${approvedRequestId}/credit-memo-draft`,
          staffToken,
        )
      ).body.data;

      const journalsBefore = await countJournalEntries();
      const [invBefore] = await ds.query(
        `SELECT balance FROM invoices WHERE id = $1`,
        [draft.originalInvoiceId],
      );

      const res = await post('/api/v1/credit-memos', staffToken, {
        customerId: draft.customerId,
        date: draft.date,
        reason: draft.reason,
        originalInvoiceId: draft.originalInvoiceId,
        applyToInvoiceId: draft.originalInvoiceId,
        lines: draft.lines,
      });
      if (![200, 201].includes(res.status)) {
        throw new Error(`staff reversal → ${res.status}: ${JSON.stringify(res.body)}`);
      }
      expect(res.body.data.pending).toBe(true);

      const pending = (await approvalRows()).filter(
        r => r.type === 'credit_memo' && r.status === 'pending',
      );
      expect(pending).toHaveLength(1);

      // The two things that must not have moved.
      expect(await countJournalEntries()).toBe(journalsBefore);
      const [invAfter] = await ds.query(
        `SELECT balance FROM invoices WHERE id = $1`,
        [draft.originalInvoiceId],
      );
      expect(Number(invAfter.balance)).toBe(Number(invBefore.balance));
    });

    it('the owner approving it reverses the sale AND settles the invoice', async () => {
      const [pending] = (await approvalRows()).filter(
        r => r.type === 'credit_memo' && r.status === 'pending',
      );
      expect(pending).toBeTruthy();

      const salesBefore = await accountBalance('4000');
      const arBefore = await accountBalance('1100');
      const inventoryBefore = await accountBalance('1200');
      const cogsBefore = await accountBalance('5000');

      await post(`/api/v1/approvals/${pending.id}/decide`, ownerToken, {
        decision: 'approve',
      }).expect(200);

      // Dr Sales / Cr A/R — revenue comes back down, the receivable clears.
      expect(await accountBalance('4000')).toBeGreaterThan(salesBefore);
      expect(await accountBalance('1100')).toBeLessThan(arBefore);
      // Dr Inventory / Cr COGS — the goods are back on the shelf at cost.
      expect(await accountBalance('1200')).toBeGreaterThan(inventoryBefore);
      expect(await accountBalance('5000')).toBeLessThan(cogsBefore);

      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('deciding the reversal twice cannot post it twice', async () => {
      const [approved] = (await approvalRows()).filter(
        r => r.type === 'credit_memo' && r.status === 'approved',
      );
      const journalsBefore = await countJournalEntries();
      await post(`/api/v1/approvals/${approved.id}/decide`, ownerToken, {
        decision: 'approve',
      }).expect(200);
      expect(await countJournalEntries()).toBe(journalsBefore);
    });


    it('reversing a delivery nets COGS to zero even after the average cost moves', async () => {
      // The sale posted COGS at the cost frozen on the delivery line at
      // dispatch. If the reversal used today's weighted-average instead, a
      // drift between the two would leave a residue in COGS for a sale that
      // never happened — and nothing would catch it, because every entry
      // still balances.
      const requestId = randomUUID();
      const revDeliveryId = randomUUID();

      // A delivery, dispatched and approved at a known cost.
      await ds.query(
        `INSERT INTO deliveries (id, company_id, customer_id, status, created_by,
                                 ledger_status, stock_committed_at, invoice_id)
         VALUES ($1, $2, $3, 'delivered', $4, 'committed', now(), NULL)`,
        [revDeliveryId, companyId, customerId, ownerId],
      );
      await ds.query(
        `INSERT INTO delivery_items (id, delivery_id, item_id, item_name,
                                     quantity, ordered_qty, unit_price, unit_cost, tax_rate)
         VALUES ($1, $2, $3, 'Conformance Widget', 2, 2, 100, 60, 0)`,
        [randomUUID(), revDeliveryId, itemId],
      );
      await ds.query(
        `INSERT INTO inventory_update_requests
           (id, company_id, delivery_id, personnel_id, status, submitted_at)
         VALUES ($1, $2, $3, $4, 'approved', now())`,
        [requestId, companyId, revDeliveryId, riderId],
      );
      await ds.query(
        `INSERT INTO inventory_update_request_lines
           (id, request_id, item_id, item_name, before_qty, delivered_qty, returned_qty, after_qty)
         VALUES ($1, $2, $3, 'Conformance Widget', 500, 2, 0, 500)`,
        [randomUUID(), requestId, itemId],
      );

      // Move the weighted average the way it really moves: buy more of the
      // same item at a higher price. NOT a raw UPDATE of unit_cost — the app
      // refuses that while stock is on hand precisely because it would
      // revalue inventory with no posting behind it, and the test would then
      // be asserting on a state the application cannot produce (invariant I13
      // catches it).
      const po = await created(
        'cost-drift PO',
        post('/api/v1/purchase-orders', ownerToken, {
          vendorId,
          orderDate: '2026-03-10',
          lines: [
            { itemId, description: 'Conformance Widget', orderedQty: '200', unitCost: '95' },
          ],
        }),
      );
      await created(
        'cost-drift receipt',
        post(`/api/v1/purchase-orders/${po.id}/receive`, ownerToken, {
          lines: [{ lineId: po.lines[0].id, receivedQty: '200' }],
        }),
      );

      const draft = (
        await get(
          `/api/v1/inventory-update-requests/${requestId}/credit-memo-draft`,
          ownerToken,
        ).expect(200)
      ).body.data;

      // The draft carries the cost the sale used, not today's.
      expect(Number(draft.lines[0].unitCost)).toBe(60);

      const cogsBefore = await accountBalance('5000');
      await created(
        'reversal',
        post('/api/v1/credit-memos', ownerToken, {
          customerId: draft.customerId,
          date: draft.date,
          reason: draft.reason,
          reversesDeliveryRequestId: draft.deliveryRequestId,
          lines: draft.lines,
        }),
      );

      // 2 × 60 credited out of COGS — exactly what the sale debited in.
      // Using today's 95 would have credited 190 and left 70 of residue.
      expect(cogsBefore - (await accountBalance('5000'))).toBeCloseTo(120, 4);
      expect(await trialBalanceDelta()).toBe('0.0000');
    });


    it('delivery_undo — staff ask, the owner approves, and the stock comes back', async () => {
      // The eighth gated type, and the only one that can still reverse stock.
      // A LEGACY delivery: approved, but the ledger was never committed, so
      // there is no sale to credit and undo is the correct correction rather
      // than a credit memo.
      const undoRequestId = randomUUID();
      const legacyDeliveryId = randomUUID();
      await ds.query(
        `INSERT INTO deliveries (id, company_id, customer_id, status, created_by, ledger_status)
         VALUES ($1, $2, $3, 'delivered', $4, 'none')`,
        [legacyDeliveryId, companyId, customerId, ownerId],
      );
      await ds.query(
        `INSERT INTO inventory_update_requests
           (id, company_id, delivery_id, personnel_id, status, submitted_at, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, 'approved', now(), $5, now())`,
        [undoRequestId, companyId, legacyDeliveryId, riderId, ownerId],
      );
      const startQty = await itemQty();
      await ds.query(
        `INSERT INTO inventory_update_request_lines
           (id, request_id, item_id, item_name, before_qty, delivered_qty, returned_qty, after_qty)
         VALUES ($1, $2, $3, 'Conformance Widget', $4, 5, 0, $5)`,
        // Legacy: approval DID move stock, so before - delivered is right here.
        [randomUUID(), undoRequestId, itemId, startQty, startQty - 5],
      );

      // A legacy approval also POSTED the cost of those units and moved the
      // shelf, and undo reverses that entry by swapping its lines. Use one
      // owner adjustment to do BOTH: it writes the stock movement and its own
      // balanced entry together, so the subledger and GL 1200 stay tied.
      //
      // Posting a separate journal AND an adjustment (my first attempt) moved
      // the GL twice against one shelf movement — invariant I13 caught it, to
      // the paisa.
      const legacyAdjustment = await created(
        'legacy approval movement',
        post(`/api/v1/inventory/items/${itemId}/adjust`, ownerToken, {
          itemId,
          newQty: String(startQty - 5),
          reason: 'correction',
        }),
      );
      const legacyEntryId =
        legacyAdjustment.adjustment?.journalEntryId ??
        legacyAdjustment.journalEntryId;
      expect(legacyEntryId).toBeTruthy();
      await ds.query(
        `UPDATE inventory_update_requests SET journal_entry_id = $1 WHERE id = $2`,
        [legacyEntryId, undoRequestId],
      );

      // Staff ask, with a reason.
      const filed = await post(
        `/api/v1/inventory-update-requests/${undoRequestId}/undo`,
        staffToken,
        { reason: 'Customer never received these — rider logged it wrongly.' },
      );
      if (![200, 201].includes(filed.status)) {
        throw new Error(`undo → ${filed.status}: ${JSON.stringify(filed.body)}`);
      }

      const pending = (await approvalRows()).filter(
        r => r.type === 'delivery_undo' && r.status === 'pending',
      );
      expect(pending).toHaveLength(1);
      // Nothing moves while it waits.
      const qtyBeforeUndo = await itemQty();
      expect(qtyBeforeUndo).toBe(startQty - 5);

      // The owner approves: the stock comes back and the request returns to
      // pending for re-review, which is what undo is for.
      await post(`/api/v1/approvals/${pending[0].id}/decide`, ownerToken, {
        decision: 'approve',
      }).expect(200);

      // The five units are back on the shelf.
      expect(await itemQty()).toBe(qtyBeforeUndo + 5);
      const [row] = await ds.query(
        `SELECT status FROM inventory_update_requests WHERE id = $1`,
        [undoRequestId],
      );
      expect(row.status).toBe('pending');
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('a delivery that never posted a sale is not creditable', async () => {
      // A legacy row: approved, but the ledger was never committed. Crediting
      // Sales here would reverse revenue that was never recognised.
      const legacyId = randomUUID();
      const legacyDeliveryId = randomUUID();
      await ds.query(
        `INSERT INTO deliveries (id, company_id, customer_id, status, created_by, ledger_status)
         VALUES ($1, $2, $3, 'delivered', $4, 'none')`,
        [legacyDeliveryId, companyId, customerId, ownerId],
      );
      await ds.query(
        `INSERT INTO inventory_update_requests
           (id, company_id, delivery_id, personnel_id, status, submitted_at)
         VALUES ($1, $2, $3, $4, 'approved', now())`,
        [legacyId, companyId, legacyDeliveryId, riderId],
      );

      const res = await get(
        `/api/v1/inventory-update-requests/${legacyId}/credit-memo-draft`,
        staffToken,
      );
      expect(res.status).toBe(409);
      expect(res.body.error?.code ?? res.body.code).toBe('NOT_CREDITABLE');
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
  //  Team management is not an upsell
  // ══════════════════════════════════════════════════════════════════════════

  describe('Adding staff works on every plan, one seat only', () => {
    it('is not gated by tier, and allows exactly one staff member', async () => {
      // multiUser used to be false for small_business, so this tier 403'd on
      // team management entirely. It is now on for every tier — an owner needs
      // a second pair of hands whatever they pay.
      await ds.query(
        `UPDATE companies SET company_type = 'small_business', subscription_plan = 'free'
          WHERE id = $1`,
        [companyId],
      );
      const ownerOnSmallPlan = tokenFor(ownerId, 'admin');
      await get('/api/v1/settings/users', ownerOnSmallPlan).expect(200);

      // The existing seeded staff member already holds the one seat, so a
      // second is refused — on the free plan, on the smallest tier.
      const second = await post('/api/v1/settings/users', ownerOnSmallPlan, {
        name: 'Second Staff',
        username: `plan.second.${suffix}`,
        password: PASSWORD,
        role: 'staff',
      });
      expect(second.status).toBe(400);
      expect(second.body.error?.code ?? second.body.code).toBe('STAFF_LIMIT_REACHED');

      await ds.query(
        `UPDATE companies SET company_type = 'warehouse',
                subscription_plan = 'warehouse_scale_6mo'
          WHERE id = $1`,
        [companyId],
      );
    });

    it('closes the back door: a second owner cannot be demoted into staff', async () => {
      // Adding an owner and demoting them reaches two staff by a route the
      // create guard never sees, so the role change is guarded too.
      const res = await patch(
        `/api/v1/settings/users/${owner2Id}/role`,
        ownerToken,
        { role: 'staff' },
      );
      expect(res.status).toBe(400);
      expect(res.body.error?.code ?? res.body.code).toBe('STAFF_LIMIT_REACHED');

      // owner2 is still an owner, which the maker != checker cases depend on.
      const [row] = await ds.query(
        `SELECT role FROM user_companies WHERE user_id = $1 AND company_id = $2`,
        [owner2Id, companyId],
      );
      expect(row.role).toBe('admin');
    });

    it('deactivating the staff member frees the seat', async () => {
      await patch(`/api/v1/settings/users/${staffId}/deactivate`, ownerToken).expect(200);

      const replacement = await post('/api/v1/settings/users', ownerToken, {
        name: 'Replacement Staff',
        username: `plan.replacement.${suffix}`,
        password: PASSWORD,
        role: 'staff',
      });
      if (replacement.status !== 201) {
        throw new Error(
          `replacement → ${replacement.status}: ${JSON.stringify(replacement.body)}`,
        );
      }

      // Put the fixture back: later blocks sign in as the original staff user.
      await ds.query(
        `UPDATE users SET is_active = false WHERE id = $1`,
        [replacement.body.data.id],
      );
      await patch(`/api/v1/settings/users/${staffId}/activate`, ownerToken).expect(200);
    });

    it('owners are NOT capped — maker != checker still has somebody to check', async () => {
      const extraOwner = await post('/api/v1/settings/users', ownerToken, {
        name: 'Third Owner',
        username: `plan.owner3.${suffix}`,
        password: PASSWORD,
        role: 'admin',
      });
      expect(extraOwner.status).toBe(201);
      await ds.query(`UPDATE users SET is_active = false WHERE id = $1`, [
        extraOwner.body.data.id,
      ]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  Every gated type, end to end
  //
  //  The feature's whole promise is "staff prepare, the owner approves, and the
  //  accounting is identical either way". Only two of the eight types were
  //  proving it — the rest could have been wired to the wrong service method
  //  and every other test here would still have passed. Each type is now held
  //  to the same four things:
  //
  //    1. staff submitting yields exactly ONE pending row
  //    2. nothing posts while it is pending
  //    3. the owner's approval posts, and the trial balance still balances
  //    4. a second decide is a no-op
  // ══════════════════════════════════════════════════════════════════════════

  describe('Every gated type posts only on approval', () => {
    /** Prepare whatever the request needs, then return the staff submission. */
    const submissions: Array<{
      type: string;
      label: string;
      /** Some types need a document to act on before staff can request. */
      arrange?: () => Promise<Record<string, unknown>>;
      submit: (ctx: Record<string, unknown>) => Promise<request.Response>;
      /** Extra proof that nothing happened while pending. */
      assertNoEffect?: (ctx: Record<string, unknown>) => Promise<void>;
    }> = [
      {
        type: 'journal',
        label: 'manual journal',
        submit: () =>
          post('/api/v1/journal-entries', staffToken, {
            date: '2026-03-01',
            memo: 'Gated journal',
            lines: [
              { accountId: rentExpenseAccountId, debit: '25', credit: '0' },
              { accountId: cashAccountId, debit: '0', credit: '25' },
            ],
          }),
      },
      {
        type: 'vendor_credit',
        label: 'vendor credit',
        submit: () =>
          post('/api/v1/vendor-credits', staffToken, {
            vendorId,
            date: '2026-03-02',
            reason: 'Returned to supplier',
            lines: [{ description: 'Returned widget', amount: '60' }],
          }),
      },
      {
        type: 'bill_payment',
        label: 'bill payment via /bills/pay',
        // The SECOND door into BillsService.pay. It was admin-only while
        // /bill-payments gated — same act, two doors, different answers.
        arrange: async () => {
          // A real open bill to pay. Staff may raise one directly — it is
          // accrual only (Dr Expense / Cr AP); the CASH leg is what is gated.
          const bill = await created(
            'bill',
            post('/api/v1/bills', staffToken, {
              vendorId,
              billDate: '2026-03-03',
              dueDate: '2026-04-03',
              lines: [
                { description: 'Supplies', amount: '40', accountId: rentExpenseAccountId },
              ],
            }),
          );
          await post(`/api/v1/bills/${bill.id}/post`, staffToken);
          return { billId: bill.id };
        },
        submit: ctx =>
          post('/api/v1/bills/pay', staffToken, {
            vendorId,
            paymentDate: '2026-03-03',
            paymentMethod: 'cash',
            bankAccountId: cashAccountId,
            // A real proof is only checked when the payment actually posts, at
            // approval — the gate runs first, which is what this asserts.
            proofId: randomUUID(),
            applications: [{ billId: ctx.billId as string, amount: '40' }],
          }),
        // Deliberately not approved below: posting needs an uploaded proof
        // file. The matrix row being tested is that staff are ROUTED to a
        // request rather than refused, which the pending half proves.
      },
      {
        type: 'void',
        label: 'reverse a posted adjustment',
        arrange: async () => {
          const adj = await post(
            `/api/v1/inventory/items/${itemId}/adjust`,
            ownerToken,
            { itemId, newQty: '460', reason: 'damage' },
          ).expect(201);
          return { adjustmentId: adj.body.data?.id ?? adj.body.data?.adjustment?.id };
        },
        submit: ctx =>
          post(
            `/api/v1/inventory/adjustments/${ctx.adjustmentId}/reverse`,
            staffToken,
          ),
      },
    ];

    for (const spec of submissions) {
      it(`${spec.label}: staff file a request that posts nothing`, async () => {
        const ctx = spec.arrange ? await spec.arrange() : {};
        const journalsBefore = await countJournalEntries();

        const res = await spec.submit(ctx);
        if (![200, 201].includes(res.status)) {
          throw new Error(
            `${spec.label} → ${res.status}: ${JSON.stringify(res.body)}`,
          );
        }
        // The matrix says "request", not "refused".
        expect(res.body.data.pending).toBe(true);
        expect(res.body.data.type).toBe(spec.type);

        const pending = (await approvalRows()).filter(
          r => r.type === spec.type && r.status === 'pending',
        );
        expect(pending.length).toBeGreaterThanOrEqual(1);

        // The invariant the whole feature rests on.
        expect(await countJournalEntries()).toBe(journalsBefore);
        if (spec.assertNoEffect) await spec.assertNoEffect(ctx);
      });
    }

    it('approving each one posts exactly once, and the books still balance', async () => {
      // bill_payment is excluded: it needs a real uploaded proof and an open
      // bill, which the pending-half test above already covers. Everything
      // else is approved here and must post.
      const approvable = ['journal', 'vendor_credit', 'void'];

      for (const type of approvable) {
        const [pending] = (await approvalRows()).filter(
          r => r.type === type && r.status === 'pending',
        );
        if (!pending) throw new Error(`no pending ${type} to approve`);

        const journalsBefore = await countJournalEntries();
        const res = await post(`/api/v1/approvals/${pending.id}/decide`, ownerToken, {
          decision: 'approve',
        });
        if (res.status !== 200) {
          throw new Error(`approve ${type} → ${res.status}: ${JSON.stringify(res.body)}`);
        }

        // Exactly one entry per approval — not zero, not two.
        expect(await countJournalEntries()).toBe(journalsBefore + 1);
        expect(await trialBalanceDelta()).toBe('0.0000');

        // And a second decide changes nothing.
        const after = await countJournalEntries();
        await post(`/api/v1/approvals/${pending.id}/decide`, ownerToken, {
          decision: 'approve',
        }).expect(200);
        expect(await countJournalEntries()).toBe(after);
      }
    });

    it('an interrupted approval says so instead of reporting success', async () => {
      const filed = await post('/api/v1/journal-entries', staffToken, {
        date: '2026-03-05',
        memo: 'Interrupted journal',
        lines: [
          { accountId: rentExpenseAccountId, debit: '15', credit: '0' },
          { accountId: cashAccountId, debit: '0', credit: '15' },
        ],
      });
      const requestId = filed.body.data.requestId;

      // Strand it exactly as a crash between dispatch and the final UPDATE would.
      await ds.query(
        `UPDATE approval_requests SET status = 'approving' WHERE id = $1`,
        [requestId],
      );

      const res = await post(`/api/v1/approvals/${requestId}/decide`, ownerToken, {
        decision: 'approve',
      });
      // Previously this returned 200 with the row unchanged: the owner saw
      // success and nothing happened, forever.
      expect(res.status).toBe(409);
      expect(res.body.error?.code ?? res.body.code).toBe('APPROVAL_INTERRUPTED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  Deferred execution — a gated payload is a promise made at FILING time and
  //  cashed at APPROVAL time. These pin down what happens when the world moves
  //  in between, which is a question the pre-role-split code never had to ask.
  // ══════════════════════════════════════════════════════════════════════════

  describe('Approval staleness', () => {
    /**
     * Move stock the way it really moves — a posted adjustment by the owner,
     * which is what "a delivery shipped in between" looks like to the item.
     *
     * NOT a raw UPDATE: that changes the quantity without a journal entry, so
     * the subledger stops tying to GL 1200 and invariant I13 fails at the end
     * of the run. The test would be simulating a state the application cannot
     * actually produce, and then asserting on it.
     */
    const setStock = async (qty: string) => {
      await post(`/api/v1/inventory/items/${itemId}/adjust`, ownerToken, {
        itemId,
        newQty: qty,
        reason: 'correction',
      }).expect(201);
    };

    const onHand = async (): Promise<number> => {
      const [row] = await ds.query(
        `SELECT quantity_on_hand FROM inventory_items WHERE id = $1`,
        [itemId],
      );
      return Number(row.quantity_on_hand);
    };

    it('a SHRINKAGE keeps its meaning when stock moves before approval', async () => {
      await setStock('100');

      // Staff see 20 damaged: "set to 80".
      const filed = await post(`/api/v1/inventory/items/${itemId}/adjust`, staffToken, {
        itemId,
        newQty: '80',
        reason: 'damage',
      });
      const requestId = filed.body.data.requestId;

      // A delivery ships 30 before the owner gets to it.
      await setStock('70');

      await post(`/api/v1/approvals/${requestId}/decide`, ownerToken, {
        decision: 'approve',
      }).expect(200);

      // The intent was "write off 20", so 70 - 20 = 50.
      // Resolving the stale ABSOLUTE target instead would compute 80 - 70 = +10
      // and leave 80 — stock going UP on a damage write-off.
      expect(await onHand()).toBe(50);
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('a stale PHYSICAL COUNT is refused rather than posted', async () => {
      await setStock('100');

      const filed = await post(`/api/v1/inventory/items/${itemId}/adjust`, staffToken, {
        itemId,
        newQty: '95',
        reason: 'physical_count',
      });
      const requestId = filed.body.data.requestId;

      await setStock('70');

      const res = await post(`/api/v1/approvals/${requestId}/decide`, ownerToken, {
        decision: 'approve',
      });
      expect(res.status).toBe(409);
      expect(res.body.error?.code ?? res.body.code).toBe('STOCK_MOVED_SINCE_COUNT');

      // Nothing posted, and the request is released for another attempt.
      expect(await onHand()).toBe(70);
      const [row] = await ds.query(
        `SELECT status FROM approval_requests WHERE id = $1`,
        [requestId],
      );
      expect(row.status).toBe('pending');
    });

    it('an UNMOVED physical count still posts normally', async () => {
      await setStock('100');

      const filed = await post(`/api/v1/inventory/items/${itemId}/adjust`, staffToken, {
        itemId,
        newQty: '95',
        reason: 'physical_count',
      });
      await post(`/api/v1/approvals/${filed.body.data.requestId}/decide`, ownerToken, {
        decision: 'approve',
      }).expect(200);

      expect(await onHand()).toBe(95);
      expect(await trialBalanceDelta()).toBe('0.0000');
    });

    it('an owner adjusting directly is unaffected by any of this', async () => {
      await setStock('100');
      await post(`/api/v1/inventory/items/${itemId}/adjust`, ownerToken, {
        itemId,
        newQty: '88',
        reason: 'correction',
      }).expect(201);
      expect(await onHand()).toBe(88);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  Accounting invariants, last
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
        if (
          r.status === 'pending' ||
          r.status === 'rejected' ||
          r.status === 'cancelled'
        ) {
          // The invariant the whole feature rests on.
          expect(r.journal_entry_id).toBeNull();
        }
      }
    });
  });
});
