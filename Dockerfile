# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 can fall back to a source build when a prebuilt binary is not
# available for the target platform.
RUN apt-get update \
    && apt-get install --no-install-recommends -y g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ARG TARGETARCH

ENV NODE_ENV=production \
    HOME=/home/node \
    BASE_PROJECT_DIR=/projects

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
      bash \
      ca-certificates \
      curl \
      dnsutils \
      fd-find \
      findutils \
      g++ \
      gawk \
      gh \
      git \
      grep \
      iproute2 \
      iputils-ping \
      jq \
      lsof \
      make \
      netcat-openbsd \
      openssh-client \
      procps \
      python3 \
      python3-pip \
      ripgrep \
      rsync \
      sed \
      sqlite3 \
      tar \
      tree \
      unzip \
      wget \
      zip \
    && npm install --global --no-audit --no-fund bun pnpm \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && ln -s /usr/bin/pip3 /usr/local/bin/pip \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The Agent SDK ships a platform-specific Claude Code binary. Exposing it on
# PATH lets an operator run `claude login` in the same persistent home volume.
RUN case "$TARGETARCH" in \
      amd64) sdk_arch=x64 ;; \
      arm64) sdk_arch=arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && ln -s "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${sdk_arch}/claude" /usr/local/bin/claude \
    && mkdir -p /data /projects /home/node \
    && chown -R node:node /data /projects /home/node

USER node
WORKDIR /data

VOLUME ["/data", "/home/node"]

STOPSIGNAL SIGTERM
CMD ["node", "/app/dist/index.js"]
