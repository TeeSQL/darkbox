from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from typing import Any

from .models import AgentIdentity, AgentPolicy, Market, MarketEvent, MarketProposal, Observation, Order, OwnerBinding, Position, clamp, fmt, now_iso
from .policy import (
    DEFAULT_CONFIG,
    PolicyConfig,
    PolicyState,
    advance_state,
    evaluate_billboard,
    evaluate_proposal,
    is_new_market_live,
    normalize_question,
)


def market_mid(market: Market) -> float:
    if market.bestBid is not None and market.bestAsk is not None:
        return clamp((market.bestBid + market.bestAsk) / 2, 0.01, 0.99)
    if market.lastPrice is not None:
        return clamp(market.lastPrice, 0.01, 0.99)
    if market.bestBid is not None:
        return clamp(market.bestBid + 0.05, 0.01, 0.99)
    if market.bestAsk is not None:
        return clamp(market.bestAsk - 0.05, 0.01, 0.99)
    return 0.5


def fair_value(policy: AgentPolicy, market: Market) -> float:
    base = policy.fairValues.get(market.marketId, market_mid(market))
    return clamp(base + policy.marketBias.get(market.marketId, 0), 0.01, 0.99)


def position_size(positions: tuple[Position, ...], market_id: str, outcome: str) -> float:
    return sum(p.size for p in positions if p.marketId == market_id and p.outcome == outcome)


def action_id(event: MarketEvent, agent_id: str, action: dict[str, Any], index: int) -> str:
    digest = sha256(f'{event.eventId}:{agent_id}:{index}:{action}'.encode()).hexdigest()[:24]
    return f'{event.eventId}:{agent_id}:{digest}'


def validate_identity(identity: AgentIdentity, binding: OwnerBinding | None) -> str | None:
    if binding is None:
        return 'missing_owner_binding'
    if binding.agentId != identity.agentId:
        return 'binding_agent_mismatch'
    if binding.daemonAddress.lower() != identity.address.lower():
        return 'binding_daemon_address_mismatch'
    if binding.shadowAccount.lower() != identity.shadowAccount.lower():
        return 'binding_shadow_account_mismatch'
    if binding.status == 'disabled':
        return 'binding_disabled'
    return None


def should_skip_market(policy: AgentPolicy, market: Market, event: MarketEvent) -> bool:
    if market.status != 'open':
        return True
    if market.marketId in policy.bannedMarkets:
        return True
    if policy.preferredMarkets and market.marketId not in policy.preferredMarkets and event.type not in ('market_created', 'user_whisper', 'policy_updated'):
        return True
    if event.marketId and event.marketId != market.marketId and event.type in ('market_created', 'orderbook_changed'):
        return True
    return False


def take_orders(policy: AgentPolicy, observation: Observation, market: Market, fv: float) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for order in sorted((o for o in observation.orders if o.marketId == market.marketId), key=lambda o: o.price):
        if len(actions) >= 3:
            break
        if order.side == 'sell' and order.outcome == 'YES' and fv - order.price >= policy.minEdgeToTake:
            actions.append({'type': 'take_order', 'marketId': order.marketId, 'orderId': order.orderId, 'size': fmt(min(order.remainingSize, policy.maxOrderSize)), 'maxPrice': fmt(order.price)})
        elif order.side == 'buy' and order.outcome == 'YES' and order.price - fv >= policy.minEdgeToTake:
            actions.append({'type': 'take_order', 'marketId': order.marketId, 'orderId': order.orderId, 'size': fmt(min(order.remainingSize, policy.maxOrderSize)), 'minPrice': fmt(order.price)})
    return actions


