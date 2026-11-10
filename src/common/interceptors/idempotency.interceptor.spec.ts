import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { Repository } from 'typeorm';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyRecord } from './idempotency-record.entity';

describe('IdempotencyInterceptor', () => {
  let repo: {
    findOne: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let interceptor: IdempotencyInterceptor;
  let res: { statusCode: number; status: jest.Mock };

  const ctxFor = (req: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    }) as unknown as ExecutionContext;

  const request = (over: Record<string, unknown> = {}) => ({
    method: 'POST',
    originalUrl: '/api/v1/invoices',
    headers: { 'idempotency-key': 'k1' },
    companyId: 'c1',
    user: { id: 'u1', companyId: 'c1' },
    ...over,
  });

  const handler = (
    body: unknown = { success: true },
  ): CallHandler & { handle: jest.Mock } => ({
    handle: jest.fn(() => of(body)),
  });

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    res = { statusCode: 201, status: jest.fn() };
    interceptor = new IdempotencyInterceptor(
      repo as unknown as Repository<IdempotencyRecord>,
    );
  });

  const run = async (req: Record<string, unknown>, next = handler()) =>
    lastValueFrom(await interceptor.intercept(ctxFor(req), next));

  it('runs the handler and records the response before answering', async () => {
    await expect(run(request())).resolves.toEqual({ success: true });
    expect(repo.update).toHaveBeenCalledWith(
      { companyId: 'c1', idempotencyKey: 'k1' },
      expect.objectContaining({ status: 'completed', statusCode: 201 }),
    );
  });

  it('replays a completed response without running the handler', async () => {
    repo.findOne.mockResolvedValue({
      method: 'POST',
      path: '/api/v1/invoices',
      status: 'completed',
      statusCode: 201,
      responseBody: { success: true, data: { id: 'inv1' } },
    });
    const next = handler();
    await expect(run(request(), next)).resolves.toEqual({
      success: true,
      data: { id: 'inv1' },
    });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('refuses a key reused on a different endpoint', async () => {
    repo.findOne.mockResolvedValue({
      method: 'POST',
      path: '/api/v1/payments',
      status: 'completed',
      statusCode: 201,
      responseBody: {},
    });
    await expect(run(request())).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  it('never takes its scope from the X-Company-Id header', async () => {
    await run(
      request({
        companyId: undefined,
        user: { id: 'u1', companyId: null },
        headers: {
          'idempotency-key': 'k1',
          'x-company-id': 'someone-elses-company',
        },
      }),
    );
    // Scoped to the caller (no company yet), not to the header.
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'u1' }),
    );
  });

  it('passes public (unauthenticated) requests straight through', async () => {
    const next = handler();
    await run(request({ companyId: undefined, user: undefined }), next);
    expect(next.handle).toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('refuses a key longer than the column holds', async () => {
    await expect(
      run(request({ headers: { 'idempotency-key': 'x'.repeat(201) } })),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_INVALID' } });
  });

  it('clears a reservation abandoned by a request that never finished', async () => {
    await run(request());
    expect(repo.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c1',
        idempotencyKey: 'k1',
        status: 'pending',
      }),
    );
  });

  it('still answers when recording the response fails', async () => {
    repo.update.mockRejectedValue(new Error('db down'));
    await expect(run(request())).resolves.toEqual({ success: true });
  });

  it('releases the key when the handler fails', async () => {
    const failing = {
      handle: jest.fn(() => throwError(() => new Error('boom'))),
    };
    await expect(run(request(), failing)).rejects.toThrow('boom');
    expect(repo.delete).toHaveBeenLastCalledWith({
      companyId: 'c1',
      idempotencyKey: 'k1',
    });
  });

  it('ignores requests that are not POST or carry no key', async () => {
    const next = handler();
    await run(request({ method: 'PATCH' }), next);
    await run(request({ headers: {} }), next);
    expect(next.handle).toHaveBeenCalledTimes(2);
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
