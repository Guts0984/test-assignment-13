# API image. Build from the repository root:  docker build -f apps/api/Dockerfile .
FROM node:24-alpine
RUN npm install -g pnpm@12.6.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/payment-stub/package.json packages/payment-stub/
COPY packages/platform/package.json packages/platform/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@auction/api..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/domain packages/domain
COPY packages/payment-stub packages/payment-stub
COPY packages/platform packages/platform
COPY apps/api apps/api
RUN pnpm --filter "@auction/api..." build
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
