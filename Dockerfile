# Use a lightweight but capable base image (Node.js 20 on Alpine)
FROM node:20-alpine

# Install necessary system dependencies for Puppeteer (Chromium)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ghostscript

# Set Puppeteer's executable path to the installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy your application code
COPY . .

# Expose the port used by the Express server
EXPOSE 8080

# The command to start your application
CMD ["npm", "start"]