"""Adapter that reconciles a deterministic agent decision into the indexer.

This is the missing event-driven adapter path: a decision produced by
`strategy.decide` is mapped onto the indexer's `/internal/v0/agent-turns`
ingress so the indexer reconciles the resulting orders / billboards / proposals
(and, once on-chain execution exists, fills). Uses only the stdlib so the Python
agents stay dependency-free.

The executor remains dry-run for on-chain signing (see
docs/agents/event-driven-python-agents.md); this adapter is the indexer-side
reconciliation, which the indexer re-validates (billboard sanitization, proposal
de-duplication, admin-queue-only) as a trust boundary.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .models import AgentIdentity


def build_agent_turn_body(run_id: str, turn: int, identity: AgentIdentity, decision: dict[str, Any]) -> dict[str, Any]:
    return {
        'runId': run_id,
        'strategy': 'event-agents',
        'agentId': identity.agentId,
        'turn': turn,
        'ok': bool(decision.get('ok', True)),
        'latencyMs': 0,
        'identity': {'address': identity.address, 'shadowAccount': identity.shadowAccount},
        'output': {
            'tradeActions': decision.get('tradeActions', []),
            'billboardPost': decision.get('billboardPost'),
            'marketProposal': decision.get('marketProposal'),
            'reason': decision.get('reason', ''),
        },
    }


def submit_decision(submit_url: str, run_id: str, turn: int, identity: AgentIdentity, decision: dict[str, Any], timeout: float = 5.0) -> dict[str, Any]:
    """POST one decision to the indexer. Returns {ok, status, body|error}."""
    body = build_agent_turn_body(run_id, turn, identity, decision)
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        submit_url.rstrip('/') + '/internal/v0/agent-turns',
        data=data,
        headers={'content-type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = raw
            return {'ok': 200 <= resp.status < 300, 'status': resp.status, 'body': parsed}
    except urllib.error.HTTPError as exc:
        return {'ok': False, 'status': exc.code, 'error': exc.read().decode(errors='replace')}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {'ok': False, 'error': str(exc)}
