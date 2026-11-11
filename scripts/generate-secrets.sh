#!/usr/bin/env sh
set -eu
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required.' >&2; exit 1; }
printf 'NODEBASE_SETUP_KEY='; openssl rand -hex 32
printf 'NODEBASE_ENCRYPTION_KEY='; openssl rand -base64 32
printf 'RUNNER_TOKEN='; openssl rand -hex 32
if [ -S /var/run/docker.sock ] && command -v stat >/dev/null 2>&1; then
  printf 'DOCKER_GID='; stat -c '%g' /var/run/docker.sock
fi