def quote_orders(policy: AgentPolicy, observation: Observation, market: Market, fv: float) -> list[dict[str, Any]]:
    own_orders = [o for o in observation.orders if o.marketId == market.marketId and o.agentId == policy.agentId]
    cancels: list[dict[str, Any]] = []
    for order in own_orders:
        reference = fv if order.outcome == 'YES' else 1 - fv
        if abs(order.price - reference) > policy.cancelDistance:
            cancels.append({'type': 'cancel_order', 'orderId': order.orderId})

    if len(own_orders) >= policy.maxOpenOrdersPerMarket:
        return cancels

    yes_position = position_size(observation.portfolio.positions, market.marketId, 'YES')
    size = min(policy.quoteSize, policy.maxOrderSize)
    bid = clamp(fv - policy.quoteSpread, 0.01, 0.98)
    ask = clamp(fv + policy.quoteSpread, 0.02, 0.99)
    actions: list[dict[str, Any]] = []
    if yes_position < policy.maxPositionSize:
        actions.append({'type': 'make_order', 'marketId': market.marketId, 'side': 'buy', 'outcome': 'YES', 'price': fmt(bid), 'size': fmt(size), 'timeInForce': 'GTC'})
    if yes_position > 0:
        actions.append({'type': 'make_order', 'marketId': market.marketId, 'side': 'sell', 'outcome': 'YES', 'price': fmt(ask), 'size': fmt(min(size, yes_position)), 'timeInForce': 'GTC'})
    return cancels + actions[: max(0, 2 - len(cancels))]


def take_profit(policy: AgentPolicy, observation: Observation, market: Market, fv: float) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for pos in observation.portfolio.positions:
        if pos.marketId != market.marketId or pos.size <= 0:
            continue
        mark = fv if pos.outcome == 'YES' else 1 - fv
        if mark - pos.avgEntry >= policy.takeProfitEdge:
            actions.append({'type': 'make_order', 'marketId': market.marketId, 'side': 'sell', 'outcome': pos.outcome, 'price': fmt(clamp(mark + 0.03, 0.02, 0.99)), 'size': fmt(min(pos.size / 2, policy.maxOrderSize)), 'timeInForce': 'GTC'})
    return actions


def _parse_now(observation: MarketEvent | Observation, event: MarketEvent) -> datetime:
    raw = (getattr(observation, 'now', '') or event.at or '').strip().replace('Z', '+00:00')
    try:
        parsed = datetime.fromisoformat(raw)
    except (ValueError, TypeError):
        return datetime.now(timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _billboard_candidate(policy: AgentPolicy, identity: AgentIdentity, market_ids: list[str], action_count: int) -> str | None:
    """A public, leak-free billboard line. References only public info (style,
    market id, action count) — never private book/positions/keys."""
    if action_count <= 0 or not market_ids:
        return None
    style = policy.billboardStyle or 'market signal'
    return f'{identity.agentId}: {style} — quoting {action_count} order(s) near fair on {market_ids[0]}.'[:280]


def _proposal_candidate(event: MarketEvent, policy: AgentPolicy, state: PolicyState, existing: list[str]) -> dict[str, Any] | None:
    """Detect a public unresolved question to propose: from the event payload
    first, else the agent's configured candidates (first not-yet-used one)."""
    payload_candidate = event.payload.get('proposalCandidate')
    if isinstance(payload_candidate, dict) and payload_candidate.get('question'):
        return dict(payload_candidate)
    used = set(state.proposed_questions) | {normalize_question(q) for q in existing}
    for candidate in policy.proposalCandidates:
        question = str(candidate.get('question', ''))
        if question and normalize_question(question) not in used:
            return dict(candidate)
    return None


def _apply_action_policy(
    event: MarketEvent,
    identity: AgentIdentity,
    policy: AgentPolicy,
    observation: Observation,
    actions: list[dict[str, Any]],
    state: PolicyState,
    config: PolicyConfig,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any], PolicyState]:
    """Gate + sanitize the non-trading surfaces. Returns
    (billboardPost, marketProposal, report, advanced_state). Advances state.seq."""
    state.seq += 1  # this event counts as one processed event for this agent

    market_ids = [m.marketId for m in observation.markets]
    open_flags = {m.marketId: m.status == 'open' for m in observation.markets}
    action_types = [a['type'] for a in actions if a.get('type') != 'hold']
    rival_present = any(b.agentId != identity.agentId for b in observation.billboards)
    new_market = is_new_market_live(state, market_ids, open_flags)

    # Billboard.
    candidate_msg = _billboard_candidate(policy, identity, market_ids, len(action_types))
    bb = evaluate_billboard(candidate_msg, action_types, rival_present, new_market, state, config)
    billboard_post = {'message': bb['message']} if bb.get('allowed') else None

    # Proposal.
    existing = observation.existing_questions()
    candidate = _proposal_candidate(event, policy, state, existing)
    prop = evaluate_proposal(candidate, existing, state, _parse_now(observation, event), config)
    proposal_post = MarketProposal.from_json(candidate).to_json() if prop.get('allowed') and candidate else None

    new_state = advance_state(
        state,
        market_ids,
        bool(bb.get('allowed')),
        bool(prop.get('allowed')),
        prop.get('normalizedQuestion'),
    )
    report = {'billboard': bb, 'proposal': prop}
    return billboard_post, proposal_post, report, new_state


