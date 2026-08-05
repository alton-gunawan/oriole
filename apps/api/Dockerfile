# Oriole API — multi-stage build untuk Railway / Fly.io / Render
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# ── Install dependencies (frozen lockfile) ──────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile \
  --filter @oriole/api \
  --filter @oriole/config \
  --filter @oriole/database

# ── Runtime ────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY apps/api apps/api
COPY packages packages
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/index.ts"]
