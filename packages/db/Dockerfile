# One-shot container: migrate → create the restricted app role → seed (once).
# Build from the repository root:  docker build -f packages/db/Dockerfile .
FROM node:24-alpine
RUN npm install -g pnpm@12.6.0
WORKDIR /repo

# Dependencies first, so editing source does not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter "@auction/db..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
RUN pnpm --filter @auction/shared build && pnpm --filter @auction/db build

ENV NODE_ENV=production
USER node
CMD ["node", "packages/db/dist/cli.js", "init"]
