# VigilOne AI worker (ai-adapter.v1). Build from the repository root:
#   docker build -f services/ai-worker/Dockerfile -t vigilone-ai-worker .
# glibc base: onnxruntime-node ships CPU binaries for linux-x64/arm64 glibc, not musl.

FROM node:20-bookworm-slim AS builder
WORKDIR /build
COPY services/ai-worker/package.json services/ai-worker/package-lock.json ./
# CPU binaries are bundled in the npm package; skip the optional CUDA download (no egress needed).
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN --mount=type=cache,target=/root/.npm npm ci
COPY services/ai-worker/tsconfig.json services/ai-worker/tsconfig.build.json ./
COPY services/ai-worker/src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:20-bookworm-slim AS runner
# ffmpeg/ffprobe decode the MediaMTX loopback stream (subprocess boundary, see THIRD_PARTY_LICENSES.md).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 vigilone && useradd -u 10001 -g vigilone -M -s /usr/sbin/nologin vigilone
WORKDIR /app
ENV NODE_ENV=production \
    ONNXRUNTIME_NODE_INSTALL=skip \
    VIGILONE_MODELS_DIR=/models \
    VIGILONE_MODEL_LOCK=/app/models.lock.json \
    AI_ADAPTER_HOST=127.0.0.1 \
    AI_ADAPTER_PORT=7010
COPY services/ai-worker/package.json services/ai-worker/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev && npm cache clean --force
COPY --from=builder /build/dist ./dist
COPY scripts/models/models.lock.json /app/models.lock.json
# ANPR pipeline definitions (their SHA-256 is the pipeline hash in provenance).
COPY scripts/models/pipelines /app/pipelines
# Code is root-owned and read-only for the service user; models arrive on a read-only volume.
USER vigilone:vigilone
EXPOSE 7010
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AI_ADAPTER_PORT||7010)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
