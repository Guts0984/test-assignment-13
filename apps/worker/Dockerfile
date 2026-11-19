# Worker image. It also serves the one-shot `infra-init` job (buckets, search index, placeholder
# photos). Build from the repository root:  docker build -f apps/worker/Dockerfile .
FROM node:24-alpine
RUN npm install -g pnpm@12.6.0
WORKDIR /repo

# Dependencies first, so editing source does not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/payment-stub/package.json packages/payment-stub/
COPY packages/platform/package.json packages/platform/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter "@auction/worker..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/domain packages/domain
COPY packages/payment-stub packages/payment-stub
COPY packages/platform packages/platform
COPY apps/worker apps/worker
# `...` builds every workspace dependency first, in dependency order.
RUN pnpm --filter "@auction/worker..." build

ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/dist/main.js"]
