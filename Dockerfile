# Shelvarr: one small image. The frontend is built once on the build
# machine's own architecture (it's static files) and copied into each target
# image; the server is TypeScript that Node 24 runs directly, and SQLite is
# built into Node, so there is no native module to compile for arm64.

FROM --platform=$BUILDPLATFORM node:24-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.web.json vite.config.ts tailwind.config.ts postcss.config.js ./
COPY web ./web
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8687 \
    DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=web-build /app/dist/web ./dist/web
# Runs as the image's unprivileged `node` user (uid 1000). The data volume
# holds the SQLite database: settings, API keys, people and the undo history.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

# Which release this is: shown in Settings and used by the update reminder.
# The release workflow passes the tag; a local build is "dev".
ARG SHELVARR_BUILD_VERSION=dev
ARG SHELVARR_REPO=OwenWright8/shelvarr
ENV SHELVARR_BUILD_VERSION=$SHELVARR_BUILD_VERSION \
    SHELVARR_REPO=$SHELVARR_REPO
LABEL org.opencontainers.image.title="Shelvarr" \
      org.opencontainers.image.description="Keeps an Audiobookshelf library tidy (Author/Book) and shared per person, without duplicate copies" \
      org.opencontainers.image.version=$SHELVARR_BUILD_VERSION \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/${SHELVARR_REPO}"

EXPOSE 8687
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8687/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
