from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .models import AgentIdentity, AgentPolicy, MarketEvent, Observation, OwnerBinding
from .strategy import decide


def read_json(path: Path) -> Any:
    with path.open() as f:
        return json.load(f)


def load_identities(path: Path) -> dict[str, AgentIdentity]:
    data = read_json(path)
    return {item['agentId']: AgentIdentity.from_json(item) for item in data.get('agents', [])}


def load_bindings(path: Path) -> dict[str, OwnerBinding]:
    if not path.exists():
        return {}
    data = read_json(path)
    return {item['agentId']: OwnerBinding.from_json(item) for item in data.get('bindings', [])}


def load_policy(policy_dir: Path, agent_id: str) -> AgentPolicy:
    path = policy_dir / f'{agent_id}.json'
    raw = read_json(path) if path.exists() else {}
    return AgentPolicy.from_json(agent_id, raw)


def main() -> None:
    parser = argparse.ArgumentParser(description='Run deterministic DarkBox agents for one market event.')
    parser.add_argument('--event', required=True, help='JSON event file')
    parser.add_argument('--observation', required=True, help='JSON observation file')
    parser.add_argument('--identities', default='services/agents/config/agent-identities.json')
    parser.add_argument('--bindings', default='services/agents/config/owner-daemon-bindings.json')
    parser.add_argument('--policy-dir', default='services/agents/policies')
    parser.add_argument('--agent', action='append', default=[], help='Agent id to run; repeatable. Defaults to all identities with binding rows, or all identities if no binding file exists.')
    parser.add_argument('--out', default='-', help='JSONL output path or - for stdout')
    args = parser.parse_args()

    identities = load_identities(Path(args.identities))
    bindings = load_bindings(Path(args.bindings))
    event = MarketEvent.from_json(read_json(Path(args.event)))
    observation = Observation.from_json(read_json(Path(args.observation)))
    if args.agent:
        agent_ids = args.agent
    elif bindings:
        agent_ids = list(bindings.keys())
    else:
        agent_ids = list(identities.keys())

    lines: list[str] = []
    for agent_id in agent_ids:
        identity = identities.get(agent_id)
        if identity is None:
            continue
        policy = load_policy(Path(args.policy_dir), agent_id)
        result = decide(event, identity, bindings.get(agent_id), policy, observation)
        lines.append(json.dumps(result, separators=(',', ':')))

    if args.out == '-':
        print('\n'.join(lines))
    else:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open('a') as f:
            for line in lines:
                f.write(line + '\n')


if __name__ == '__main__':
    main()
