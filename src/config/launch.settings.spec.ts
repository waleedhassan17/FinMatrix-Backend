import {
  getPlanConfig,
  trialDurationDays,
} from '../modules/billing/plan-config';
import {
  publicLaunchConfig,
  signupMode,
  supportEmail,
  trialAutoApprove,
  trialBlockedEmailDomains,
  trialDays,
  trialReminderDays,
} from './launch.settings';

describe('launch settings', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to trial mode, auto-approve on, 30 days, reminders 7/3/1', () => {
    delete process.env.SIGNUP_MODE;
    delete process.env.TRIAL_AUTO_APPROVE;
    delete process.env.TRIAL_DAYS;
    delete process.env.TRIAL_REMINDER_DAYS;
    expect(signupMode()).toBe('trial');
    expect(trialAutoApprove()).toBe(true);
    expect(trialDays()).toBe(30);
    expect(trialReminderDays()).toEqual([7, 3, 1]);
  });

  it('reads the switches at call time, case-insensitively', () => {
    process.env.SIGNUP_MODE = 'Approval';
    process.env.TRIAL_AUTO_APPROVE = 'FALSE';
    expect(signupMode()).toBe('approval');
    expect(trialAutoApprove()).toBe(false);
  });

  it('the trial plan follows TRIAL_DAYS, including its label', () => {
    process.env.TRIAL_DAYS = '14';
    expect(trialDurationDays()).toBe(14);
    expect(getPlanConfig('warehouse_trial').durationDays).toBe(14);
    expect(getPlanConfig('warehouse_trial').label).toBe('Free trial — 14 days');
  });

  it('ignores an out-of-range TRIAL_DAYS rather than granting it', () => {
    process.env.TRIAL_DAYS = '365';
    expect(trialDays()).toBe(30);
  });

  it('sorts and de-duplicates reminder days, largest first', () => {
    process.env.TRIAL_REMINDER_DAYS = '1, 7,3,7';
    expect(trialReminderDays()).toEqual([7, 3, 1]);
  });

  it('normalises blocked domains', () => {
    process.env.TRIAL_BLOCKED_EMAIL_DOMAINS = ' @Spam.example , other.test ';
    expect(trialBlockedEmailDomains()).toEqual(['spam.example', 'other.test']);
  });

  it('support email falls back to ADMIN_EMAIL', () => {
    delete process.env.SUPPORT_EMAIL;
    process.env.ADMIN_EMAIL = 'admin@example.com';
    expect(supportEmail()).toBe('admin@example.com');
    process.env.SUPPORT_EMAIL = 'help@example.com';
    expect(supportEmail()).toBe('help@example.com');
  });

  it('public config exposes switches and contacts only', () => {
    process.env.JWT_SECRET = 'x'.repeat(40);
    const cfg = publicLaunchConfig();
    expect(Object.keys(cfg).sort()).toEqual(
      [
        'demoBookingEnabled',
        'signupMode',
        'supportEmail',
        'supportWhatsapp',
        'trialAutoApprove',
        'trialDays',
        'turnstileSiteKey',
      ].sort(),
    );
    expect(JSON.stringify(cfg)).not.toContain('x'.repeat(40));
  });
});
