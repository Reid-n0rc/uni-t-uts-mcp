FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
LABEL org.opencontainers.image.source="https://github.com/Reid-n0rc/uni-t-uts-mcp" \
      org.opencontainers.image.description="MCP server for UNI-T UTS series spectrum analyzers (SCPI over LAN)" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/build ./build
ENTRYPOINT ["node", "build/index.js"]
