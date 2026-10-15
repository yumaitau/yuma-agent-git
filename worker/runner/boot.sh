#!/bin/bash
set -euo pipefail
# Cloudflare does not permit iptables manipulation. Inner builds use host networking.
exec dockerd --host=unix:///var/run/docker.sock --iptables=false --ip6tables=false --storage-driver=vfs
