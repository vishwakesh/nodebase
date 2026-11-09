FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./package.json
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NODEBASE_AGENT_TOKEN_FILE=/var/lib/nodebase-agent/credentials.json
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /var/lib/nodebase-agent && chown node:node /var/lib/nodebase-agent && chmod 0700 /var/lib/nodebase-agent
USER node
VOLUME ["/var/lib/nodebase-agent"]
CMD ["node", "dist/agent.js"]
