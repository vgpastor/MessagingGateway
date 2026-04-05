# ── Stage 1: Install dependencies ────────────────────────────────
FROM node:22-alpine AS deps

# Native dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: Build TypeScript ────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

RUN npm run build

# ── Stage 3: Production image ───────────────────────────────────
FROM node:22-alpine AS production

LABEL org.opencontainers.image.title="Unified Messaging Gateway" \
      org.opencontainers.image.description="Single point of contact for all messaging integrations" \
      org.opencontainers.image.source="https://github.com/vgpastor/MessagingGateway"

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/data
VOLUME /app/data

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info \
    ACCOUNTS_CONFIG_PATH=/app/data/accounts.yaml

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
