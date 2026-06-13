from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

Outcome = Literal['YES', 'NO']
Side = Literal['buy', 'sell']
EventType = Literal['market_created', 'orderbook_changed', 'own_order_filled', 'user_whisper', 'policy_updated', 'tick']


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def fmt(value: float) -> str:
    safe = 0.0 if value != value else value
    return f'{safe:.4f}'.rstrip('0').rstrip('.') or '0'


@dataclass(frozen=True)
class Market:
    marketId: str
    question: str
    status: str = 'open'
    bestBid: float | None = None
    bestAsk: float | None = None
    lastPrice: float | None = None

    @staticmethod
    def from_json(raw: dict[str, Any]) -> 'Market':
        def opt_float(key: str) -> float | None:
            value = raw.get(key)
            if value is None or value == '':
                return None
            return float(value)

        return Market(
            marketId=str(raw['marketId']),
            question=str(raw.get('question', 'Unknown market')),
            status=str(raw.get('status', 'open')),
            bestBid=opt_float('bestBid'),
            bestAsk=opt_float('bestAsk'),
            lastPrice=opt_float('lastPrice'),
        )


@dataclass(frozen=True)
class Order:
    orderId: str
    marketId: str
    agentId: str
    side: Side
    outcome: Outcome
    price: float
    remainingSize: float

    @staticmethod
    def from_json(raw: dict[str, Any]) -> 'Order':
        return Order(
            orderId=str(raw['orderId']),
            marketId=str(raw['marketId']),
            agentId=str(raw.get('agentId', 'unknown')),
            side=raw['side'],
            outcome=raw['outcome'],
            price=float(raw['price']),
            remainingSize=float(raw.get('remainingSize', raw.get('size', 0))),
        )


@dataclass(frozen=True)
class Position:
    marketId: str
    outcome: Outcome
    size: float
    avgEntry: float

    @staticmethod
    def from_json(raw: dict[str, Any]) -> 'Position':
        return Position(str(raw['marketId']), raw['outcome'], float(raw['size']), float(raw['avgEntry']))


@dataclass(frozen=True)
class Portfolio:
    cash: float = 0
    equity: float = 0
    positions: tuple[Position, ...] = ()

    @staticmethod
    def from_json(raw: dict[str, Any] | None) -> 'Portfolio':
        if not raw:
            return Portfolio()
        return Portfolio(
            cash=float(raw.get('cash', 0)),
            equity=float(raw.get('equity', raw.get('cash', 0))),
            positions=tuple(Position.from_json(item) for item in raw.get('positions', [])),
        )


@dataclass(frozen=True)
class AgentIdentity:
    agentId: str
    address: str
    shadowAccount: str

    @staticmethod
    def from_json(raw: dict[str, Any]) -> 'AgentIdentity':
        return AgentIdentity(str(raw['agentId']), str(raw['address']), str(raw['shadowAccount']))


@dataclass(frozen=True)
class OwnerBinding:
    gameId: str
    owner: str
    agentId: str
    daemonAddress: str
    shadowAccount: str
    status: str = 'pending_onchain'

    @staticmethod
    def from_json(raw: dict[str, Any]) -> 'OwnerBinding':
        return OwnerBinding(
            gameId=str(raw['gameId']),
            owner=str(raw['owner']),
            agentId=str(raw['agentId']),
            daemonAddress=str(raw['daemonAddress']),
            shadowAccount=str(raw['shadowAccount']),
            status=str(raw.get('status', 'pending_onchain')),
        )


@dataclass(frozen=True)
class AgentPolicy:
    agentId: str
    enabled: bool = True
    maxOrderSize: float = 3.0
    maxPositionSize: float = 20.0
    maxOpenOrdersPerMarket: int = 2
    minEdgeToTake: float = 0.08
    quoteSpread: float = 0.08
    quoteSize: float = 2.0
    takeProfitEdge: float = 0.10
    cancelDistance: float = 0.16
    cooldownMs: int = 750
    fairValues: dict[str, float] = field(default_factory=dict)
    marketBias: dict[str, float] = field(default_factory=dict)
    preferredMarkets: tuple[str, ...] = ()
    bannedMarkets: tuple[str, ...] = ()
    billboardStyle: str = 'concise market-making signal'

    @staticmethod
    def from_json(agent_id: str, raw: dict[str, Any] | None) -> 'AgentPolicy':
        raw = raw or {}
        return AgentPolicy(
            agentId=agent_id,
            enabled=bool(raw.get('enabled', True)),
            maxOrderSize=float(raw.get('maxOrderSize', 3.0)),
            maxPositionSize=float(raw.get('maxPositionSize', 20.0)),
            maxOpenOrdersPerMarket=int(raw.get('maxOpenOrdersPerMarket', 2)),
            minEdgeToTake=float(raw.get('minEdgeToTake', 0.08)),
            quoteSpread=float(raw.get('quoteSpread', 0.08)),
            quoteSize=float(raw.get('quoteSize', 2.0)),
            takeProfitEdge=float(raw.get('takeProfitEdge', 0.10)),
            cancelDistance=float(raw.get('cancelDistance', 0.16)),
            cooldownMs=int(raw.get('cooldownMs', 750)),
            fairValues={str(k): clamp(float(v), 0.01, 0.99) for k, v in dict(raw.get('fairValues', {})).items()},
            marketBias={str(k): float(v) for k, v in dict(raw.get('marketBias', {})).items()},
            preferredMarkets=tuple(str(v) for v in raw.get('preferredMarkets', [])),
            bannedMarkets=tuple(str(v) for v in raw.get('bannedMarkets', [])),
            billboardStyle=str(raw.get('billboardStyle', 'concise market-making signal')),
        )


@dataclass(frozen=True)
class MarketEvent:
    eventId: str
    type: EventType
    at: str
    marketId: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def from_json(raw: dict[str, Any]) -> 'MarketEvent':
        return MarketEvent(
            eventId=str(raw.get('eventId', f"event-{now_iso()}")),
            type=raw.get('type', 'tick'),
            at=str(raw.get('at', now_iso())),
            marketId=raw.get('marketId'),
            payload=dict(raw.get('payload', {})),
        )


@dataclass(frozen=True)
class Observation:
    markets: tuple[Market, ...]
    orders: tuple[Order, ...]
    portfolio: Portfolio

    @staticmethod
    def from_json(raw: dict[str, Any]) -> 'Observation':
        return Observation(
            markets=tuple(Market.from_json(item) for item in raw.get('markets', [])),
            orders=tuple(Order.from_json(item) for item in raw.get('orders', [])),
            portfolio=Portfolio.from_json(raw.get('portfolio')),
        )
