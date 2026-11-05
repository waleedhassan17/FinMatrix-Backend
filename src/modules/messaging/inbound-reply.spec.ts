import { inboundReply } from './inbound-reply';

describe('inboundReply (what a contact gets when they write to the FinMatrix number)', () => {
  it('names the company and gives its phone and email', () => {
    const r = inboundReply({
      companyName: 'Warehouse Co',
      companyPhone: '0300-1234567',
      companyEmail: 'sales@warehouse.pk',
      language: 'en',
    });
    expect(r?.text).toBe(
      "This is FinMatrix's automatic number for Warehouse Co; messages sent here are not read. " +
        'To reach Warehouse Co, call or WhatsApp 0300-1234567, or email sales@warehouse.pk. ' +
        'Reply STOP to stop these messages.',
    );
  });

  it('uses whichever contact detail the company has', () => {
    expect(
      inboundReply({ companyName: 'A', companyPhone: '0300', language: 'en' })
        ?.text,
    ).toContain('To reach A, call or WhatsApp 0300.');
    expect(
      inboundReply({ companyName: 'A', companyEmail: 'a@b.pk', language: 'en' })
        ?.text,
    ).toContain('To reach A, email a@b.pk.');
    expect(
      inboundReply({
        companyName: 'A',
        companyPhone: ' ',
        companyEmail: null,
        language: 'en',
      })?.text,
    ).toContain('please use the contact details on the document they sent you');
  });

  it('answers in Urdu for an Urdu contact, still naming the company and STOP', () => {
    const r = inboundReply({
      companyName: 'Warehouse Co',
      companyPhone: '0300-1234567',
      language: 'ur',
    });
    expect(r?.text).toContain('Warehouse Co');
    expect(r?.text).toContain('0300-1234567');
    expect(r?.text).toContain('STOP');
  });

  it('says nothing when there is no company name', () => {
    expect(inboundReply({ companyName: '  ', language: 'en' })).toBeNull();
  });
});
