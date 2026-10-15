FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM postgres:18-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.js ./
COPY backend ./backend
COPY lib ./lib
COPY scripts ./scripts
COPY database ./database
RUN curl --fail --silent --show-error https://truststore.pki.rds.amazonaws.com/us-west-2/us-west-2-bundle.pem -o /app/rds-ca.pem
USER postgres
EXPOSE 8081
CMD ["node", "scripts/aws/start-cloud.mjs"]
