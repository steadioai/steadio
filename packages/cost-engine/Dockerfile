FROM node:22-slim AS base
RUN npm install -g pnpm@9

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/cost-engine/package.json ./packages/cost-engine/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/cost-engine/node_modules ./packages/cost-engine/node_modules
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/cost-engine ./packages/cost-engine
RUN pnpm --filter @elevation/shared build
RUN pnpm --filter @elevation/cost-engine build

FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/cost-engine/package.json ./packages/cost-engine/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/cost-engine/dist ./packages/cost-engine/dist

ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "packages/cost-engine/dist/server.js"]
