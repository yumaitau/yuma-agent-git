#!/usr/bin/env bash
# Idempotent queue provisioning (issue #21): the three queues the Worker
# produces to. Safe to re-run — "already exists" is a success.
set -euo pipefail
cd "$(dirname "$0")/../worker"

for queue in derived-data agent-jobs git-import; do
  if output=$(npx wrangler queues create "$queue" 2>&1); then
    echo "queue ok: $queue"
  elif grep -qi 'already exists' <<< "$output"; then
    echo "queue ok: $queue"
  else
    echo "queue FAILED: $queue" >&2
    exit 1
  fi
done
