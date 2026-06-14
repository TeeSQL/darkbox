"""Deterministic non-trading action policy for the event-driven agents.

Dan's `strategy.decide` handles trading well but leaves the two outward-facing,
free-text surfaces under-specified: **billboards** (a public message) and
**market proposals** (a request to create a market, which must be human-approved
and may never auto-create an on-chain market). This module adds the
production-safety layer those surfaces need before CVM deployment.

Everything here is a **pure function** of (candidate, observation context,
per-agent state, config). Same inputs -> same decision, so it is fully
reproducible inside the CVM and exhaustively unit-testable. The runner persists
`PolicyState` between events so cooldowns and budgets hold across the event loop.

Mirrors the market-resolution grammar in `packages/shared/src/marketPolicy.ts`
(ported here so the Python decider has no TS dependency) and the safety rules in
`docs/agents/AGENT_ACTION_POLICY.md`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

# ─── Config ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PolicyConfig:
    # Cooldowns/budgets are measured in *events processed by this agent* (seq).
    billboard_cooldown_events: int = 2
    billboard_periodic_events: int = 4
    billboard_max_length: int = 280
    proposal_cooldown_events: int = 5
    proposal_budget_per_agent: int = 3
    proposal_resolver_type: str = 'ExternalAttested'
    require_future_resolve_by: bool = True


DEFAULT_CONFIG = PolicyConfig()


# ─── Per-agent state (persisted by the runner) ───────────────────────────────


@dataclass
class PolicyState:
    seq: int = 0
    last_billboard_seq: int | None = None
    last_proposal_seq: int | None = None
    proposals_made: int = 0
    proposed_questions: list[str] = field(default_factory=list)
    seen_market_ids: list[str] = field(default_factory=list)
    initialized: bool = False

    @staticmethod
    def from_json(raw: dict[str, Any] | None) -> 'PolicyState':
        raw = raw or {}
        return PolicyState(
            seq=int(raw.get('seq', 0)),
            last_billboard_seq=raw.get('lastBillboardSeq'),
            last_proposal_seq=raw.get('lastProposalSeq'),
            proposals_made=int(raw.get('proposalsMade', 0)),
            proposed_questions=list(raw.get('proposedQuestions', [])),
            seen_market_ids=list(raw.get('seenMarketIds', [])),
            initialized=bool(raw.get('initialized', False)),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            'seq': self.seq,
            'lastBillboardSeq': self.last_billboard_seq,
            'lastProposalSeq': self.last_proposal_seq,
            'proposalsMade': self.proposals_made,
            'proposedQuestions': self.proposed_questions,
            'seenMarketIds': self.seen_market_ids,
            'initialized': self.initialized,
        }


# ─── Market-resolution grammar (port of marketPolicy.ts) ─────────────────────

MAX_QUESTION_LEN = 200

_SUBJECTIVE_MARKERS = [
    'best', 'worst', 'funniest', 'coolest', 'nicest', 'prettiest',
    'innovative', 'creative', 'impressed', 'impressive', 'beautiful', 'favorite',
    'favourite', 'deserve', 'deserves', 'vibe', 'vibes', 'meaningful', 'meaningfully',
    'amazing', 'awesome', 'cleverest', 'smartest',
]


def normalize_question(q: str) -> str:
    """Normalize for duplicate detection + grammar matching (mirrors TS)."""
    s = q.lower()
    s = re.sub(r'[“”"\'`]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'[?.!,;:]+$', '', s).strip()
    return s


def _first_number(s: str) -> float | None:
    cleaned = re.sub(r'(\d),(\d)', r'\1\2', s)
    m = re.search(r'\d+(?:\.\d+)?', cleaned)
    return float(m.group(0)) if m else None


def _detect_subjective(norm: str) -> list[str]:
    return [w for w in _SUBJECTIVE_MARKERS if re.search(rf'\b{re.escape(w)}\b', norm)]


@dataclass(frozen=True)
class Classification:
    family: str
    resolvable: bool
    subjective: bool


def classify_market(question: str, resolver_type: str) -> Classification:
    """Classify a question into a resolution family. Pure function of the text."""
    norm = normalize_question(question)
    subjective_hits = _detect_subjective(norm)
    subjective = len(subjective_hits) > 0

    has_number = _first_number(norm) is not None
    ethglobal = bool(re.search(r'\bprojects?\b', norm)) and bool(
        re.search(r'\b(mention|use|using|submit|submitted|exceed|total|reach|integrat)', norm)
    ) and has_number
    darkbox = bool(
        re.search(r'\b(daemon|daemons|volume|markets?|pnl|trades?|players?|active|in-?game)\b', norm)
    ) and has_number

    if resolver_type in ('AdminManual', 'CanonicalWinner', 'VoidOnly'):
        return Classification('admin_manual', True, subjective)
    if subjective:
        return Classification('unknown', False, True)
    if ethglobal:
        return Classification('ethglobal_metric', True, False)
    if darkbox:
        return Classification('darkbox_metric', True, False)
    return Classification('unknown', False, False)


# ─── Billboard sanitization (no hidden-state leakage) ─────────────────────────

BillboardTrigger = Literal['trade_action', 'rival_response', 'market_live', 'periodic']

_FORBIDDEN_BILLBOARD_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ('evm_address', re.compile(r'0x[0-9a-fA-F]{40}\b')),
    ('long_hex_secret', re.compile(r'0x[0-9a-fA-F]{64}')),
    ('shadow_account', re.compile(r'shadow[_ ]?account', re.I)),
    ('private_key', re.compile(r'private[_ ]?key|priv[_ ]?key|seed phrase|mnemonic', re.I)),
    ('book_address', re.compile(r'v0:book:|book[_ ]?address', re.I)),
    ('portfolio_dump', re.compile(r'\bPORTFOLIO\b|TAKE_PROFIT_SIGNALS')),
    ('position_internal', re.compile(r'avg[_ ]?entry|realized[_ ]?pnl|unrealized[_ ]?pnl', re.I)),
    ('balance_internal', re.compile(r'current[_ ]?balance|total[_ ]?deposited|total[_ ]?withdrawn', re.I)),
    ('orderbook_json_dump', re.compile(r'\{[^}]*"(?:size|avgEntry|outcome)"\s*:[^}]*"(?:price|avgEntry|size)"\s*:', re.I)),
]


def sanitize_billboard(raw: str, config: PolicyConfig = DEFAULT_CONFIG) -> dict[str, Any]:
    """Trim/collapse, enforce max length, reject hidden-state leaks (whole msg)."""
    collapsed = re.sub(r'\s+', ' ', raw).strip()
    if not collapsed:
        return {'ok': False, 'reason': 'blank'}
    for name, pattern in _FORBIDDEN_BILLBOARD_PATTERNS:
        if pattern.search(collapsed):
            return {'ok': False, 'reason': 'hidden_state_leak', 'leakPattern': name}
    message = collapsed[: config.billboard_max_length].rstrip() if len(collapsed) > config.billboard_max_length else collapsed
    return {'ok': True, 'message': message}


_MEANINGFUL_TRADE_TYPES = {
    'make_order', 'take_order', 'cancel_order', 'split', 'merge', 'claim', 'update_position',
}


def evaluate_billboard(
    message: str | None,
    trade_action_types: list[str],
    rival_present: bool,
    new_market_live: bool,
    state: PolicyState,
    config: PolicyConfig = DEFAULT_CONFIG,
) -> dict[str, Any]:
    """Decide whether a billboard may post this event. Pure; does not mutate state.

    `state.seq` must already be advanced to the current event for this agent.
    """
    if not message:
        return {'allowed': False, 'triggers': [], 'rejectReason': 'blank'}

    seq = state.seq
    turns_since = float('inf') if state.last_billboard_seq is None else seq - state.last_billboard_seq

    triggers: list[str] = []
    if any(t in _MEANINGFUL_TRADE_TYPES for t in trade_action_types):
        triggers.append('trade_action')
    if rival_present:
        triggers.append('rival_response')
    if new_market_live:
        triggers.append('market_live')
    if turns_since >= config.billboard_periodic_events:
        triggers.append('periodic')

    if not triggers:
        return {'allowed': False, 'triggers': [], 'rejectReason': 'no_trigger'}
    # Hard rate limit: never more than one billboard per cooldown window.
    if turns_since < config.billboard_cooldown_events:
        return {'allowed': False, 'triggers': triggers, 'rejectReason': 'cooldown'}

    sanitized = sanitize_billboard(message, config)
    if not sanitized['ok']:
        return {'allowed': False, 'triggers': triggers, 'rejectReason': sanitized['reason'], 'leakPattern': sanitized.get('leakPattern')}
    return {'allowed': True, 'triggers': triggers, 'message': sanitized['message']}


# ─── Market proposal policy (admin-queue-only) ───────────────────────────────


def _is_future_iso(value: str, now: datetime) -> dict[str, bool]:
    raw = value.strip().replace('Z', '+00:00')
    try:
        ts = datetime.fromisoformat(raw)
    except ValueError:
        return {'parseable': False, 'future': False}
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=now.tzinfo)
    return {'parseable': True, 'future': ts > now}


def evaluate_proposal(
    proposal: dict[str, Any] | None,
    existing_questions: list[str],
    state: PolicyState,
    now: datetime,
    config: PolicyConfig = DEFAULT_CONFIG,
) -> dict[str, Any]:
    """Decide whether a proposal may enter the admin queue. Pure.

    `existing_questions` = normalized questions of live markets + queued proposals.
    Always admin-queue-only; never authorizes on-chain market creation.
    """
    if not proposal:
        return {'allowed': False, 'rejectReason': 'missing', 'adminQueueOnly': True}

    if state.proposals_made >= config.proposal_budget_per_agent:
        return {'allowed': False, 'rejectReason': 'budget_exhausted', 'adminQueueOnly': True}

    seq = state.seq
    turns_since = float('inf') if state.last_proposal_seq is None else seq - state.last_proposal_seq
    if turns_since < config.proposal_cooldown_events:
        return {'allowed': False, 'rejectReason': 'cooldown', 'adminQueueOnly': True}

    outcomes = proposal.get('outcomes') or ['YES', 'NO']
    if list(outcomes)[:2] != ['YES', 'NO']:
        return {'allowed': False, 'rejectReason': 'not_yes_no', 'adminQueueOnly': True}

    source = str(proposal.get('resolutionSource', '')).strip()
    if len(source) < 3:
        return {'allowed': False, 'rejectReason': 'missing_resolution_source', 'adminQueueOnly': True}

    resolve_by = str(proposal.get('resolveBy', '')).strip()
    if not resolve_by:
        return {'allowed': False, 'rejectReason': 'missing_resolve_by', 'adminQueueOnly': True}
    if config.require_future_resolve_by:
        checked = _is_future_iso(resolve_by, now)
        if not checked['parseable']:
            return {'allowed': False, 'rejectReason': 'resolve_by_unparseable', 'adminQueueOnly': True}
        if not checked['future']:
            return {'allowed': False, 'rejectReason': 'resolve_by_not_future', 'adminQueueOnly': True}

    question = str(proposal.get('question', ''))
    normalized = normalize_question(question)
    if normalized in set(state.proposed_questions) or normalized in {normalize_question(q) for q in existing_questions}:
        return {'allowed': False, 'rejectReason': 'duplicate', 'normalizedQuestion': normalized, 'adminQueueOnly': True}

    classification = classify_market(question, config.proposal_resolver_type)
    if not classification.resolvable:
        return {
            'allowed': False,
            'rejectReason': 'subjective' if classification.subjective else 'unresolvable',
            'normalizedQuestion': normalized,
            'family': classification.family,
            'adminQueueOnly': True,
        }

    return {'allowed': True, 'normalizedQuestion': normalized, 'family': classification.family, 'adminQueueOnly': True}


# ─── State advancement ───────────────────────────────────────────────────────


def advance_state(
    state: PolicyState,
    market_ids: list[str],
    billboard_allowed: bool,
    proposal_allowed: bool,
    proposal_question_norm: str | None,
) -> PolicyState:
    """Return the post-event state (the runner persists it). `seq` is assumed
    already advanced for this event before evaluation."""
    seen = list(dict.fromkeys([*state.seen_market_ids, *market_ids]))
    proposed = state.proposed_questions
    if proposal_allowed and proposal_question_norm:
        proposed = [*proposed, proposal_question_norm]
    return PolicyState(
        seq=state.seq,
        last_billboard_seq=state.seq if billboard_allowed else state.last_billboard_seq,
        last_proposal_seq=state.seq if proposal_allowed else state.last_proposal_seq,
        proposals_made=state.proposals_made + (1 if proposal_allowed else 0),
        proposed_questions=proposed,
        seen_market_ids=seen,
        initialized=True,
    )


def is_new_market_live(state: PolicyState, market_ids: list[str], market_open_flags: dict[str, bool]) -> bool:
    """A market id not previously seen by this agent that is currently open."""
    if not state.initialized:
        return False
    seen = set(state.seen_market_ids)
    return any(mid not in seen and market_open_flags.get(mid, False) for mid in market_ids)
