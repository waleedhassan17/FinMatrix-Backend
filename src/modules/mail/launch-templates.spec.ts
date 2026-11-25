import { launchEmailTemplates as t } from './launch-templates';

const evil = '<a href="https://phish.example">Click</a>';
const end = new Date('2026-12-26T06:00:00Z');

/** Customer-facing emails — each must carry an Urdu section. */
const customer = () => [
  t.trialRequested(evil, evil),
  t.trialApproved(evil, evil, end, {
    app: 'https://app.example.com',
    migrationGuide: 'https://app.example.com/settings/migration/guide',
  }),
  t.trialRejected(evil, evil, evil),
  t.trialEnding(evil, evil, 3, 'https://app.example.com'),
  t.trialEnded(evil, evil, 'https://app.example.com'),
  t.trialEndedEarly(evil, evil, evil),
  t.trialExtended(evil, evil, end, 7),
  t.activationRequested(evil, evil),
  t.planActivated(evil, evil, evil, end, 'https://app.example.com'),
  t.activationRejected(evil, evil, evil),
];

/** Internal, to the platform admin — English only is fine. */
const admin = () => [
  t.trialRequestedAdmin(evil, evil, '+923001234567', evil),
  t.trialAutoApprovedAdmin(evil, evil, null, end),
  t.activationRequestedAdmin(evil, evil, evil, evil),
];

describe('launch email templates', () => {
  it('every template is a complete HTML document with a title and text', () => {
    for (const email of [...customer(), ...admin()]) {
      expect(email.html).toMatch(/^<!doctype html>\s*<html lang="en">/);
      expect(email.html).toContain('<meta charset="utf-8" />');
      expect(email.html).toMatch(/<title>[^<]+<\/title>/);
      expect(email.text.length).toBeGreaterThan(0);
      expect(email.subject).not.toMatch(/[\r\n]/);
    }
  });

  it('every customer email is bilingual: an RTL Urdu section', () => {
    for (const email of customer()) {
      expect(email.html).toContain('dir="rtl" lang="ur"');
      expect(email.html).toMatch(/[؀-ۿ]/);
    }
  });

  it('escapes everything a person typed', () => {
    for (const email of [...customer(), ...admin()]) {
      expect(email.html).not.toContain('<a href="https://phish.example">');
    }
  });

  it('never promises online payment and says data is kept', () => {
    const ended = t.trialEnded('A', 'Acme');
    expect(ended.html).toMatch(/data is safe/i);
    expect(ended.html).not.toMatch(/bank transfer|pay online|card/i);
    const approved = t.trialApproved('A', 'Acme', end, {
      migrationGuide: 'https://app.example.com/settings/migration/guide',
    });
    expect(approved.html).toContain(
      'https://app.example.com/settings/migration/guide',
    );
    expect(approved.html).toMatch(/no online payment/i);
  });

  it('shows dates in Asia/Karachi', () => {
    // 2026-12-25T21:30Z is already 26 December in Karachi (UTC+5).
    const email = t.trialApproved(
      'A',
      'Acme',
      new Date('2026-12-25T21:30:00Z'),
    );
    expect(email.html).toContain('26 December 2026');
  });
});
