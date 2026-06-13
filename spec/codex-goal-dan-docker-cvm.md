You are Codex working in /home/xiko/darkbox with --yolo.

Goal: Prepare DarkBox Docker/CVM packaging and documentation for Dan's morning handover.

Read first:
- handover/dan/00_FRAN_INSTRUCTIONS.md
- README.md
- docs/TECH_SPEC.md
- docker-compose.yml
- all service READMEs and package.json files

Priorities:
1. Ensure every service that needs CVM/deployment shape has a Dockerfile or explicit documented gap.
2. Keep services wired correctly across hidden_net, public_net, and egress_net.
3. Add/adjust only safe isolated Docker/compose/docs files; do not disturb active Telegram UI or agent runtime code unless absolutely required for container build metadata.
4. Document exactly how to run a local dockerized smoke outside CVM and how to kill/cleanup it.
5. Document how this maps to Phala/CVM, especially transcriber and signer security boundaries.
6. Write findings and commands to handover/dan/workstreams/DOCKER_CVM_PLAN.md.

Constraints:
- Do not push.
- Do not stage unrelated dirty files.
- Avoid secrets in files.
- If builds/tests are too heavy, run docker compose config and targeted build/config checks, then document blockers.
- Preserve other agents' dirty work.

Success criteria:
- handover/dan/workstreams/DOCKER_CVM_PLAN.md is complete enough for Dan's agent.
- Any missing Dockerfile/compose gaps are either fixed safely or called out explicitly.
- Networking and CVM/Phala notes are concrete.
