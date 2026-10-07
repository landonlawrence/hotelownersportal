#!/usr/bin/env bash
# Starts the local Supabase stack with only the services this project uses.
set -euo pipefail
cd "$(dirname "$0")/.."
npx supabase start -x studio,imgproxy,realtime,storage-api,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit
bash scripts/local-env.sh
