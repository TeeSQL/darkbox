#!/bin/sh
# 15-minute refresh + resolve loop for the AttestMesh core member.
#
# Each cycle:
#   1. Pull ETHGlobal showcase project snapshots into $SHOWCASE_OUT (a mounted
#      volume so the cache survives container restarts).
#   2. Run the resolver pass: read markets + cached snapshots, ask the Phala
#      brain, and write resolution DOSSIERS to $RESOLVER_DATA/resolutions for
#      human approval (propose-then-confirm — never submits an on-chain tx).
#
# Both steps are best-effort: a failure is logged and retried next cycle, so the
# container stays healthy through transient ETHGlobal / indexer / brain blips.
set -eu

: "${SHOWCASE_EVENT_SLUG:=newyork2025}"
: "${SHOWCASE_INTERVAL_SECONDS:=900}"
: "${SHOWCASE_OUT:=/data/ethglobal}"
: "${RESOLVER_ENABLED:=true}"
: "${RESOLVER_DATA:=/data}"

echo "[loop] start: event=$SHOWCASE_EVENT_SLUG interval=${SHOWCASE_INTERVAL_SECONDS}s out=$SHOWCASE_OUT resolver=$RESOLVER_ENABLED"

while true; do
  echo "[showcase] $(date -u +%Y-%m-%dT%H:%M:%SZ) pull begin"
  if node --import tsx services/agents/src/cli.ts showcase \
       --event "$SHOWCASE_EVENT_SLUG" --out "$SHOWCASE_OUT"; then
    echo "[showcase] $(date -u +%Y-%m-%dT%H:%M:%SZ) pull ok"
  else
    echo "[showcase] $(date -u +%Y-%m-%dT%H:%M:%SZ) pull FAILED; retrying next cycle" >&2
  fi

  if [ "$RESOLVER_ENABLED" = "true" ]; then
    echo "[resolve] $(date -u +%Y-%m-%dT%H:%M:%SZ) pass begin"
    if node --import tsx services/agents/src/cli.ts resolve \
         --event "$SHOWCASE_EVENT_SLUG" --data "$RESOLVER_DATA"; then
      echo "[resolve] $(date -u +%Y-%m-%dT%H:%M:%SZ) pass ok"
    else
      echo "[resolve] $(date -u +%Y-%m-%dT%H:%M:%SZ) pass FAILED; retrying next cycle" >&2
    fi
  fi

  sleep "$SHOWCASE_INTERVAL_SECONDS"
done
