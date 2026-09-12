import { escapeLike, likeContains } from './like.util';

describe('like.util', () => {
  it('wraps a plain term for a contains match', () => {
    expect(likeContains('acme')).toBe('%acme%');
  });

  it('trims surrounding whitespace', () => {
    expect(likeContains('  INV-2026 ')).toBe('%INV-2026%');
  });

  it('escapes the LIKE wildcards so they match literally', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('INV_1')).toBe('INV\\_1');
    expect(likeContains('%')).toBe('%\\%%');
  });

  it('escapes the escape character first', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });
});
