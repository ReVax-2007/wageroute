# WageRoute Pocket as a container: build the static phone app from source, then
# serve the folder it writes. Nothing else runs — there is no backend, no
# environment and no secret, and the ledger never becomes a request.
#
#   docker build -f docker/pocket.Dockerfile -t wageroute-pocket .
#   docker run --rm -p 127.0.0.1:8173:80 wageroute-pocket
#   open http://localhost:8173
#
# The two stages keep the runtime down to nginx plus the app's own files: no
# Node, no toolchain, no source.

FROM node:24-alpine AS build
WORKDIR /app

# The lockfile lands first so a source-only change reuses the installed toolchain.
COPY package.json package-lock.json ./
# --ignore-scripts skips the Electron binary download and the native install step
# (electron-builder install-app-deps, which for this driver's prebuilt N-API binary
# would do nothing anyway). Neither is reachable from this build graph; vite bundles
# only what src/pocket imports.
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.node.json ./
# Pocket reads the renderer's money maths and src/shared, so src travels whole.
# Files src/pocket never imports are never parsed.
COPY src ./src
RUN npm run pocket:build

FROM nginx:1.27-alpine
COPY docker/pocket.nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/pocket.headers.conf /etc/nginx/snippets/wageroute-headers.conf
COPY --from=build /app/dist-pocket/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
