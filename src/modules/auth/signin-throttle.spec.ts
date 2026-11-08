import type { ExecutionContext } from '@nestjs/common';
import {
  AccountThrottle,
  accountSigninLimit,
  accountSigninTtlMs,
  accountTracker,
  ipSigninLimit,
  skipUnlessAccountThrottled,
} from './signin-throttle';

describe('accountTracker', () => {
  // One allowance per account however it is typed, matching how the user
  // lookup normalises it — otherwise "Manager" and "manager" are two budgets.
  it('normalises the identifier the way the user lookup does', () => {
    expect(
      accountTracker({ body: { identifier: '  Manager ' }, ip: '1.1.1.1' }),
    ).toBe('account:manager');
  });

  it('counts the same account from different addresses together', () => {
    const a = accountTracker({
      body: { identifier: 'acme.imran' },
      ip: '1.1.1.1',
    });
    const b = accountTracker({
      body: { identifier: 'acme.imran' },
      ip: '2.2.2.2',
    });
    expect(a).toBe(b);
  });

  it('reads the legacy email field that installed builds post', () => {
    expect(
      accountTracker({ body: { email: 'Owner@X.z' }, ip: '1.1.1.1' }),
    ).toBe('account:owner@x.z');
  });

  it('prefers identifier over email when both are sent', () => {
    expect(
      accountTracker({
        body: { identifier: 'a.user', email: 'a.user' },
        ip: '1.1.1.1',
      }),
    ).toBe('account:a.user');
  });

  // Guards run before validation, so the body can be anything.
  it.each([
    [{}],
    [{ identifier: '' }],
    [{ identifier: '   ' }],
    [{ identifier: 42 }],
    [{ identifier: { $ne: null } }],
  ])(
    'falls back to the IP for a body without a usable identifier: %p',
    (body) => {
      expect(accountTracker({ body, ip: '9.9.9.9' })).toBe('ip:9.9.9.9');
    },
  );

  it('caps a huge identifier', () => {
    const key = accountTracker({
      body: { identifier: 'x'.repeat(10_000) },
      ip: '1.1.1.1',
    });
    expect(key.length).toBeLessThanOrEqual('account:'.length + 255);
  });
});

describe('skipUnlessAccountThrottled', () => {
  const contextFor = (handler: () => void) =>
    ({ getHandler: () => handler }) as unknown as ExecutionContext;

  class Routes {
    @AccountThrottle()
    signin() {}

    other() {}
  }

  it('runs on a handler marked @AccountThrottle()', () => {
    expect(
      skipUnlessAccountThrottled(contextFor(Routes.prototype.signin)),
    ).toBe(false);
  });

  it('is skipped everywhere else', () => {
    expect(skipUnlessAccountThrottled(contextFor(Routes.prototype.other))).toBe(
      true,
    );
  });
});

describe('sign-in limits', () => {
  const KEYS = [
    'SIGNIN_ACCOUNT_LIMIT',
    'SIGNIN_ACCOUNT_TTL_SECONDS',
    'SIGNIN_IP_LIMIT',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() =>
    KEYS.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])),
  );
  afterEach(() =>
    KEYS.forEach((k) =>
      saved[k] === undefined
        ? delete process.env[k]
        : (process.env[k] = saved[k]),
    ),
  );

  it('defaults to 10 per account per 15 minutes, and 30 per IP per minute', () => {
    expect(accountSigninLimit()).toBe(10);
    expect(accountSigninTtlMs()).toBe(900_000);
    expect(ipSigninLimit()).toBe(30);
  });

  // CI sets these high: the suites sign in as one account dozens of times.
  it('reads overrides from the environment at call time', () => {
    process.env.SIGNIN_ACCOUNT_LIMIT = '100000';
    process.env.SIGNIN_ACCOUNT_TTL_SECONDS = '60';
    process.env.SIGNIN_IP_LIMIT = '500';
    expect(accountSigninLimit()).toBe(100000);
    expect(accountSigninTtlMs()).toBe(60_000);
    expect(ipSigninLimit()).toBe(500);
  });

  it.each(['', '0', '-5', 'lots'])('ignores an unusable value: %p', (v) => {
    process.env.SIGNIN_ACCOUNT_LIMIT = v;
    expect(accountSigninLimit()).toBe(10);
  });
});
