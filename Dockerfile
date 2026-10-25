# Build all workspaces with a consistent Node.js toolchain.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
COPY runner/package.json runner/package.json
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build
# Retain runtime dependencies only in deployed images.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS panel
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/backend/migrations ./backend/migrations
COPY --from=build --chown=node:node /app/frontend/dist ./frontend/dist
ENV NODEBASE_STATIC_DIR=/app/frontend/dist
USER node
EXPOSE 3001
CMD ["node", "backend/dist/server.js"]

# Runner is a separate, restricted service. Only this image receives the Docker socket.
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production RUNNER_HOST=0.0.0.0 RUNNER_PORT=3099
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/runner/package.json ./runner/package.json
COPY --from=build --chown=node:node /app/runner/dist ./runner/dist
USER node
EXPOSE 3099
CMD ["node", "runner/dist/server.js"]
