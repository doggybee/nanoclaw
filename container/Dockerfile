# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
# Clean up docs, icons, DRI drivers, and OpenType CJK fonts (keep TrueType only)
# to reduce image size by ~160MB
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
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
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/* \
              /usr/share/doc/* \
              /usr/share/icons/* \
              /usr/lib/x86_64-linux-gnu/dri/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally, clean npm cache
RUN npm install -g agent-browser @anthropic-ai/claude-code && npm cache clean --force

# Install RTK (token-saving CLI proxy) — single static binary
RUN RTK_ARCH=$(uname -m | sed 's/aarch64/aarch64-unknown-linux-gnu/;s/x86_64/x86_64-unknown-linux-musl/') \
    && curl -fsSL "https://github.com/rtk-ai/rtk/releases/latest/download/rtk-${RTK_ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin rtk \
    && chmod +x /usr/local/bin/rtk

# Install Bun runtime (required by QMD) to shared path accessible by all users
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Install QMD CLI (local search: BM25 + vector + LLM reranking)
RUN npm install -g @tobilu/qmd && npm cache clean --force

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
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

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
