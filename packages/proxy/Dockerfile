FROM node:22-slim AS base
RUN npm install -g pnpm@9

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/proxy/package.json ./packages/proxy/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/proxy/node_modules ./packages/proxy/node_modules
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/proxy ./packages/proxy
RUN pnpm --filter @steadio/shared build
RUN pnpm --filter @steadio/proxy build

FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/proxy/package.json ./packages/proxy/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/proxy/dist ./packages/proxy/dist

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "packages/proxy/dist/server.js"]
