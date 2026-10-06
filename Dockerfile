# Argus image. Build: docker compose build
FROM node:22-bookworm-slim

# git: shallow clones of the MRs under review; ripgrep: fast search for the review agents; ca-certificates: HTTPS to GitLab/Jira/model APIs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

# The two subscription CLIs (official packages). Pinned; bump deliberately.
ARG CLAUDE_CODE_VERSION=2
ARG CODEX_VERSION=0.160
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# Non-root `node` user (uid 1000). Directories are created owned by it BEFORE the volumes mount, so named volumes inherit that ownership.
# CLAUDE_CONFIG_DIR: with it set, Claude Code keeps EVERYTHING (credentials, settings, and the global state file .claude.json) inside that dir; without it
# .claude.json lives at $HOME/.claude.json, outside the volume, and a rebuilt container would lose login/onboarding state.
# CODEX_HOME: explicit so `codex login` and CodexEngine's auth.json source (the "real" codex home) are both the .codex volume.
ENV HOME=/home/node DATA_DIR=/data HOST=0.0.0.0 PORT=3000 CLAUDE_CONFIG_DIR=/home/node/.claude CODEX_HOME=/home/node/.codex
RUN mkdir -p /data /home/node/.claude /home/node/.codex /app && chown -R node:node /data /home/node /app
WORKDIR /app
USER node

# tsx (a devDependency) runs the TypeScript sources at runtime (`npm run web`), so install everything.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
# In-app guides (/docs/setup, /docs/guide, /docs/mr) are rendered from these at startup.
COPY --chown=node:node docs ./docs

VOLUME ["/data", "/home/node/.claude", "/home/node/.codex"]
EXPOSE 3000
CMD ["npm", "run", "web"]
