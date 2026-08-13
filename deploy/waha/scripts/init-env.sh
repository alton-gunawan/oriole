#!/usr/bin/env bash
# Create deploy/waha/.env from .env.example with fresh random secrets.
# The WAHA API key is stored as a sha512 HASH (WAHA_API_KEY=sha512:…, the
# docs-recommended format) — the PLAIN key (WAHA_API_KEY_PLAIN) is what you
# paste into Oriole as the "Gateway API key". Safe to re-run: never
# overwrites an existing .env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo "deploy/waha/.env already exists — not overwriting." >&2
  echo "Read WAHA_API_KEY_PLAIN from it if you need the Oriole key again." >&2
  exit 0
fi

API_KEY="$(openssl rand -hex 32)"
API_KEY_HASH="$(printf '%s' "$API_KEY" | shasum -a 512 | cut -d' ' -f1)"
DASHBOARD_PASSWORD="$(openssl rand -hex 24)"
SWAGGER_PASSWORD="$(openssl rand -hex 24)"

sed \
  -e "s|^WAHA_API_KEY=.*|WAHA_API_KEY=sha512:${API_KEY_HASH}|" \
  -e "s|^WAHA_API_KEY_PLAIN=.*|WAHA_API_KEY_PLAIN=${API_KEY}|" \
  -e "s|^WAHA_DASHBOARD_PASSWORD=.*|WAHA_DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}|" \
  -e "s|^WHATSAPP_SWAGGER_PASSWORD=.*|WHATSAPP_SWAGGER_PASSWORD=${SWAGGER_PASSWORD}|" \
  .env.example > .env

chmod 600 .env

PORT="$(grep '^WAHA_PORT=' .env | cut -d= -f2-)"
PORT="${PORT:-3002}"

echo "Wrote deploy/waha/.env with fresh random secrets."
echo
echo "────────────────────────────────────────────────────────────"
echo "  Gateway URL:  http://localhost:${PORT}"
echo "  API key:      ${API_KEY}   ← paste into Oriole as the Gateway API key"
echo "  Dashboard:    http://localhost:${PORT}/dashboard (admin / password in .env)"
echo "  Swagger:      http://localhost:${PORT}/ (admin / password in .env)"
echo "────────────────────────────────────────────────────────────"
echo "Paste the API key into Oriole → Integrations → WhatsApp → Bring your own number."
# Note: prints the plain key to stdout (by design) — don't run this in CI or
# any log-captured environment; run it interactively and store .env securely.
