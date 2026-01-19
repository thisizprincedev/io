# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci --only=production

# Generate Prisma client
RUN npx prisma generate

# Create health check script
RUN echo '#!/bin/sh\n\
node -e '\''const http = require("http");\
const options = {\
  hostname: "localhost",\
  port: 3000,\
  path: "/api/health",\
  timeout: 5000\
};\
const req = http.request(options, (res) => {\
  if (res.statusCode === 200) {\
    process.exit(0);\
  } else {\
    console.error(`Health check failed: ${res.statusCode}`);\
    process.exit(1);\
  }\
});\
req.on("error", (err) => {\
  console.error(`Health check error: ${err.message}`);\
  process.exit(1);\
});\
req.end();'\''\
' > /app/healthcheck.sh && chmod +x /app/healthcheck.sh

# Copy source code
COPY . .

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install dumb-init to handle signals properly
RUN apk add --no-cache dumb-init openssl

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files and node_modules from builder
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/healthcheck.sh ./

# Copy application files
COPY --from=builder /app/server.js ./
COPY --from=builder /app/.env ./

# Ensure the user has write access to necessary directories
RUN mkdir -p /app/logs && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD sh healthcheck.sh

# Use dumb-init to run node process
ENTRYPOINT ["dumb-init", "--"]

# Default command
CMD ["node", "server.js"]