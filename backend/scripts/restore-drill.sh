#!/usr/bin/env bash
# Backup and restore drill (runbook-backup-restore.md). Dumps a database, restores it into a brand new local database, and checks
# that the restored copy holds the same rows and the same ledger. Times each step. Never writes to the source.
#
#   SOURCE_URL=postgresql://user:pass@localhost:5544/erpatio_test \
#   RESTORE_ADMIN_URL=postgresql://user:pass@localhost:5544/postgres  scripts/restore-drill.sh
#
# The restore target must be local. A drill against a real Neon backup restores from Neon's own branch/point-in-time
# restore instead (see the runbook); this script proves the dump itself is complete and restorable.
set -euo pipefail

SOURCE_URL="${SOURCE_URL:?set SOURCE_URL to the database to dump}"
ADMIN_URL="${RESTORE_ADMIN_URL:?set RESTORE_ADMIN_URL to a local admin connection (database postgres)}"
case "$ADMIN_URL" in *localhost*|*127.0.0.1*) ;; *) echo "Refusing: the restore target must be on localhost." >&2; exit 2;; esac
PGBIN="${PGBIN:-}"
pg() { if [ -n "$PGBIN" ]; then "$PGBIN/$1" "${@:2}"; else "$1" "${@:2}"; fi; }

DB="erpatio_restore_drill_$$"
DUMP="$(mktemp -t erpatio-drill-XXXXXX.dump)"
RESTORE_URL="${ADMIN_URL%/*}/$DB"
cleanup() { pg psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null 2>&1 || true; rm -f "$DUMP"; }
trap cleanup EXIT

now() { date +%s; }
t0=$(now)
pg pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$SOURCE_URL"
t1=$(now)
pg psql "$ADMIN_URL" -qc "CREATE DATABASE \"$DB\"" >/dev/null
pg pg_restore --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_URL" "$DUMP"
t2=$(now)

SUMMARY="
SELECT 'tenants' AS k, count(*)::text AS v FROM tenants
UNION ALL SELECT 'accounts', count(*)::text FROM accounts
UNION ALL SELECT 'journal_entries', count(*)::text FROM journal_entries
UNION ALL SELECT 'journal_lines', count(*)::text FROM journal_lines
UNION ALL SELECT 'documents', count(*)::text FROM documents
UNION ALL SELECT 'stock_movements', count(*)::text FROM stock_movements
UNION ALL SELECT 'payslips', count(*)::text FROM payslips
UNION ALL SELECT 'ledger_debit', COALESCE(sum(debit), 0)::text FROM journal_lines
UNION ALL SELECT 'ledger_credit', COALESCE(sum(credit), 0)::text FROM journal_lines
UNION ALL SELECT 'ledger_fingerprint', md5(COALESCE(string_agg(id::text || ':' || account_id::text || ':' || debit::text || ':' || credit::text, ',' ORDER BY id), '')) FROM journal_lines
ORDER BY 1"
a="$(pg psql "$SOURCE_URL" -Atc "$SUMMARY")"
b="$(pg psql "$RESTORE_URL" -Atc "$SUMMARY")"
echo "dump:    $((t1 - t0)) s"
echo "restore: $((t2 - t1)) s"
echo "---- source ----";   echo "$a"
echo "---- restored ----"; echo "$b"
if [ "$a" = "$b" ]; then
  echo "RESULT: the restored copy matches the source (rows, ledger totals and ledger fingerprint)."
else
  echo "RESULT: MISMATCH between the source and the restored copy." >&2
  exit 1
fi
# The restored schema must still carry the protections, not only the data: same forced row-level security and triggers as the source.
PROT="SELECT (SELECT count(*) FROM pg_class WHERE relrowsecurity AND relforcerowsecurity AND relkind = 'r' AND relnamespace = 'public'::regnamespace)::text || ' tables with forced row-level security, ' || (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)::text || ' triggers, ' || (SELECT count(*) FROM pg_policy)::text || ' policies'"
pa="$(pg psql "$SOURCE_URL" -Atc "$PROT")"
pb="$(pg psql "$RESTORE_URL" -Atc "$PROT")"
echo "source protections:   $pa"
echo "restored protections: $pb"
[ "$pa" = "$pb" ] || { echo "RESULT: the restore lost row-level security, policies or triggers." >&2; exit 1; }
echo "RESULT: protections match too."
