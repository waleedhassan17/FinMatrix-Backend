import { ArgumentsHost, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

import { AllExceptionsFilter } from './all-exceptions.filter';

/** Runs the filter on one exception and returns the status and envelope sent. */
function send(exception: unknown) {
  let status = 0;
  let body: { success: boolean; error: { code: string; message: string; details?: unknown } } | undefined;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(b: typeof body) {
      body = b;
      return this;
    },
  };
  const req = { method: 'POST', url: '/api/v1/public/demo-requests', path: '/api/v1/public/demo-requests', headers: {} };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status, body: body! };
}

describe('AllExceptionsFilter', () => {
  it('a throttled request is RATE_LIMIT with a sentence a person can read — not INTERNAL_ERROR', () => {
    const { status, body } = send(new ThrottlerException());
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body.error.code).toBe('RATE_LIMIT');
    expect(body.error.message).toBe('Too many attempts. Please wait a few minutes and try again.');
  });

  it('a string-bodied HttpException gets the code for its status', () => {
    expect(send(new HttpException('Nope', HttpStatus.FORBIDDEN)).body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Nope',
    });
  });

  it('keeps a thrown code, message and details as they are', () => {
    const { body } = send(
      new HttpException(
        { code: 'EXPORT_RATE_LIMITED', message: 'Up to 3 an hour.', details: { limit: 3 } },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
    expect(body.error).toEqual({ code: 'EXPORT_RATE_LIMITED', message: 'Up to 3 an hour.', details: { limit: 3 } });
  });

  it('a validation failure lists its fields', () => {
    const { body } = send(new BadRequestException(['email must be an email']));
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toEqual({ fields: ['email must be an email'] });
  });

  it('never leaks an internal error text', () => {
    const { status, body } = send(new Error('relation "secret_table" does not exist'));
    expect(status).toBe(500);
    expect(body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  });
});
