# ── Stage 1: Install dependencies ────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

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

RUN addgroup -g 1001 -S umg && adduser -S umg -u 1001

WORKDIR /app

# Copy production deps
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled JS
COPY --from=build /app/dist ./dist

# Copy package.json (needed for version info)
COPY package.json ./

# Copy default accounts config from build stage (if present).
# The shell conditional avoids failure when the file doesn't exist.
RUN mkdir -p /app/config
RUN --mount=from=build,source=/app/src/infrastructure/config,target=/tmp/acfg \
    if [ -f /tmp/acfg/accounts.yaml ]; then cp /tmp/acfg/accounts.yaml /app/config/; fi

# Create writable data directory for runtime state (webhook configs, etc.)
RUN mkdir -p /app/data && chown umg:umg /app/data
VOLUME /app/data

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info \
    ACCOUNTS_CONFIG_PATH=/app/config/accounts.yaml

EXPOSE 3000

USER umg

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
