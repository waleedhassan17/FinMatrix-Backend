import { chunked } from './migration-rollback.service';

describe('chunked', () => {
  it('splits id lists well under the 65,535 bind-parameter limit', () => {
    const ids = Array.from({ length: 70_001 }, (_, i) => `id-${i}`);
    const parts = chunked(ids);
    expect(parts.map((p) => p.length)).toEqual([...Array(14).fill(5000), 1]);
    expect(parts.flat()).toEqual(ids);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThan(65_535);
    expect(chunked([])).toEqual([]);
  });
});
