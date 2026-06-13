#!/bin/sh
# DarkBox debug sshd entrypoint. Materializes authorized keys from the sealed
# AUTHORIZED_KEYS env (newline-separated public keys) so no key material is baked
# into the image, then starts sshd in the foreground.
set -eu

mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ -n "${AUTHORIZED_KEYS:-}" ]; then
  printf '%s\n' "$AUTHORIZED_KEYS" > /root/.ssh/authorized_keys
else
  # Fail-closed: no keys ⇒ no logins (combined with prohibit-password).
  : > /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/authorized_keys

# Generate host keys on first boot if absent.
ssh-keygen -A

printf 'DarkBox debug shell — %s. On the mesh: cast/curl to 10.13.x.x members.\n' \
  "${DEBUG_NODE_NAME:-mesh-node}" > /etc/motd 2>/dev/null || true

exec /usr/sbin/sshd -D -e
