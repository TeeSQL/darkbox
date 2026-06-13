#!/bin/sh
# DarkBox debug sshd entrypoint. Materializes authorized keys from the sealed
# AUTHORIZED_KEYS env (newline-separated public keys) so no key material is baked
# into the image, then starts sshd. On the public bastion (STUNNEL_ACCEPT_PORT set)
# it first brings up an stunnel TLS terminator so sshd can traverse the dstack
# gateway's SNI-routed TLS-passthrough.
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

# Public bastion only: front sshd with TLS so it rides the dstack gateway's
# `s`-suffix TLS-passthrough (gateway routes by SNI, passes the raw TLS stream to
# our published port; we terminate it here). The ingress cert is a throwaway used
# for SNI routing only — clients accept-any-cert — so a self-signed cert is correct
# by design; the real security is SSH's own host key + key-only auth. Mesh-only
# sidecars leave STUNNEL_ACCEPT_PORT unset and run plain sshd on :22.
if [ -n "${STUNNEL_ACCEPT_PORT:-}" ]; then
  mkdir -p /etc/stunnel
  if [ ! -f /etc/stunnel/cert.pem ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout /etc/stunnel/key.pem -out /etc/stunnel/cert.pem \
      -subj "/CN=${DEBUG_NODE_NAME:-darkbox-bastion}" 2>/dev/null
  fi
  cat > /etc/stunnel/stunnel.conf <<EOF
foreground = no
pid = /run/stunnel.pid
[ssh]
accept = 0.0.0.0:${STUNNEL_ACCEPT_PORT}
connect = 127.0.0.1:22
cert = /etc/stunnel/cert.pem
key = /etc/stunnel/key.pem
EOF
  STUNNEL_BIN="$(command -v stunnel4 || command -v stunnel || echo stunnel4)"
  echo "[entrypoint] TLS-passthrough: ${STUNNEL_BIN} :${STUNNEL_ACCEPT_PORT} -> 127.0.0.1:22"
  "$STUNNEL_BIN" /etc/stunnel/stunnel.conf
fi

exec /usr/sbin/sshd -D -e
