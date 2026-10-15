#!/bin/bash
set -euo pipefail
# Run through the native exec API so startup diagnostics reach the job log.
# Cloudflare does not permit iptables manipulation. Inner builds use host networking.
dockerd --host=unix:///var/run/docker.sock --iptables=false --ip6tables=false \
  --bridge=none --ip-forward=false --ip-masq=false --storage-driver=vfs \
  > /tmp/yag-dockerd.log 2>&1 &
daemon_pid=$!
for i in {1..100}; do
  if docker --host unix:///var/run/docker.sock info >/dev/null 2>&1; then
    echo 'Docker daemon ready'
    exit 0
  fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then break; fi
  sleep .2
done
tail -40 /tmp/yag-dockerd.log >&2
exit 1
