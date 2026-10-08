#!/usr/bin/env bash
# Brings up the whole local stack: Docker (if needed), local Supabase, demo data,
# API server and Vite. Idempotent; logs go to .local-logs/.
#   RESET=0 scripts/dev-up.sh   # keep existing database contents
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LOGS="$ROOT/.local-logs"
mkdir -p "$LOGS"
if ! docker info >/dev/null 2>&1; then
  echo "Starting dockerd…"; (setsid dockerd > .local-logs/dockerd.log 2>&1 < /dev/null &)
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
# Docker Hub fallback for environments that cannot reach public.ecr.aws.
export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-docker.io}"
npx supabase start -x studio,imgproxy,realtime,storage-api,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit > .local-logs/supabase.log 2>&1 < /dev/null
bash scripts/local-env.sh > /dev/null 2>&1 < /dev/null
if [ "${RESET:-1}" = "1" ]; then
  npx supabase db reset --local > .local-logs/db-reset.log 2>&1 < /dev/null
  rm -rf .local-storage
  npm run seed:files -w services/api > .local-logs/seed.log 2>&1 < /dev/null
fi
# Stop servers started by a previous run (PID files, never pattern matching).
for f in .local-logs/api.pid .local-logs/web.pid; do
  [ -f "$f" ] && kill -- "-$(cat "$f")" 2>/dev/null || true
  rm -f "$f"
done
(cd services/api && node build-local.mjs > /dev/null)
# Fully detached (own session, no inherited stdio) so callers piping this script's output don't hang.
(cd "$ROOT/services/api" && { LOCAL_SCHEDULER="${LOCAL_SCHEDULER:-off}" setsid nohup node --env-file=.env.local --enable-source-maps dist/local/server.mjs > "$LOGS/api.log" 2>&1 < /dev/null & echo $! > "$LOGS/api.pid"; })
(cd "$ROOT/apps/web" && { setsid nohup npx vite --host 0.0.0.0 > "$LOGS/web.log" 2>&1 < /dev/null & echo $! > "$LOGS/web.pid"; })
for _ in $(seq 1 30); do curl -sf localhost:8787/health >/dev/null && curl -sf -o /dev/null localhost:5173 && break; sleep 1; done
echo "Ready: http://harborview.localhost:5173  http://summit.localhost:5173  (API http://localhost:8787)"
