import { pagedResponse } from './paged-response.util';

describe('pagedResponse — a page that reaches the client whole', () => {
  it('carries success, so the envelope passes the pagination and summary through', () => {
    const r = pagedResponse(
      [{ id: 'a' }],
      { page: 2, limit: 50, total: 120 },
      { count: 120 },
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual([{ id: 'a' }]);
    expect(r.pagination).toEqual({
      page: 2,
      limit: 50,
      total: 120,
      totalPages: 3,
    });
    expect(r.summary).toEqual({ count: 120 });
  });

  it('keeps the older flat keys for anything that read them', () => {
    const r = pagedResponse([], { page: 1, limit: 20, total: 0 });
    expect(r).toMatchObject({ total: 0, page: 1, limit: 20 });
    expect(r.pagination.totalPages).toBe(1);
    expect(r).not.toHaveProperty('summary');
  });
});
