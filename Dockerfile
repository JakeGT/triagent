# syntax=docker/dockerfile:1
# Two images from one Dockerfile:
#
#   docker build --target server -t triagent-server .   the API, MCP endpoint and webhooks, serving the web app
#   docker build --target runner -t triagent-runner .   runs Open Code Review; no database, no data volume
#
# Both run as the unprivileged `node` user. Node runs the TypeScript directly (type stripping), so there's
# no compile step for the server or the runner; only the web app is built.

ARG NODE_IMAGE=node:24.19.0-alpine3.24
# The Open Code Review release the runner uses (npm package @alibaba-group/open-code-review).
ARG OCR_VERSION=1.12.12

# ---- dependencies, from the lockfile -----------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---- the web app ---------------------------------------------------------------------------------
FROM deps AS web
COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @triagent/web build

# ---- the server's production dependencies only -------------------------------------------------------
FROM ${NODE_IMAGE} AS server-deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @triagent/server...

# ---- server ----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS server
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 WEB_DIST_DIR=/app/web
COPY --from=server-deps /src/node_modules ./node_modules
COPY --from=server-deps /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=server-deps /src/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared packages/shared
COPY apps/server/package.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/db apps/server/db
COPY --from=web /src/apps/web/dist /app/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "apps/server/src/main.ts"]

# ---- runner ----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
ARG OCR_VERSION
# git fetches the code; OCR is a static binary installed from npm at an exact version.
RUN apk add --no-cache git \
    && npm install --global --no-fund --no-audit "@alibaba-group/open-code-review@${OCR_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /var/cache/triagent-runner /tmp/triagent-runner \
    && chown node:node /var/cache/triagent-runner /tmp/triagent-runner
WORKDIR /app
COPY apps/runner/package.json ./
COPY apps/runner/src ./src
ENV NODE_ENV=production OCR_NO_UPDATE=1 \
    RUNNER_CACHE_DIR=/var/cache/triagent-runner RUNNER_WORK_DIR=/tmp/triagent-runner RUNNER_HEALTH_PORT=8081
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1
CMD ["node", "src/main.ts"]
