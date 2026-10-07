#!/usr/bin/env bash
# Writes local env files from the running local Supabase stack.
set -euo pipefail
cd "$(dirname "$0")/.."
STATUS=$(npx supabase status -o json 2>/dev/null)
get() { echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin)['$1'])"; }
API_URL=$(get API_URL); ANON=$(get ANON_KEY); SERVICE=$(get SERVICE_ROLE_KEY); JWT=$(get JWT_SECRET)
cat > services/api/.env.local <<ENV
APP_ENV=local
SUPABASE_URL=$API_URL
SUPABASE_ANON_KEY=$ANON
SUPABASE_SERVICE_ROLE_KEY=$SERVICE
SUPABASE_JWT_SECRET=$JWT
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=$(pwd)/.local-storage
QUEUE_DRIVER=local
SCAN_MODE=local
EMAIL_DRIVER=log
PUBLIC_API_URL=http://localhost:8787
PUBLIC_APP_URL=http://harborview.localhost:5173
ENV
cat > apps/web/.env.local <<ENV
VITE_SUPABASE_URL=$API_URL
VITE_SUPABASE_ANON_KEY=$ANON
VITE_API_URL=http://localhost:8787
ENV
echo "Wrote services/api/.env.local and apps/web/.env.local"
