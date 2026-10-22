FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build

ENV COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH \
    CI=true

RUN corepack enable pnpm \
 && corepack prepare pnpm@12.14.0 --activate

WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm db:generate \
 && pnpm build:shared \
 && pnpm --filter @trading/api build \
 && pnpm --filter @trading/api deploy --prod --legacy /out \
 && mkdir -p /out/dist \
 && cp -a apps/api/dist/. /out/dist/ \
 && for package in config contracts domain media; do \
      mkdir -p "/out/node_modules/@trading/${package}/dist"; \
      cp -an "packages/${package}/dist/." "/out/node_modules/@trading/${package}/dist/"; \
    done

FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
ENV NODE_ENV=production \
    RELEASE_MODE=production \
    PORT=10000
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
USER node
EXPOSE 10000
CMD ["node", "dist/main.js"]
