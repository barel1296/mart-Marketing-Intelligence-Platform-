# syntax=docker/dockerfile:1

# One image serves the API, the worker, the migration runner, the fixture
# provider and the web app. They are the same workspace and differ only in the
# command compose gives them, so building five images would only mean building
# the same TypeScript five times.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV CI=true
# corepack asks for confirmation before downloading the pinned pnpm, and a
# build has no TTY to answer with.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests first, so a source change does not re-resolve the dependency graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY packages/metrics/package.json packages/metrics/
COPY packages/observability/package.json packages/observability/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
# Next.js freezes rewrite destinations into .next/routes-manifest.json at build
# time; `next start` reads that manifest and never re-evaluates the config. So
# the API's address has to be correct HERE, not only in the runtime environment.
# The default matches the compose service name.
ARG MART_API_INTERNAL_URL=http://api:4000
ENV MART_API_INTERNAL_URL=${MART_API_INTERNAL_URL}
# Workspace packages resolve to dist/, so nothing can start until this runs.
# This also produces the Next.js production build the web service serves.
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# The whole built tree, including pnpm's symlinked node_modules. The symlinks
# are relative, so copying to the same path keeps them valid.
COPY --from=builder /app /app

COPY docker/entrypoint.sh /usr/local/bin/mart-entrypoint
RUN chmod +x /usr/local/bin/mart-entrypoint

ENTRYPOINT ["/usr/local/bin/mart-entrypoint"]
CMD ["node", "apps/api/dist/server.js"]
