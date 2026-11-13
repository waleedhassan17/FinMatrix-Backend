import {
  redactingRequestSerializer,
  redactTokenInQuery,
  redactTokenInUrl,
  REDACTED,
} from './redact-token';

describe('request log redaction of signed download tokens', () => {
  it('replaces the token in a URL and leaves the rest', () => {
    expect(
      redactTokenInUrl(
        '/api/v1/data-portability/exports/abc/download?token=eyJ.sig&x=1',
      ),
    ).toBe(
      `/api/v1/data-portability/exports/abc/download?token=${REDACTED}&x=1`,
    );
    expect(redactTokenInUrl('/api/v1/health')).toBe('/api/v1/health');
    expect(redactTokenInUrl(undefined)).toBeUndefined();
  });

  it('replaces the token in the parsed query', () => {
    expect(redactTokenInQuery({ token: 'abc', page: '2' })).toEqual({
      token: REDACTED,
      page: '2',
    });
    expect(redactTokenInQuery({ page: '2' })).toEqual({ page: '2' });
    expect(redactTokenInQuery(null)).toBeNull();
  });

  it('serializes a request with both redacted and nothing else changed', () => {
    const out = redactingRequestSerializer({
      id: 7,
      method: 'GET',
      url: '/d?token=secret',
      query: { token: 'secret' },
      headers: { host: 'x' },
    });
    expect(out).toEqual({
      id: 7,
      method: 'GET',
      url: `/d?token=${REDACTED}`,
      query: { token: REDACTED },
      headers: { host: 'x' },
    });
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});
