# Twitch Chat Bot - Production Dockerfile
# Multi-stage build: compile TypeScript (server and browser code), then ship
# only the compiled output, static files and production dependencies.

# ==================== Build Stage ====================
FROM node:20-alpine AS builder

WORKDIR /app

# Install all dependencies (including dev for TypeScript)
COPY package*.json ./
RUN npm ci

# Copy sources and static files, then build:
# - src/ (bot, dashboard, token generator, lib) -> dist/
# - src/web/ (browser code) -> the .js files next to the pages in dashboard/public, public/ and obs/
COPY tsconfig.json tsconfig.web.json ./
COPY src/ ./src/
COPY dashboard/public/ ./dashboard/public/
COPY public/ ./public/
COPY obs/ ./obs/
RUN npm run build

# ==================== Production Stage ====================
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# Compiled server code and the pages with their compiled scripts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard/public ./dashboard/public
COPY --from=builder /app/public ./public
COPY --from=builder /app/obs ./obs

# Create directories for data persistence
RUN mkdir -p /app/dashboard/logs /app/dashboard/uploads /app/dashboard/cache /app/logs && \
    chown -R botuser:botuser /app

# Switch to non-root user
USER botuser

# Environment variables
ENV NODE_ENV=production
ENV DASHBOARD_PORT=3001
ENV DASHBOARD_HOST=0.0.0.0

# Expose ports
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/health || exit 1

# Runs the bot and the dashboard from dist/ (no build step at runtime)
CMD ["npm", "start"]
