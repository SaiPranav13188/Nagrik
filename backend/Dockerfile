# Playwright's image ships Chromium + all system deps for headless automation.
# Used by both Render and AWS ECS Fargate.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=4000

COPY --chown=pwuser:pwuser package*.json ./
RUN npm ci --ignore-scripts
COPY --chown=pwuser:pwuser . .
# The app writes local data (uploads, temp files) under /app/.data, so the app user must own /app.
RUN mkdir -p /app/.data && chown -R pwuser:pwuser /app

# Run as the non-root user that the Playwright image provides.
USER pwuser

EXPOSE 4000
# Container health check without curl: Node is always present.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
