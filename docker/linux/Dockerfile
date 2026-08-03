# Linux GUI acceptance container for TermHelm.
#
# Runs the demo:managed:* scripts and the native Linux integration tests under
# Xvfb + xterm so the managed terminal lifecycle (launch, replace, kill,
# detached supervisor) is exercised exactly as on a real desktop, without
# requiring a host display server.
#
# Build:  pnpm run test:linux:container:build
# Run:    pnpm run test:linux:container

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# TermHelm delegates to an installed graphical terminal emulator and uses
# bash/zsh for its private controller wrapper. The native Linux release gate
# also probes dash and fish as target shells. xterm is the verified adapter
# used in CI; Xvfb provides the virtual display the emulator attaches to.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      xvfb \
      xterm \
      x11-utils \
      bash \
      zsh \
      dash \
      fish \
      procps \
      psmisc \
 && rm -rf /var/lib/apt/lists/*

# pnpm ships through corepack in Node 20.
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app

# Copy only manifests first so dependency installation is cacheable.
COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json tsconfig.public-api.json ./
COPY native ./native
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy the rest of the source tree.
COPY src ./src
COPY test ./test
COPY examples ./examples
COPY README.md LICENSE ./

ENV TERMHELM_LINUX_GUI_TEST=1 \
    DISPLAY=:99 \
    TERM=xterm

# The entrypoint starts Xvfb, waits for it, builds the package, then runs the
# managed demo flow plus the native Linux integration tests.
COPY docker/linux/test-managed.sh /usr/local/bin/test-managed.sh
RUN chmod +x /usr/local/bin/test-managed.sh

ENTRYPOINT ["/usr/local/bin/test-managed.sh"]
