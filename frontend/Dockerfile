FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src/

RUN npm run build

FROM alpine:3.20 AS runner
WORKDIR /srv/frontend
COPY --from=builder /app/dist ./
CMD ["cp", "-r", "/srv/frontend/.", "/dist/"]
