/**
 * Every system whose report exports FinMatrix reads. Adding a system is a
 * profile here, its sample in scripts/migration-samples and its tests.
 */
import { ReportProfile } from '../report-engine';
import { PEACHTREE_PROFILE } from './peachtree';
import { QUICKBOOKS_DESKTOP_PROFILE, QUICKBOOKS_ONLINE_PROFILE } from './quickbooks';
import { XERO_PROFILE, ZOHO_BOOKS_PROFILE } from './xero-zoho';

export const REPORT_PROFILES: ReportProfile[] = [
  PEACHTREE_PROFILE,
  QUICKBOOKS_ONLINE_PROFILE,
  QUICKBOOKS_DESKTOP_PROFILE,
  XERO_PROFILE,
  ZOHO_BOOKS_PROFILE,
];
