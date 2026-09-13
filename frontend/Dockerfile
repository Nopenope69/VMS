# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY tsconfig*.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src/

RUN npm run build

# Stage 2: Caddy Gateway with baked-in static SPA assets
FROM caddy:2.9-alpine AS runner

WORKDIR /srv/frontend

# Copy compiled static SPA assets into Caddy document root
COPY --from=builder /app/dist /srv/frontend

EXPOSE 80 443

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

