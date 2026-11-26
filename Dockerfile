# ----- Builder -----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ----- Runtime -----
FROM node:20-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
# Create non-root user. /app/storage exists (owned by nodejs) BEFORE a volume is
# mounted there, so a fresh named volume inherits that owner and is writable.
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs \
  && mkdir -p /app/storage && chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/v1/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
