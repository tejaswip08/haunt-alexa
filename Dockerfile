# One container: MCP server (/mcp), simulator APIs (/api), and the web app.
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/firetales/package.json packages/firetales/
COPY packages/scene-fx/package.json packages/scene-fx/
COPY apps/server/package.json apps/server/
COPY apps/views/package.json apps/views/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build && npm run typecheck

ENV NODE_ENV=production
# No AWS keys in the image: on ECS the task role supplies credentials at runtime.
RUN chown -R node:node /app
USER node
EXPOSE 3001
# Run Node directly (not through npm) so ECS's SIGTERM reaches the server, which closes
# connections and exits 0; npm would report every routine stop as a failure.
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
