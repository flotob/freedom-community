# Reference steward. Build context: the repository root.
#   docker build -f apps/steward/Dockerfile .
# Configuration is all environment (see src/cli.ts); state lives in /data, which is only a
# cache: with an empty /data the steward replays its own ledger from Swarm on start.
FROM node:24.15.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol packages/protocol
COPY apps/steward apps/steward
# Only the two workspaces the steward needs; the lockfile still pins every version.
RUN npm install --omit=dev --no-audit --no-fund -w @freedom-community/protocol -w @freedom-community/steward \
 && npm cache clean --force \
 && mkdir /data && chown node:node /data
USER node
WORKDIR /app/apps/steward
ENV DATA_DIR=/data STATUS_PORT=8080
EXPOSE 8080
VOLUME /data
CMD ["node", "src/cli.ts", "run"]
