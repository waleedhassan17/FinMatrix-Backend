import { ForbiddenException } from '@nestjs/common';
import { assertEmailVerified } from './email-verified.util';

describe('assertEmailVerified', () => {
  it('refuses an unverified owner with EMAIL_NOT_VERIFIED', () => {
    expect(() => assertEmailVerified({ emailVerified: false })).toThrow(ForbiddenException);
    try {
      assertEmailVerified({ emailVerified: false });
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
  });

  it.each([true, undefined])('lets emailVerified=%s through', (emailVerified) => {
    expect(() => assertEmailVerified({ emailVerified })).not.toThrow();
  });

  it('leaves a request with no user to the auth guard', () => {
    expect(() => assertEmailVerified(undefined)).not.toThrow();
  });
});
