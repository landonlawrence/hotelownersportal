#!/usr/bin/env bash
# Verifies that the anonymous (publishable) key cannot read any table in the
# public schema of a Supabase project. Uses only browser-safe values, so it can
# run against any environment, local or hosted.
#
#   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... bash scripts/verify-anon-lockdown.sh
#
# A table passes when the REST API refuses the request (401/403/404) or returns
# an empty result. Anything else is a data exposure and fails the script.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"

TABLES=$(grep -rhoE "create table (if not exists )?public\.[a-z_0-9]+" supabase/migrations \
  | sed -E 's/.*public\.//' | sort -u)
[ -n "$TABLES" ] || { echo "no tables found in supabase/migrations" >&2; exit 1; }

# The key itself must work, otherwise every table would "pass" with a 401.
# (Hosted projects reject an invalid key; the local gateway treats it as anonymous.)
# resolve_branding is the one RPC intentionally open to anonymous callers.
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d '{"p_host":"lockdown-check.invalid"}' "$SUPABASE_URL/rest/v1/rpc/resolve_branding")
case "$code" in
  200) ;;
  404) echo "note: schema not migrated yet (resolve_branding not found)" ;;
  *) echo "The anonymous key was rejected (HTTP $code); check SUPABASE_URL and SUPABASE_ANON_KEY" >&2; exit 1 ;;
esac

fail=0; count=0
for t in $TABLES; do
  count=$((count + 1))
  body=$(mktemp)
  code=$(curl -sS -o "$body" -w '%{http_code}' \
    -H "apikey: $SUPABASE_ANON_KEY" "$SUPABASE_URL/rest/v1/$t?select=*&limit=1")
  case "$code" in
    401|403|404) ;;
    200) if [ "$(tr -d '[:space:]' < "$body")" != "[]" ]; then
           echo "EXPOSED: $t returned rows to the anonymous key"; fail=1
         fi ;;
    *) echo "UNEXPECTED: $t returned HTTP $code: $(head -c 200 "$body")"; fail=1 ;;
  esac
  rm -f "$body"
done

if [ "$fail" -ne 0 ]; then
  echo "Anonymous lockdown check FAILED" >&2
  exit 1
fi
echo "Anonymous lockdown check passed: $count tables, no rows readable with the anonymous key"
