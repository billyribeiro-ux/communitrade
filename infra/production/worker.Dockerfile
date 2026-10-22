FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS pinned_node

# This exact Playwright image supplies Chromium and its system libraries. Copy
# the repository-pinned Node runtime into it for both build and runtime stages.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f AS build
COPY --from=pinned_node /usr/local/ /usr/local/
ENV COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH \
    PNPM_STORE_PATH=/pnpm/store \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CI=true
RUN corepack enable pnpm \
 && corepack prepare pnpm@12.14.0 --activate

WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build:shared \
 && pnpm --filter @trading/worker build \
 && pnpm --filter @trading/worker deploy --prod --legacy /out \
 && mkdir -p /out/dist \
 && cp -a apps/worker/dist/. /out/dist/ \
 && for package in config domain media; do \
      mkdir -p "/out/node_modules/@trading/${package}/dist"; \
      cp -an "packages/${package}/dist/." "/out/node_modules/@trading/${package}/dist/"; \
    done

FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f AS runtime
COPY --from=pinned_node /usr/local/ /usr/local/
ENV NODE_ENV=production \
    RELEASE_MODE=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /out/ ./
USER pwuser
CMD ["node", "dist/main.js"]
