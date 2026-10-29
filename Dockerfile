# Runtime-only image: migrations (and setup-databases.sh, which applies them)
# are included because the app checks that the database is current at startup,
# while DDL is deliberately run beforehand by the host's deploy script.
FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
# The AAPS guide the MCP tool get_algorithm_guide sends (src/analysis/guide.js).
COPY --chown=node:node docs ./docs
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node setup-databases.sh ./

USER node
EXPOSE 8084
CMD ["node", "--env-file-if-exists=.env", "src/server.js"]
