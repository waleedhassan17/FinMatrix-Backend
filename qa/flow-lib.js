/**
 * Shared HTTP + assertion helpers for the flow end-to-end harness.
 * Drives the REAL API (the same endpoints the mobile app calls), so anything
 * that would fail in the app fails here too.
 */
/**
 * Where the harness points when nobody says.
 *
 * This used to default to the PRODUCTION Heroku API. The harness creates
 * deliveries, invoices, payments and journal entries, so `npm run qa:flow` with
 * an unset API_BASE — the exact command a release checklist tells someone to
 * run — wrote test transactions into the real books. A gate must not be able to
 * damage the thing it is guarding by being run the obvious way.
 *
 * Local by default; reaching anything else now takes a deliberate API_BASE.
 */
const BASE = process.env.API_BASE || 'http://localhost:3000/api/v1';

async function http(method, path, { token, companyId, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers['x-company-id'] = companyId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const get = (p, o) => http('GET', p, o);
const post = (p, body, o) => http('POST', p, { ...o, body });
const patch = (p, body, o) => http('PATCH', p, { ...o, body });

/** Unwrap the {success,data} envelope and the various list shapes. */
function data(res) {
  const d = res.body && 'data' in res.body ? res.body.data : res.body;
  return d;
}
function rows(res) {
  const d = data(res);
  if (Array.isArray(d)) return d;
  if (!d) return [];
  return d.items || d.results || d.accounts || d.data || [];
}

const money = (n) => Number(n || 0);
const near = (a, b, tol = 0.01) => Math.abs(money(a) - money(b)) <= tol;

module.exports = { BASE, http, get, post, patch, data, rows, money, near };
