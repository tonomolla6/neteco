# syntax=docker/dockerfile:1.11
FROM node:24.18.1-alpine3.23 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

FROM dependencies AS build
COPY . .
RUN npm run postinstall && npm run build

FROM node:24.18.1-alpine3.23 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN apk add --no-cache ca-certificates tzdata curl \
  && addgroup -S -g 10001 neteco \
  && adduser -S -D -H -u 10001 -G neteco neteco \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=neteco:neteco /app/.output ./.output
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/health/live || exit 1
CMD ["node", ".output/server/index.mjs"]
