#!/bin/sh
# 15-minute showcase refresh loop for the AttestMesh core member.
#
# Pulls ETHGlobal showcase project snapshots and caches them under
# $SHOWCASE_OUT (a mounted volume so the cache survives container restarts).
# A failed pull is logged and retried on the next cycle — it never exits, so the
# container stays healthy through transient ETHGlobal API / egress blips.
set -eu

: "${SHOWCASE_EVENT_SLUG:=newyork2025}"
: "${SHOWCASE_INTERVAL_SECONDS:=900}"
: "${SHOWCASE_OUT:=/data/ethglobal}"

echo "[showcase] loop start: event=$SHOWCASE_EVENT_SLUG interval=${SHOWCASE_INTERVAL_SECONDS}s out=$SHOWCASE_OUT"

while true; do
  echo "[showcase] $(date -u +%Y-%m-%dT%H:%M:%SZ) pull begin"
  if node --import tsx services/agents/src/cli.ts showcase \
       --event "$SHOWCASE_EVENT_SLUG" --out "$SHOWCASE_OUT"; then
    echo "[showcase] $(date -u +%Y-%m-%dT%H:%M:%SZ) pull ok"
  else
    echo "[showcase] $(date -u +%Y-%m-%dT%H:%M:%SZ) pull FAILED; retrying next cycle" >&2
  fi
  sleep "$SHOWCASE_INTERVAL_SECONDS"
done
