from __future__ import annotations

from hashlib import sha256
from typing import Any

from .models import AgentIdentity, AgentPolicy, Market, MarketEvent, Observation, Order, OwnerBinding, Position, clamp, fmt, now_iso


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


def decide(event: MarketEvent, identity: AgentIdentity, binding: OwnerBinding | None, policy: AgentPolicy, observation: Observation) -> dict[str, Any]:
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
    billboard = None
    if event.type in ('market_created', 'policy_updated', 'user_whisper') and reasons:
        billboard = {'message': f'{identity.agentId}: policy live; quoting {len(stamped)} actions around deterministic fair value.'[:280]}
    return {
        'agentId': identity.agentId,
        'eventId': event.eventId,
        'at': now_iso(),
        'ok': True,
        'reason': '; '.join(reasons) or 'deterministic policy hold',
        'tradeActions': stamped,
        'billboardPost': billboard,
        'executor': {'mode': 'dry_run', 'daemonAddress': identity.address, 'shadowAccount': identity.shadowAccount},
    }
