# 1. Base Image: Use a stable Node.js image based on Alpine Linux for a smaller size.
FROM node:20-alpine

# 2. Install Puppeteer Dependencies (CRITICAL STEP)
# Puppeteer needs Chromium and several system libraries to run in a headless environment.
# 'apk add' is the package manager for Alpine.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ghostscript

# 3. Configure Puppeteer Environment Variable
# This tells Puppeteer where to find the installed Chromium browser executable.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 4. Set Working Directory
# All subsequent commands will execute in this directory inside the container.
WORKDIR /app

# 5. Copy and Install Dependencies
# Copy only the package files first to leverage Docker's build cache.
COPY package*.json ./
RUN npm install

# 6. Copy Application Code
# Copy the rest of your application code (including index.js, Dockerfile, etc.)
COPY . .

# 7. Expose Port (Optional but good practice)
# While your app is a background worker, exposing a port is necessary for Back4App's deployment service.
EXPOSE 8080

# 8. Define the Startup Command
# This command runs when the container starts. It executes the 'start' script defined in your package.json.
CMD ["npm", "start"]