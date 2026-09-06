# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY tsconfig*.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src/

RUN npm run build

# Stage 2: Distribution stage (copies static files to mounted shared volume)
FROM alpine:3.20 AS runner

WORKDIR /srv/frontend

RUN addgroup -g 10001 -S vigilone && \
    adduser -u 10001 -S vigilone -G vigilone

COPY --from=builder --chown=vigilone:vigilone /app/dist ./

USER vigilone:vigilone

CMD ["cp", "-r", "/srv/frontend/.", "/dist/"]
