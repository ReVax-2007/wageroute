# WageRoute desktop in a container: the app is built for Linux inside the image,
# then its window is streamed to a browser port over noVNC. It is not a web app —
# the renderer talks to a preload IPC bridge with no HTTP server behind it — so
# what reaches the browser is the real Electron window, pixels and all.
#
#   docker build -f docker/desktop.Dockerfile -t wageroute-desktop .
#   docker run --rm --shm-size=1g -p 127.0.0.1:6080:6080 -v wageroute-data:/data wageroute-desktop
#   open http://localhost:6080/vnc.html?autoconnect=true
#
# Read the limits before using this with a real ledger:
# docs/DEPLOYMENT.md#the-desktop-in-a-container.

FROM node:24-bookworm AS build
WORKDIR /app

# A compiler and Python are the fallback, not the normal path: the SQLite driver
# ships a prebuilt N-API binary for linux-x64/linux-arm64, so nothing here compiles
# it today. They stay because that prebuild is the only thing standing between this
# image and a source build on a platform the fork does not ship, and electron-builder
# would need them the moment it has to produce one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.node.json electron.vite.config.ts electron-builder.yml ./
COPY build ./build
COPY scripts ./scripts
COPY src ./src
# extraResources reads the licence from the context; the notices file is
# regenerated from the lockfile by npm run build.
COPY LICENSE ./
# electron-builder names the unpacked folder after the architecture it built for
# (`linux-arm64-unpacked`, `linux-x64-unpacked`, `linux-unpacked`), so the runtime
# stage reads one predictable path instead of guessing the host's arch.
RUN npm run build \
  && npx electron-builder --linux --dir \
  && SRC=$(find /app/release -maxdepth 1 -type d -name '*-unpacked' | head -1) \
  && test -n "$SRC" \
  && mv "$SRC" /app/artifacts

FROM debian:bookworm-slim

# The runtime libraries Electron 45 loads, the X server and VNC bridge the window
# travels through, and supervisor to keep all four running.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-dejavu-core \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdrm2 \
    libegl1 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    x11vnc \
    xvfb \
    novnc \
    websockify \
    supervisor \
    procps \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/artifacts /opt/wageroute
# electron-builder names the Linux executable after the sanitised product name,
# which is lowercase. Assert it here rather than ship a container whose window
# never opens.
RUN test -x /opt/wageroute/wageroute || { ls -l /opt/wageroute && exit 1; }

COPY docker/desktop.entrypoint.sh /usr/local/bin/wageroute-entrypoint
COPY docker/desktop.supervisord.conf /etc/supervisor/conf.d/wageroute.conf
RUN chmod +x /usr/local/bin/wageroute-entrypoint

# Everything the app writes lives under HOME, and HOME is the volume: the ledger,
# its ledger.key.json when encryption is on, its settings, its crash log and the
# daily backups the app keeps for itself. A keyed ledger without its key file in
# this same volume is a ledger nothing can open.
ENV HOME=/data \
    DISPLAY=:99 \
    WAGEROUTE_SCREEN=1440x900x24

VOLUME /data
EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/wageroute-entrypoint"]
