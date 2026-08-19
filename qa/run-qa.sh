#!/usr/bin/env bash
#
# FinMatrix ledger gate (audit gap G5).
#
# Runs qa/invariants.sql and FAILS if any check returns a row. Every query in
# that file is written so that a row IS a defect, which makes "no output" the
# only passing result.
#
# Reaches Postgres one of two ways, in this order:
#   DATABASE_URL=postgres://...        a direct connection (CI)
#   PG_CONTAINER=finmatrix-postgres    docker exec (local; there is no host
#                                      psql client on the dev machine)
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/db qa/run-qa.sh
#   qa/run-qa.sh                       # local, via the compose container
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/invariants.sql"

PG_CONTAINER="${PG_CONTAINER:-finmatrix-postgres}"
DB_USER="${DB_USERNAME:-finmatrix_user}"
DB_NAME="${DB_NAME:-finmatrix}"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "run-qa: cannot find $SQL_FILE" >&2
  exit 2
fi

# -t strips headers, -A unaligned: a passing run prints absolutely nothing.
PSQL_FLAGS=(-v ON_ERROR_STOP=1 -t -A)

have_container() {
  command -v docker >/dev/null 2>&1 \
    && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"
}

run_sql() {
  # Prefer a direct connection, but only when there is actually a psql binary
  # to make it with. The dev machine exports DATABASE_URL for the acceptance
  # suites yet has no host psql client, so checking the URL alone sent the gate
  # down a path that could not work.
  if [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
    psql "${PSQL_FLAGS[@]}" "$DATABASE_URL" -f "$SQL_FILE"
  elif have_container; then
    docker exec -i "$PG_CONTAINER" \
      psql "${PSQL_FLAGS[@]}" -U "$DB_USER" -d "$DB_NAME" < "$SQL_FILE"
  elif [[ -n "${DATABASE_URL:-}" ]] && command -v node >/dev/null 2>&1; then
    # No psql binary. Rather than dead-end here -- which is what pushed the
    # check into a throwaway script that silently parsed nothing -- hand off to
    # the Node runner, which needs only the `pg` dependency and enforces that
    # it ran every invariant the file declares.
    node "$SCRIPT_DIR/run-qa.js"
    exit $?
  else
    echo "run-qa: need DATABASE_URL with either a psql client or node, or a" >&2
    echo "        running container named '$PG_CONTAINER'." >&2
    exit 2
  fi
}

echo "=== FinMatrix ledger invariants ==="

OUTPUT="$(run_sql 2>&1)"
STATUS=$?

if [[ $STATUS -ne 0 ]]; then
  echo "run-qa: the invariant queries themselves failed to run:" >&2
  echo "$OUTPUT" >&2
  exit 2
fi

# Any non-blank line is a returned row, i.e. a violated invariant.
VIOLATIONS="$(printf '%s\n' "$OUTPUT" | sed '/^[[:space:]]*$/d')"

if [[ -n "$VIOLATIONS" ]]; then
  echo "LEDGER GATE FAILED — the following invariants returned rows:" >&2
  echo >&2
  printf '%s\n' "$VIOLATIONS" | while IFS= read -r line; do
    echo "  $line" >&2
  done
  echo >&2
  echo "Each line above is a defect. See qa/invariants.sql and" >&2
  echo "ACCOUNTING_QA_GUIDE.md §2 for what each check means." >&2
  exit 1
fi

echo "All invariants clean — every check returned zero rows."
exit 0
