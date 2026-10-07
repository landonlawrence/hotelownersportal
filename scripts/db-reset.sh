#!/usr/bin/env bash
# Re-applies migrations + demo seed to the LOCAL database and writes demo files.
set -euo pipefail
cd "$(dirname "$0")/.."
npx supabase db reset --local
rm -rf .local-storage
npm run seed:files -w services/api
