#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [[ "$(id -u)" -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update
$SUDO apt-get install -y ca-certificates curl ufw

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | $SUDO sh
fi

$SUDO systemctl enable --now docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin उपलब्ध नहीं है। कृपया Docker को अपडेट करके दोबारा चलाएँ।" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "पहली बार setup: $APP_DIR/.env में BOT_TOKEN भरें, फिर यह script दोबारा चलाएँ।" >&2
  exit 2
fi

if grep -q '^BOT_TOKEN=replace_' .env || ! grep -q '^BOT_TOKEN=' .env; then
  echo "ERROR: .env में वास्तविक BOT_TOKEN सेट करें।" >&2
  exit 3
fi

# Long polling के लिए inbound application port की आवश्यकता नहीं है। SSH को पहले allow करके lockout से बचें।
$SUDO ufw allow OpenSSH >/dev/null
$SUDO ufw --force enable >/dev/null

$SUDO docker compose up -d --build
$SUDO docker image prune -f >/dev/null || true

$SUDO docker compose ps
echo
echo "Deployment complete. Logs देखने के लिए: docker compose logs -f --tail=200"
