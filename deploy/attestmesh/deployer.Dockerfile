# One-shot DarkBox/Frontier contract deployer image.
# foundry (forge + cast) + main's packages/contracts (slimmed EIP-170-safe book +
# the 1% taker-fee DeployDarkBox). Built from the repo root context:
#   sudo docker build -f deploy/attestmesh/deployer.Dockerfile -t ghcr.io/teesql/darkbox-deployer:latest .
FROM ghcr.io/foundry-rs/foundry:latest
USER root
WORKDIR /app

# The contracts package (source + vendored slimmed frontier lib + DeployDarkBox).
COPY packages/contracts /app

# forge-std is gitignored; fetch it (same as the `setup` npm script).
RUN git config --global --add safe.directory '*' \
 && (test -d lib/forge-std || git clone --depth 1 https://github.com/foundry-rs/forge-std.git lib/forge-std)

# Pre-compile so the (slow, via_ir) build is baked into the image, not the deploy.
RUN forge build

COPY deploy/attestmesh/deployer-entrypoint.sh /usr/local/bin/deployer-entrypoint.sh
RUN chmod +x /usr/local/bin/deployer-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/deployer-entrypoint.sh"]
