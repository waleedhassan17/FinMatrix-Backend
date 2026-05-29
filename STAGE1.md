# FinMatrix — Stage 1 (Authentication + Company Onboarding)

This document covers everything added in Stage 1: email-verification, OTP
password reset, the company onboarding/approval state machine, the SMTP mailer,
and how to run/test it all.

## Role mapping

| Spec role        | Backend role  | Who                                            |
| ---------------- | ------------- | ---------------------------------------------- |
| `PLATFORM_ADMIN` | `super_admin` | Reviews & approves/rejects company registrations |
| `COMPANY_ADMIN`  | `admin`       | Registers a company; gated until verified + approved |

## Company status state machine

`unverified → email_verified → pending_approval → approved | rejected`

Legacy rows created before Stage 1 use `active`, which is treated as `approved`
everywhere the login gate is evaluated (see `isCompanyApproved` in `src/types`).

- `email_verified` – company created as an onboarding **draft**
- `pending_approval` – onboarding submitted (`POST /companies/:id/submit`)
- `approved` / `rejected` – set by the platform admin

## What was added

- `users.is_email_verified`, `users.email_verified_at`
- `companies`: `legal_structure`, `website`, `fiscal_year_start_month`,
  `accounting_method`, `home_currency`, `submitted_at`
- `email_verifications` table (single-use, hashed, time-limited tokens)
- `password_reset_otps` table (hashed 6-digit OTP, attempt limiting, reset token)
- `src/modules/mail` – SMTP mailer with a console/dev fallback + templates
- Auth endpoints (below)
- `POST /companies/:id/submit` – submit onboarding for approval
- Platform-admin approve/reject now emails the company owner

## Auth endpoints

| Method | Path                         | Notes                                            |
| ------ | ---------------------------- | ------------------------------------------------ |
| POST   | `/auth/signup`               | Admin signup → unverified, sends verification email |
| POST   | `/auth/signin`               | Blocks unverified admins (`403 EMAIL_NOT_VERIFIED`) |
| POST   | `/auth/verify-email`         | `{ token }` – marks email verified (deep link)   |
| GET    | `/auth/verify?token=...`     | Web fallback page (verifies + “Open app” button) |
| POST   | `/auth/resend-verification`  | `{ email }` – rate limited, no enumeration       |
| POST   | `/auth/forgot-password`      | `{ email }` – emails a 6-digit OTP, no enumeration |
| POST   | `/auth/verify-otp`           | `{ email, otp }` → `{ resetToken }`              |
| POST   | `/auth/reset-password`       | `{ email, resetToken, password }`                |

All are rate-limited via `@nestjs/throttler`. OTPs are hashed at rest, expire in
`OTP_TTL_MINUTES`, are single-use, and lock after `OTP_MAX_ATTEMPTS`.

## Environment variables (new in Stage 1)

See `.env.example` for the full list. New keys:

```
# SMTP (leave EMAIL_ENABLED=false for local dev → emails print to console)
EMAIL_ENABLED=false
SMTP_HOST= SMTP_PORT=587 SMTP_SECURE=false SMTP_USER= SMTP_PASSWORD= SMTP_FROM=
# (SMTP_PASS is accepted as an alias for SMTP_PASSWORD)

# Deep links / verification
APP_DEEP_LINK_SCHEME=finmatrix
WEB_FALLBACK_URL=http://localhost:3000/api/v1/auth
VERIFICATION_TTL_HOURS=24

# OTP
OTP_TTL_MINUTES=10
OTP_MAX_ATTEMPTS=5

# Platform admin seed (npm run seed:superadmin)
ADMIN_EMAIL=platform-admin@example.com
ADMIN_PASSWORD=change_me_strong_password
ADMIN_NAME=Platform Admin
```

> ⚠️ The admin password shared during setup must be treated as **compromised**
> and rotated. Never commit real secrets.

### SMTP credentials

Stage 1 defaults to a **console/dev transport** (`EMAIL_ENABLED=false`): every
verification link, OTP, and approval/rejection email is printed to the server
log so the whole flow is testable without SMTP. To send real email, install
`nodemailer` (already in `package.json`), set `EMAIL_ENABLED=true`, and fill in
the `SMTP_*` values. **Provide real SMTP credentials at this step.**

## Setup

```bash
npm install                 # pulls nodemailer for SMTP
cp .env.example .env        # then fill in DB + JWT secrets
npm run migration:run       # apply Stage 1 migration
npm run seed:superadmin     # seed PLATFORM_ADMIN from ADMIN_EMAIL/ADMIN_PASSWORD
npm run start:dev
```

## Running migrations

```bash
npm run migration:run       # apply
npm run migration:revert    # roll back the last migration
```

The Stage 1 migration (`1780000000000-Stage1Auth.ts`) also marks all
pre-existing users as verified so the new sign-in gate never locks out current
accounts.

## Running tests

```bash
npm test                          # all unit tests
npx jest src/modules/auth         # auth unit tests (gate, verify, OTP)
```

## Testing deep links

The custom scheme is `finmatrix://`. A verification email contains:

- App deep link: `finmatrix://verify-email?token=<token>`
- Web fallback:  `<WEB_FALLBACK_URL>/verify?token=<token>` (served by
  `GET /auth/verify`, which verifies the token and renders an “Open app” page).

With `EMAIL_ENABLED=false`, copy the link from the server console.

**Android (emulator):**
```bash
adb shell am start -a android.intent.action.VIEW \
  -d "finmatrix://verify-email?token=PASTE_TOKEN"
```

**iOS (simulator):**
```bash
xcrun simctl openurl booted "finmatrix://verify-email?token=PASTE_TOKEN"
```

Universal Links (iOS) / App Links (Android) are intentionally deferred until a
production domain is available; the custom scheme + web fallback cover Stage 1.
