# ─── Stage 1: Build ────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Stage 2: Production ──────────────────────────────────────
FROM node:18-alpine

# Run as non-root for security
RUN addgroup -S mirrorproxy && adduser -S mirrorproxy -G mirrorproxy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Drop privileges
USER mirrorproxy

EXPOSE 4040 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4040/health || exit 1

CMD ["node", "dist/index.js"]
