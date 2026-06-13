# DarkBox debug/bastion sshd image — used two ways:
#   (a) the standalone debug CVM = public SSH entry point into the mesh, and
#   (b) a mesh-only sshd sidecar on each member CVM (shell access over the mesh).
#
# Key-only root login. The authorized PUBLIC keys are NOT baked in — they arrive at
# runtime via the sealed AUTHORIZED_KEYS env (newline-separated), so no key material
# ever lives in the image or the repo. If AUTHORIZED_KEYS is empty the box is
# locked (fail-closed: prohibit-password + no keys ⇒ nobody can log in).
#
# Ships `cast` + curl + jq + iproute2/dnsutils so an operator can poke geth / the
# indexer / signer over the mesh (10.13.x.x) from the shell.
#
# SECURITY: this container deliberately does NOT mount the `agentsock` volume, so it
# cannot reach the cluster-mesh-agent CSK gRPC — it only gets the shared netns. It's
# a DEBUG capability and should be stripped before the mesh holds real funds.
FROM ghcr.io/foundry-rs/foundry:latest AS foundry

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server curl jq ca-certificates iproute2 dnsutils netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*
# `cast` for hidden-chain debugging (cast block-number / cast call against geth).
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast
COPY sshd-debug-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
 && mkdir -p /root/.ssh /run/sshd \
 && chmod 700 /root/.ssh \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/'            /etc/ssh/sshd_config \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/'          /etc/ssh/sshd_config \
 && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/'              /etc/ssh/sshd_config \
 && sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
