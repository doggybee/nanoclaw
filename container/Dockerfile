# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Docker containers

FROM node:22-slim

# Install system dependencies and fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    curl \
    git \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/icons/*

# Install claude-code globally, clean npm cache
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Install RTK (token-saving CLI proxy) — single static binary
RUN RTK_ARCH=$(uname -m | sed 's/aarch64/aarch64-unknown-linux-gnu/;s/x86_64/x86_64-unknown-linux-musl/') \
    && curl -fsSL "https://github.com/rtk-ai/rtk/releases/latest/download/rtk-${RTK_ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin rtk \
    && chmod +x /usr/local/bin/rtk

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
