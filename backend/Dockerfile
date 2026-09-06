# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for Prisma and native extensions
RUN apk add --no-cache openssl python3 make g++

COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies with npm cache mount
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY tsconfig.json ./
COPY src ./src/

RUN npx prisma generate
RUN npm run build

# Stage 2: Hardened, non-root production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install only essential runtime dependencies: FFmpeg, openssl, curl (for healthchecks), bash
RUN apk add --no-cache ffmpeg openssl curl bash && \
    rm -rf /var/cache/apk/*

ENV NODE_ENV=production
ENV PORT=4000

# Create dedicated non-root system user and group (UID/GID 10001)
RUN addgroup -g 10001 -S vigilone && \
    adduser -u 10001 -S vigilone -G vigilone

# Pre-create application and volume directories with correct ownership
RUN mkdir -p /recordings/corrupted /recordings/exports /etc/vigilone /app && \
    chown -R vigilone:vigilone /recordings /etc/vigilone /app

COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies only and generate Prisma client
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && \
    npx prisma generate && \
    chown -R vigilone:vigilone /app

# Copy compiled artifacts from builder stage
COPY --from=builder --chown=vigilone:vigilone /app/dist ./dist

# Switch to non-root user
USER vigilone:vigilone

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4000/api/v1/health || exit 1

CMD ["node", "dist/server.js"]
