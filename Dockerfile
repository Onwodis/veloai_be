# syntax=docker/dockerfile:1.7
#
# API + media worker: one multi-stage production image.
#   deps    → install all deps (Prisma client for linux-musl, ffmpeg-static binaries)
#   build   → compile TypeScript, copy the studio SQL migrations into dist, prune
#   runtime → minimal, non-root image with fonts for burned-in captions
#
# The same image runs three ways (see ../docker-compose.yml):
#   API      node dist/server.js            (default CMD)
#   worker   node dist/worker.js            (reels + AI studio + likeness + creations)
#   migrate  sh -c "pnpm exec prisma migrate deploy && node dist/scripts/studio-migrate.js"
#
# Configuration comes only from the environment (env_file: ./be/.env in compose);
# no .env file is baked into the image (see .dockerignore).

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache openssl libc6-compat \
 && corepack enable
WORKDIR /app
ENV PNPM_HOME=/pnpm \
    CI=true

FROM base AS deps
# argon2 compiles from source if no musl prebuild matches.
RUN apk add --no-cache --virtual .build python3 make g++
COPY package.json pnpm-lock.yaml prisma.config.ts ./
COPY src/models/schema.prisma ./src/models/schema.prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
# tsc doesn't copy .sql files: the studio migrations must ship next to the compiled migrator.
RUN pnpm exec tsc -p tsconfig.json \
 && mkdir -p dist/studio/migrations \
 && cp src/studio/migrations/*.sql dist/studio/migrations/ \
 && pnpm prune --prod --ignore-scripts

FROM base AS runtime
# Fonts for libass (burned-in captions and on-screen text) and fontconfig to find them.
RUN apk add --no-cache fontconfig ttf-dejavu font-noto font-noto-emoji \
 && fc-cache -f
ENV NODE_ENV=production \
    PORT=4000 \
    TMPDIR=/tmp
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json prisma.config.ts ./
COPY --chown=node:node src/models/schema.prisma ./src/models/schema.prisma
COPY --chown=node:node src/models/migrations ./src/models/migrations
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health/live || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/server.js"]