def decide(event: MarketEvent, identity: AgentIdentity, binding: OwnerBinding | None, policy: AgentPolicy, observation: Observation, state: PolicyState | None = None, config: PolicyConfig = DEFAULT_CONFIG) -> dict[str, Any]:
    identity_error = validate_identity(identity, binding)
    if identity_error:
        return {
            'agentId': identity.agentId,
            'eventId': event.eventId,
            'ok': False,
            'reason': f'identity check failed: {identity_error}',
            'tradeActions': [{'type': 'hold', 'reason': f'identity check failed: {identity_error}'}],
            'billboardPost': None,
            'executor': {'mode': 'dry_run', 'identityStatus': identity_error},
        }
    if not policy.enabled:
        return {'agentId': identity.agentId, 'eventId': event.eventId, 'ok': True, 'reason': 'policy disabled', 'tradeActions': [{'type': 'hold', 'reason': 'policy disabled'}], 'billboardPost': None}

    actions: list[dict[str, Any]] = []
    reasons: list[str] = []
    for market in observation.markets:
        if should_skip_market(policy, market, event):
            continue
        fv = fair_value(policy, market)
        market_actions = take_orders(policy, observation, market, fv)
        if not market_actions:
            market_actions = take_profit(policy, observation, market, fv)
        if not market_actions:
            market_actions = quote_orders(policy, observation, market, fv)
        if market_actions:
            reasons.append(f'{market.marketId}: fair={fmt(fv)} actions={len(market_actions)}')
            actions.extend(market_actions)
        if len(actions) >= 6:
            break

    if not actions:
        actions = [{'type': 'hold', 'reason': 'no edge after deterministic policy checks'}]
    stamped = [{**action, 'actionId': action_id(event, identity.agentId, action, i)} for i, action in enumerate(actions[:8])]

    # Deterministic non-trading action policy: gate + sanitize billboard and
    # proposal, advancing the per-agent policy state (cooldowns/budget/dedup).
    policy_state = state if state is not None else PolicyState()
    billboard, proposal, report, new_state = _apply_action_policy(
        event, identity, policy, observation, stamped, policy_state, config
    )
    return {
        'agentId': identity.agentId,
        'eventId': event.eventId,
        'at': now_iso(),
        'ok': True,
        'reason': '; '.join(reasons) or 'deterministic policy hold',
        'tradeActions': stamped,
        'billboardPost': billboard,
        'marketProposal': proposal,
        'policy': report,
        'policyState': new_state.to_json(),
        'executor': {'mode': 'dry_run', 'daemonAddress': identity.address, 'shadowAccount': identity.shadowAccount},
    }
