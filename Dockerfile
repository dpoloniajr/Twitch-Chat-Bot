# Twitch Chat Bot - Production Dockerfile
# Multi-stage build for smaller final image

# ==================== Build Stage ====================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for TypeScript)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ==================== Production Stage ====================
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy runtime files
COPY Excella.js ./
COPY account-manager.js ./
COPY token-generator.js ./
COPY dashboard/ ./dashboard/
COPY obs/ ./obs/

# Create directories for data persistence
RUN mkdir -p /app/dashboard/logs /app/dashboard/uploads && \
    chown -R botuser:botuser /app

# Switch to non-root user
USER botuser

# Environment variables
ENV NODE_ENV=production
ENV DASHBOARD_PORT=3001

# Expose ports
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Default command (can be overridden)
CMD ["npm", "run", "dev"]
