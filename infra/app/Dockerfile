FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

ENV COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH \
    PNPM_STORE_PATH=/pnpm/store \
    CI=true

RUN corepack enable \
 && corepack prepare pnpm@12.14.0 --activate \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 openssl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace /pnpm/store /var/lib/options-trade-ideas/objects

WORKDIR /workspace

# Project source and node_modules are mounted by Compose for local development.
CMD ["pnpm", "--version"]
