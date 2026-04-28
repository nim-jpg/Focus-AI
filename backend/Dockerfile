# Focus3 backend — single-stage Node image for Fly.io / any container host.
FROM node:20-alpine AS build

WORKDIR /app

# Copy workspace manifests so npm install resolves the @focus3/backend workspace
# without needing the entire monorepo in the image.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/

RUN npm install --workspaces --include-workspace-root --omit=dev=false

COPY backend/ ./backend/
RUN npm --workspace backend run build

# ── Runtime ──────────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["node", "backend/dist/server.js"]
