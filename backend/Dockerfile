# Playwright's image ships Chromium + all system deps for headless automation.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .

EXPOSE 4000
CMD ["node", "--import", "tsx", "src/server.ts"]
