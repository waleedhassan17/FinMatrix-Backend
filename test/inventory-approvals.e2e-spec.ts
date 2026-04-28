import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ResponseEnvelopeInterceptor } from '../src/common/interceptors/response-envelope.interceptor';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';

/**
 * E2E tests for the Bill Photo Capture & Inventory Approval flow.
 *
 * These tests exercise the happy path and key guard-rails:
 *  1. Submit bill photo (DP) → creates pending request
 *  2. List requests (admin)
 *  3. Get single request
 *  4. Approve request → mutates inventory
 *  5. Reject request → no inventory mutation
 *  6. Duplicate submission guard (409)
 *  7. Negative stock guard (422)
 *
 * NOTE: Requires a running PostgreSQL instance. Use `docker compose up -d postgres`
 * before running.  The tests create their own data and clean up afterwards.
 */
describe('Inventory Approvals — Bill Photo Flow (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let dpToken: string;
  let adminToken: string;

  // Seed IDs
  const companyId = randomUUID();
  const dpUserId = randomUUID();
  const adminUserId = randomUUID();
  const deliveryId = randomUUID();
  const itemId = randomUUID();
  const customerId = randomUUID();

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
    await seedTestData();
    await obtainTokens();
  });

  afterAll(async () => {
    await cleanupTestData();
    await app.close();
  });

  // ===========================================================================
  //  Seed helpers
  // ===========================================================================

  async function seedTestData() {
    const passwordHash = await bcrypt.hash('Test1234!', 10);

    // Company (created_by is NOT NULL, must be provided)
    await ds.query(
      `INSERT INTO companies (id, name, invite_code, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [companyId, 'Test Co', 'TESTCODE', adminUserId],
    );

    // Users
    await ds.query(
      `INSERT INTO users (id, email, password_hash, display_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT DO NOTHING`,
      [dpUserId, `dp-test-${dpUserId.slice(0, 8)}@test.com`, passwordHash, 'DP Tester', 'delivery'],
    );
    await ds.query(
      `INSERT INTO users (id, email, password_hash, display_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT DO NOTHING`,
      [adminUserId, `admin-test-${adminUserId.slice(0, 8)}@test.com`, passwordHash, 'Admin Tester', 'admin'],
    );

    // UserCompany links
    await ds.query(
      `INSERT INTO user_companies (user_id, company_id, role)
       VALUES ($1, $2, 'delivery')
       ON CONFLICT DO NOTHING`,
      [dpUserId, companyId],
    );
    await ds.query(
      `INSERT INTO user_companies (user_id, company_id, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT DO NOTHING`,
      [adminUserId, companyId],
    );

    // Customer placeholder (deliveries FK)
    await ds.query(
      `INSERT INTO customers (id, company_id, name, email, phone)
       VALUES ($1, $2, 'Test Customer', 'cust@test.com', '0000')
       ON CONFLICT DO NOTHING`,
      [customerId, companyId],
    );

    // Delivery in "arrived" status assigned to the DP
    await ds.query(
      `INSERT INTO deliveries (id, company_id, customer_id, personnel_id, status, created_by)
       VALUES ($1, $2, $3, $4, 'arrived', $5)
       ON CONFLICT DO NOTHING`,
      [deliveryId, companyId, customerId, dpUserId, adminUserId],
    );

    // Inventory item with 500 on hand
    await ds.query(
      `INSERT INTO inventory_items (id, company_id, sku, name, quantity_on_hand, is_active)
       VALUES ($1, $2, $3, 'AquaPure 500ml', 500, true)
       ON CONFLICT DO NOTHING`,
      [itemId, companyId, `AQUA-${itemId.slice(0, 6)}`],
    );
  }

  async function obtainTokens() {
    // Sign in as DP
    const dpRes = await request(app.getHttpServer())
      .post('/api/v1/auth/signin')
      .send({ email: `dp-test-${dpUserId.slice(0, 8)}@test.com`, password: 'Test1234!' });
    dpToken = dpRes.body?.data?.accessToken ?? '';

    // Sign in as admin
    const adminRes = await request(app.getHttpServer())
      .post('/api/v1/auth/signin')
      .send({ email: `admin-test-${adminUserId.slice(0, 8)}@test.com`, password: 'Test1234!' });
    adminToken = adminRes.body?.data?.accessToken ?? '';
  }

  async function cleanupTestData() {
    // Reverse order to respect FKs
    try {
      await ds.query(`DELETE FROM notifications WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM inventory_approval_audit_entries WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM inventory_movements WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM inventory_update_request_lines WHERE request_id IN (SELECT id FROM inventory_update_requests WHERE company_id = $1)`, [companyId]);
      await ds.query(`DELETE FROM inventory_update_requests WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM deliveries WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM inventory_items WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM customers WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM user_companies WHERE company_id = $1`, [companyId]);
      await ds.query(`DELETE FROM users WHERE id IN ($1, $2)`, [dpUserId, adminUserId]);
      await ds.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
    } catch {
      // Best-effort cleanup; don't fail teardown
    }
  }

  // ===========================================================================
  //  Tests
  // ===========================================================================

  let requestId: string;

  describe('POST /api/v1/deliveries/:deliveryId/bill-photo', () => {
    it('should reject when photo file is missing (400)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/deliveries/${deliveryId}/bill-photo`)
        .set('Authorization', `Bearer ${dpToken}`)
        .set('x-company-id', companyId)
        .field('signedBy', 'Muhammad Arif')
        .field('source', 'camera')
        .field('changes', JSON.stringify([
          { itemId, itemName: 'AquaPure 500ml', beforeQty: 500, deliveredQty: 48, returnedQty: 2 },
        ]))
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should submit bill photo successfully (201/200)', async () => {
      // Create a minimal JPEG buffer (not a valid image, but passes mimetype check)
      const fakeJpeg = Buffer.alloc(1024, 0xff);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/deliveries/${deliveryId}/bill-photo`)
        .set('Authorization', `Bearer ${dpToken}`)
        .set('x-company-id', companyId)
        .attach('photo', fakeJpeg, { filename: 'bill.jpg', contentType: 'image/jpeg' })
        .field('signedBy', 'Muhammad Arif')
        .field('source', 'camera')
        .field('changes', JSON.stringify([
          { itemId, itemName: 'AquaPure 500ml', beforeQty: 500, deliveredQty: 48, returnedQty: 2 },
        ]));

      // Accept 200 or 201 — the response envelope interceptor wraps it
      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);
      expect(res.body.data.requestId).toBeDefined();
      expect(res.body.data.deliveryId).toBe(deliveryId);
      expect(res.body.data.photoUrl).toBeDefined();
      requestId = res.body.data.requestId;
    });

    it('should reject duplicate submission (409)', async () => {
      const fakeJpeg = Buffer.alloc(1024, 0xff);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/deliveries/${deliveryId}/bill-photo`)
        .set('Authorization', `Bearer ${dpToken}`)
        .set('x-company-id', companyId)
        .attach('photo', fakeJpeg, { filename: 'bill.jpg', contentType: 'image/jpeg' })
        .field('signedBy', 'Muhammad Arif')
        .field('source', 'camera')
        .field('changes', JSON.stringify([
          { itemId, itemName: 'AquaPure 500ml', beforeQty: 500, deliveredQty: 48, returnedQty: 2 },
        ]))
        .expect(409);

      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/v1/inventory-update-requests', () => {
    it('should list pending requests for admin', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/inventory-update-requests?status=pending')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('x-company-id', companyId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toBeDefined();
      expect(res.body.data.total).toBeGreaterThanOrEqual(1);

      const item = res.body.data.items.find((i: any) => i.id === requestId);
      expect(item).toBeDefined();
      expect(item.status).toBe('pending');
      expect(item.changes).toHaveLength(1);
      expect(item.proof.verificationMethod).toBe('bill_photo');
    });
  });

  describe('GET /api/v1/inventory-update-requests/:id', () => {
    it('should return the single request for admin', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/inventory-update-requests/${requestId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('x-company-id', companyId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(requestId);
      expect(res.body.data.deliveryId).toBe(deliveryId);
    });

    it('should return the single request for owning DP', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/inventory-update-requests/${requestId}`)
        .set('Authorization', `Bearer ${dpToken}`)
        .set('x-company-id', companyId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(requestId);
    });
  });

  describe('POST /api/v1/inventory-update-requests/:id/approve', () => {
    it('should approve and update real inventory', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/inventory-update-requests/${requestId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('x-company-id', companyId)
        .send({ reviewerComment: 'Looks good, approved.' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.shadowStatus).toBe('synced');

      // Verify inventory was mutated: 500 - 48 + 2 = 454
      const itemRow = await ds.query(
        `SELECT quantity_on_hand FROM inventory_items WHERE id = $1`,
        [itemId],
      );
      expect(Number(itemRow[0].quantity_on_hand)).toBe(454);
    });

    it('should reject re-approval (409)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/inventory-update-requests/${requestId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('x-company-id', companyId)
        .send({})
        .expect(409);
    });
  });

  describe('Reject flow — separate request', () => {
    let secondDeliveryId: string;
    let secondRequestId: string;

    beforeAll(async () => {
      // Create a second delivery + request to test rejection
      secondDeliveryId = randomUUID();
      await ds.query(
        `INSERT INTO deliveries (id, company_id, customer_id, personnel_id, status, created_by)
         VALUES ($1, $2, $3, $4, 'arrived', $5)`,
        [secondDeliveryId, companyId, customerId, dpUserId, adminUserId],
      );

      // Submit bill photo for the second delivery
      const fakeJpeg = Buffer.alloc(512, 0xff);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/deliveries/${secondDeliveryId}/bill-photo`)
        .set('Authorization', `Bearer ${dpToken}`)
        .set('x-company-id', companyId)
        .attach('photo', fakeJpeg, { filename: 'bill2.jpg', contentType: 'image/jpeg' })
        .field('signedBy', 'Customer B')
        .field('source', 'gallery')
        .field('changes', JSON.stringify([
          { itemId, itemName: 'AquaPure 500ml', beforeQty: 454, deliveredQty: 10, returnedQty: 0 },
        ]));

      secondRequestId = res.body?.data?.requestId;
    });

    it('should reject the request without mutating inventory', async () => {
      // Capture qty before
      const beforeRow = await ds.query(
        `SELECT quantity_on_hand FROM inventory_items WHERE id = $1`,
        [itemId],
      );
      const qtyBefore = Number(beforeRow[0].quantity_on_hand);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/inventory-update-requests/${secondRequestId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('x-company-id', companyId)
        .send({ reviewerComment: 'Photo is blurry, please re-submit.' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('rejected');
      expect(res.body.data.shadowStatus).toBe('rejected');

      // Inventory unchanged
      const afterRow = await ds.query(
        `SELECT quantity_on_hand FROM inventory_items WHERE id = $1`,
        [itemId],
      );
      expect(Number(afterRow[0].quantity_on_hand)).toBe(qtyBefore);
    });

    afterAll(async () => {
      await ds.query(`DELETE FROM deliveries WHERE id = $1`, [secondDeliveryId]).catch(() => {});
    });
  });

  describe('Negative stock guard', () => {
    let bigDeliveryId: string;
    let bigRequestId: string;

    beforeAll(async () => {
      bigDeliveryId = randomUUID();
      await ds.query(
        `INSERT INTO deliveries (id, company_id, customer_id, personnel_id, status, created_by)
         VALUES ($1, $2, $3, $4, 'arrived', $5)`,
        [bigDeliveryId, companyId, customerId, dpUserId, adminUserId],
      );

      const fakeJpeg = Buffer.alloc(512, 0xff);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/deliveries/${bigDeliveryId}/bill-photo`)
        .set('Authorization', `Bearer ${dpToken}`)
        .set('x-company-id', companyId)
        .attach('photo', fakeJpeg, { filename: 'bill3.jpg', contentType: 'image/jpeg' })
        .field('signedBy', 'Customer C')
        .field('source', 'camera')
        .field('changes', JSON.stringify([
          { itemId, itemName: 'AquaPure 500ml', beforeQty: 454, deliveredQty: 9999, returnedQty: 0 },
        ]));

      bigRequestId = res.body?.data?.requestId;
    });

    it('should reject approval with 422 when stock would go negative', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/inventory-update-requests/${bigRequestId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('x-company-id', companyId)
        .send({})
        .expect(422);

      expect(res.body.success).toBe(false);
    });

    afterAll(async () => {
      await ds.query(`DELETE FROM deliveries WHERE id = $1`, [bigDeliveryId]).catch(() => {});
    });
  });
});
