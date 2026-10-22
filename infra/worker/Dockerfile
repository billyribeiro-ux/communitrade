FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS pinned_node
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

# Keep the agreed Node runtime while retaining the exact matching browser/system libraries.
COPY --from=pinned_node /usr/local/ /usr/local/
ENV COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH \
    PNPM_STORE_PATH=/pnpm/store \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CI=true
RUN corepack enable pnpm \
 && corepack prepare pnpm@12.14.0 --activate \
 && mkdir -p /workspace /pnpm/store /var/lib/options-trade-ideas/objects
WORKDIR /workspace
CMD ["pnpm", "--version"]
