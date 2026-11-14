# One image runs all three jobs, chosen by the command:
#   node dist/index.js        the API (default)
#   node dist/worker.js       the background worker
#   node dist/db/migrate.js   apply database migrations
# In AWS, settings come from the environment and Secrets Manager (see src/secrets.ts).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# The database's TLS certificate is checked against Amazon's RDS certificate authorities.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca.pem
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
