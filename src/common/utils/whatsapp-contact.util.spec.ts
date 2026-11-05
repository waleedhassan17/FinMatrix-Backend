import {
  applyWhatsappContactFields,
  WhatsappContactFields,
} from './whatsapp-contact.util';

const blank = (
  over: Partial<WhatsappContactFields> = {},
): WhatsappContactFields => ({
  phone: null,
  whatsappE164: null,
  whatsappOptInAt: null,
  whatsappOptInBy: null,
  whatsappVerifiedAt: null,
  preferredLanguage: null,
  ...over,
});

describe('applyWhatsappContactFields', () => {
  it('derives the WhatsApp number from the phone on create', () => {
    const c = blank({ phone: '0312-4890176' });
    applyWhatsappContactFields(
      c,
      { phone: '0312-4890176' },
      { isCreate: true },
    );
    expect(c.whatsappE164).toBe('+923124890176');
  });

  it('an explicit whatsappPhone wins over the phone', () => {
    const c = blank({ phone: '042 35761234' });
    applyWhatsappContactFields(
      c,
      { whatsappPhone: '0344 1052857' },
      { isCreate: true },
    );
    expect(c.whatsappE164).toBe('+923441052857');
  });

  it('refuses a number that cannot be messaged', () => {
    expect(() =>
      applyWhatsappContactFields(blank(), { whatsappPhone: '12345' }, {}),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'INVALID_WHATSAPP_NUMBER' }),
      }),
    );
  });

  it('re-derives on a phone change and clears verification', () => {
    const c = blank({
      phone: '03001234567',
      whatsappE164: '+923000000000',
      whatsappVerifiedAt: new Date(),
    });
    applyWhatsappContactFields(
      c,
      { phone: '03001234567' },
      { previousPhone: '03000000000' },
    );
    expect(c.whatsappE164).toBe('+923001234567');
    expect(c.whatsappVerifiedAt).toBeNull();
  });

  it('leaves the number alone when the phone did not change', () => {
    const at = new Date();
    const c = blank({
      phone: '0300',
      whatsappE164: '+923001234567',
      whatsappVerifiedAt: at,
    });
    applyWhatsappContactFields(c, { phone: '0300' }, { previousPhone: '0300' });
    expect(c.whatsappE164).toBe('+923001234567');
    expect(c.whatsappVerifiedAt).toBe(at);
  });

  it('empty whatsappPhone clears the number', () => {
    const c = blank({ whatsappE164: '+923001234567' });
    applyWhatsappContactFields(c, { whatsappPhone: '' }, {});
    expect(c.whatsappE164).toBeNull();
  });

  it('stamps consent once, by the current user, and withdraws it', () => {
    const c = blank();
    applyWhatsappContactFields(c, { whatsappOptIn: true }, { userId: 'u1' });
    const first = c.whatsappOptInAt;
    expect(first).toBeInstanceOf(Date);
    expect(c.whatsappOptInBy).toBe('u1');
    applyWhatsappContactFields(c, { whatsappOptIn: true }, { userId: 'u2' });
    expect(c.whatsappOptInBy).toBe('u1');
    applyWhatsappContactFields(c, { whatsappOptIn: false }, { userId: 'u2' });
    expect(c.whatsappOptInAt).toBeNull();
  });

  it('sets the preferred language', () => {
    const c = blank();
    applyWhatsappContactFields(c, { preferredLanguage: 'ur' }, {});
    expect(c.preferredLanguage).toBe('ur');
  });
});
