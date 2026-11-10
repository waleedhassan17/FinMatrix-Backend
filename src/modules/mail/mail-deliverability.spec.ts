import {
  deliverabilityWarnings,
  emailDomain,
  senderDnsWarnings,
} from './mail-deliverability';

describe('emailDomain', () => {
  it.each([
    ['FinMatrix <no-reply@finmatrix.pk>', 'finmatrix.pk'],
    ['no-reply@Mail.Example.com', 'mail.example.com'],
    ['FinMatrix', null],
    ['', null],
  ])('%s -> %s', (address, domain) => {
    expect(emailDomain(address)).toBe(domain);
  });
});

describe('deliverabilityWarnings', () => {
  it('is silent for a domain sender whose links stay on that domain (e.g. SES)', () => {
    expect(
      deliverabilityWarnings({
        from: 'FinMatrix <no-reply@finmatrix.pk>',
        smtpUser: 'AKIAEXAMPLEKEY',
        webAppUrl: 'https://app.finmatrix.pk',
      }),
    ).toEqual([]);
  });

  it('flags the setup that sends verification mail to spam: Gmail sender, vercel.app links', () => {
    const warnings = deliverabilityWarnings({
      from: 'FinMatrix <someone@gmail.com>',
      smtpUser: 'someone@gmail.com',
      webAppUrl: 'https://finmatrix-theta.vercel.app',
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/personal mailbox \(@gmail\.com\)/);
    expect(warnings[1]).toMatch(
      /finmatrix-theta\.vercel\.app, a shared vercel\.app address/,
    );
  });

  it('flags a From domain the SMTP account is not on', () => {
    const [warning] = deliverabilityWarnings({
      from: 'FinMatrix <no-reply@finmatrix.pk>',
      smtpUser: 'mailer@otherhost.com',
      webAppUrl: 'https://app.finmatrix.pk',
    });
    expect(warning).toMatch(
      /SMTP_FROM is on finmatrix\.pk but the SMTP account is on otherhost\.com/,
    );
  });

  it('flags links that leave the sender’s domain', () => {
    const [warning] = deliverabilityWarnings({
      from: 'FinMatrix <no-reply@finmatrix.pk>',
      smtpUser: 'AKIAEXAMPLEKEY',
      webAppUrl: 'https://finmatrix-app.com',
    });
    expect(warning).toMatch(/different domain from the sender/);
  });

  it('flags a From with no address in it', () => {
    const [warning] = deliverabilityWarnings({
      from: 'FinMatrix',
      smtpUser: '',
      webAppUrl: 'https://app.finmatrix.pk',
    });
    expect(warning).toMatch(/has no email address/);
  });
});

describe('senderDnsWarnings', () => {
  const notFound = () =>
    Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  const resolver =
    (records: Record<string, string[][]>) =>
    async (name: string): Promise<string[][]> => {
      if (name in records) return records[name];
      throw notFound();
    };

  it('is silent when SPF and DMARC are published', async () => {
    const resolve = resolver({
      'finmatrix.pk': [['v=spf1 include:amazonses.com ~all']],
      '_dmarc.finmatrix.pk': [['v=DMARC1; p=quarantine']],
    });
    await expect(senderDnsWarnings('finmatrix.pk', resolve)).resolves.toEqual(
      [],
    );
  });

  it('reports a domain that does not exist at all', async () => {
    const warnings = await senderDnsWarnings('finmatrix.pk', resolver({}));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/has no DNS records/);
  });

  it('reports missing SPF and DMARC separately', async () => {
    const warnings = await senderDnsWarnings(
      'example.com',
      resolver({ 'example.com': [['google-site-verification=abc']] }),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/no SPF record/);
    expect(warnings[1]).toMatch(/no DMARC record/);
  });

  it('joins TXT records split into chunks', async () => {
    const resolve = resolver({
      'example.com': [['v=spf1 include:', 'amazonses.com ~all']],
      '_dmarc.example.com': [['v=DMARC1; ', 'p=none']],
    });
    await expect(senderDnsWarnings('example.com', resolve)).resolves.toEqual(
      [],
    );
  });

  it('skips personal mailbox domains and unknown senders', async () => {
    const resolve = jest.fn();
    await expect(senderDnsWarnings('gmail.com', resolve)).resolves.toEqual([]);
    await expect(senderDnsWarnings(null, resolve)).resolves.toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('says nothing when DNS is slow or failing: that is not a configuration problem', async () => {
    const hang = () => new Promise<string[][]>(() => undefined);
    await expect(senderDnsWarnings('example.com', hang, 20)).resolves.toEqual(
      [],
    );
    const servfail = async () => {
      throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' });
    };
    await expect(senderDnsWarnings('example.com', servfail)).resolves.toEqual(
      [],
    );
  });
});
