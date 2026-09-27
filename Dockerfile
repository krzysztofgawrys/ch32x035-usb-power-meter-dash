# USB Power Meter Dashboard - TypeScript build, served as static files by nginx.
#
# The image contains no backend. The browser opens the serial port itself via
# the Web Serial API, so the container never touches hardware and can run
# anywhere - no --device, no usbipd.
#
#   docker compose up -d --build
#
# NOTE: Web Serial only works in a secure context. http://localhost is trusted,
# http://<ip-address> is not - reaching this from another machine needs HTTPS
# (see README).

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first so edits to src/ do not invalidate the npm layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# `npm run build` type-checks before bundling, so a type error fails the image.
RUN npm run build


FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
