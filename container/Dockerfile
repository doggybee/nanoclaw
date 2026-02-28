# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and Agent Reach upstream tools globally
RUN npm install -g agent-browser @anthropic-ai/claude-code xreach-cli mcporter undici

# Install Bun runtime (required by QMD) to shared path accessible by all users
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Install QMD CLI (local search: BM25 + vector + LLM reranking)
RUN npm install -g @tobilu/qmd

# Install Python-based tools (yt-dlp for YouTube/Bilibili, feedparser for RSS)
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages yt-dlp feedparser

# Configure yt-dlp to use Node.js as JS runtime (required for YouTube)
RUN mkdir -p /etc/yt-dlp && echo "--js-runtimes node" > /etc/yt-dlp/config

# Configure mcporter with Exa search (free, no API key needed)
RUN mkdir -p /home/node/.mcporter && echo '{"mcpServers":{"exa":{"baseUrl":"https://mcp.exa.ai/mcp"}},"imports":[]}' > /home/node/.mcporter/mcporter.json

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/store /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# No bash entrypoint — pipe stdin directly to Node for faster cold start.
# Secrets arrive via stdin JSON; follow-up messages via IPC files in /workspace/ipc/input/.

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["node", "/app/dist/index.js"]
