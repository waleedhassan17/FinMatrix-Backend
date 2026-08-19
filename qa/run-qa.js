#!/usr/bin/env node
/**
 * FinMatrix ledger gate (audit gap G5) — Node runner.
 *
 * Runs qa/invariants.sql and FAILS if any check returns a row. Every query in
 * that file is written so that a row IS a defect.
 *
 * Why this exists alongside run-qa.sh: the shell gate needs a `psql` binary or
 * a local Postgres container, and the dev machine has neither. That gap got
 * filled with a throwaway script which split the SQL on `;` and kept chunks
 * beginning with SELECT — but every statement here is preceded by its comment
 * block, so no chunk ever started with SELECT. It parsed 0 of 16 statements
 * and reported "all invariants pass" on an empty set, twice, while two
 * invariants were actually failing in production.
 *
 * So the single most important thing this runner does is REFUSE TO REPORT
 * SUCCESS ON A SET IT DID NOT RUN. It counts the invariants the file declares
 * and exits non-zero if it did not parse exactly that many. A gate that cannot
 * fail is worse than no gate, because it gets quoted as evidence.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node qa/run-qa.js
 *   npm run qa:invariants
 *
 * Exit codes:
 *   0  every invariant ran and returned no rows
 *   1  at least one invariant was violated
 *   2  could not run the suite at all (parse mismatch, no URL, query error)
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SQL_FILE = path.join(__dirname, 'invariants.sql');

/**
 * Each invariant is declared as `SELECT '<NAME>' AS violation, ...` and is
 * preceded by a `--` comment block. Strip the comment lines FIRST, then split;
 * splitting first is what produced chunks that never started with SELECT.
 */
function parseInvariants(raw) {
  const declared = (raw.match(/^SELECT '/gm) || []).length;
  const statements = raw
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^SELECT/i.test(s));
  return { declared, statements };
}

const nameOf = (stmt) => (stmt.match(/'([^']+)'/) || [null, '(unnamed)'])[1];

async function main() {
  if (!fs.existsSync(SQL_FILE)) {
    console.error(`run-qa: cannot find ${SQL_FILE}`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('run-qa: DATABASE_URL is not set.');
    process.exit(2);
  }

  const raw = fs.readFileSync(SQL_FILE, 'utf8');
  const { declared, statements } = parseInvariants(raw);

  // The guard that matters. Never let a shortfall read as a pass.
  if (declared === 0 || statements.length !== declared) {
    console.error(
      `run-qa: parsed ${statements.length} statement(s) but the file declares ` +
        `${declared} invariant(s). Refusing to report a result for a set that ` +
        'was not run.',
    );
    process.exit(2);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log('=== FinMatrix ledger invariants ===');
  let violations = 0;
  let errored = 0;

  try {
    for (const stmt of statements) {
      const name = nameOf(stmt);
      try {
        const { rows } = await client.query(stmt);
        if (rows.length === 0) {
          console.log(`pass  ${name}`);
        } else {
          violations += rows.length;
          console.log(`FAIL  ${name}  -> ${rows.length} row(s)`);
          for (const row of rows.slice(0, 5)) {
            console.log(`        ${JSON.stringify(row)}`);
          }
          if (rows.length > 5) {
            console.log(`        ... and ${rows.length - 5} more`);
          }
        }
      } catch (e) {
        errored += 1;
        console.log(`ERROR ${name}  -> ${e.message}`);
      }
    }
  } finally {
    await client.end();
  }

  console.log(
    `\nran ${statements.length} of ${declared} | violations: ${violations}` +
      (errored ? ` | queries that failed to run: ${errored}` : ''),
  );

  if (errored) process.exit(2);
  process.exit(violations === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`run-qa: ${e.message}`);
  process.exit(2);
});
