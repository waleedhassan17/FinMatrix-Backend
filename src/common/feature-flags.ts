// ═══════════════════════════════════════════════════════
// BILLING-DISABLED BUILD  (free trial + subscriptions)
// ═══════════════════════════════════════════════════════
// FinMatrix is shipping to warehouses for a testing phase, and for that phase
// the product has exactly ONE acquisition path:
//
//   signup → company setup → auto-submit → super-admin approval → full app
//
// No plan selection, no free trial, no bank-transfer payment step, no paywall.
// Rather than deleting the billing code, everything is routed through this one
// switch so the pivot back is a single-line revert. The screens, routes,
// networks, plan catalogue, `/billing/*` endpoints and database tables all
// stay exactly where they are.
//
// To restore Free Trial + Subscriptions:
//   1. set BILLING_DISABLED_BUILD = false in all THREE repos
//        FinMatrix-Backend  src/common/feature-flags.ts   (this file)
//        FinMatrix          src/utils/featureGates.ts
//        FinMatrix-Web      src/config/featureFlags.ts
//   2. grep each repo for "BILLING-DISABLED" and un-comment the marked blocks
//   3. per-repo checklist:
//      backend — submitForApproval's plan check (companies.service.ts),
//                riderSeatLimit() (plan-config.ts)
//      app     — Auth.ts route arrays (INACTIVE/DRAFT/COMPANY_ONBOARDING),
//                More.ts, tierRoutes.tsx, MoreStack ParamList,
//                RootStackParamList, TrialBanner in AppContainer,
//                SubscriptionSection in SettingsScreen, the Upgrade CTAs in
//                DeliveryPersonnelListScreen, the CreateCompany submit hop
//      web     — router.tsx + lazyPages.ts entries, TrialStrip in AppLayout,
//                PlanDetails in MyAccountPage, PricingSection + nav anchor +
//                trial FAQ, OnboardingShell's step rail, the CompanySetupPage
//                submit hop, AccountStatusPage's draft branch
//
// NOTE: the hand-run acceptance scripts `npm run test:subscription` and
// `npm run test:trial` drive the plan/trial flows end to end. They will fail
// against a server built with this flag on — that is expected, not a
// regression. `npm test` (the unit suite) stays green.
//
// EXISTING paying companies are deliberately left alone: PLAN_CONFIG keeps
// every key, the expiry cron keeps running, and a company already on a paid
// plan keeps its limits and its renewal date. Only the ACQUISITION path is
// short-circuited.
export const BILLING_DISABLED_BUILD = true;
