# Use official Node.js image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files first (better cache)
COPY package*.json ./

# Install dependencies (production only)
RUN npm install --omit=dev

# Copy rest of the app
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Expose app port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]