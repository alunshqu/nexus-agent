#!/bin/bash
# Restart nexus-agent only if no sessions are currently running.
# Usage: ./restart-when-idle.sh

PORT=${PORT:-8080}
READY_URL="http://127.0.0.1:${PORT}/health/ready"

RESPONSE=$(curl -sS --max-time 3 "$READY_URL" 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "[restart] Service unreachable, restarting..."
  pm2 restart nexus-agent --update-env
  exit 0
fi

READY=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ready','false'))" 2>/dev/null)
RUNNING=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('running',0))" 2>/dev/null)

if [ "$READY" = "True" ] || [ "$READY" = "true" ]; then
  echo "[restart] No active sessions. Restarting..."
  pm2 restart nexus-agent --update-env
  echo "[restart] Done."
  exit 0
else
  echo "[restart] ${RUNNING} session(s) running. Restart cancelled."
  exit 1
fi
