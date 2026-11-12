import { ConfigService } from '@nestjs/config';
import { ExportTokenSigner } from './export-token';

const config = (vars: Record<string, string>) =>
  ({
    get: (k: string, d?: string) => vars[k] ?? d,
  }) as unknown as ConfigService;

const EXPORT_ID = '11111111-2222-4333-8444-555555555555';
const COMPANY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const JWT = 'x'.repeat(40);

describe('ExportTokenSigner', () => {
  const now = Date.UTC(2026, 10, 12, 10, 0, 0);
  const inOneDay = Math.floor(now / 1000) + 86_400;
  const signer = new ExportTokenSigner(config({ JWT_SECRET: JWT }));

  it('round-trips the export, company and expiry', () => {
    const token = signer.sign({
      exportId: EXPORT_ID,
      companyId: COMPANY_ID,
      exp: inOneDay,
    });
    expect(signer.verify(token, now)).toEqual({
      exportId: EXPORT_ID,
      companyId: COMPANY_ID,
      exp: inOneDay,
    });
  });

  it('refuses an expired token, exactly at expiry too', () => {
    const token = signer.sign({
      exportId: EXPORT_ID,
      companyId: COMPANY_ID,
      exp: inOneDay,
    });
    expect(signer.verify(token, inOneDay * 1000)).toBeNull();
    expect(signer.verify(token, inOneDay * 1000 + 1)).toBeNull();
  });

  it('refuses a token whose payload or signature was altered', () => {
    const token = signer.sign({
      exportId: EXPORT_ID,
      companyId: COMPANY_ID,
      exp: inOneDay,
    });
    const [payload, sig] = token.split('.');
    const other = Buffer.from(
      `${EXPORT_ID}:${COMPANY_ID.replace('a', 'b')}:${inOneDay}`,
    ).toString('base64url');
    expect(signer.verify(`${other}.${sig}`, now)).toBeNull();
    expect(signer.verify(`${payload}.${sig.slice(0, -2)}AA`, now)).toBeNull();
    expect(signer.verify(payload, now)).toBeNull();
    expect(signer.verify('', now)).toBeNull();
    expect(signer.verify(undefined, now)).toBeNull();
  });

  it('is bound to the key: another server cannot mint a link', () => {
    const token = signer.sign({
      exportId: EXPORT_ID,
      companyId: COMPANY_ID,
      exp: inOneDay,
    });
    const other = new ExportTokenSigner(config({ JWT_SECRET: 'y'.repeat(40) }));
    expect(other.verify(token, now)).toBeNull();
    const dedicated = new ExportTokenSigner(
      config({ JWT_SECRET: JWT, EXPORT_TOKEN_SECRET: 'z'.repeat(40) }),
    );
    expect(dedicated.verify(token, now)).toBeNull();
    expect(
      dedicated.verify(
        dedicated.sign({
          exportId: EXPORT_ID,
          companyId: COMPANY_ID,
          exp: inOneDay,
        }),
        now,
      ),
    ).not.toBeNull();
  });

  it('tells an expired link from a forged one', () => {
    const token = signer.sign({
      exportId: EXPORT_ID,
      companyId: COMPANY_ID,
      exp: inOneDay,
    });
    expect(signer.inspect(token, now).reason).toBe('ok');
    expect(signer.inspect(token, inOneDay * 1000 + 1).reason).toBe('expired');
    expect(signer.inspect(`${token}x`, now).reason).toBe('invalid');
    expect(signer.inspect(undefined, now).reason).toBe('invalid');
  });

  it('refuses an expiry further out than any link the server issues', () => {
    const token = signer.sign({
      exportId: EXPORT_ID,
      companyId: COMPANY_ID,
      exp: Math.floor(now / 1000) + 30 * 86_400,
    });
    expect(signer.verify(token, now)).toBeNull();
  });
});
