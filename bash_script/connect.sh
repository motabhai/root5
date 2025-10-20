#!/bin/bash
set -euo pipefail

# ===============================================
# CLOUDFLARE TUNNEL CONNECTION SCRIPT (v2)
# Works with Customer Manager Worker v1 JSON schema:
# {
#   "version":1,
#   "customer": {"id":"7","domain":"customer7.chromebased.net"},
#   "tunnel": {"uid":"...","token":"..."}
# }
# ===============================================

# --- CONFIGURATION ---
# Your Customer Manager Worker endpoint
WORKER_URL="https://customer-manager.pavol-eisenberg.workers.dev"

# Local service to expose
LOCAL_SERVICE_URL="http://127.0.0.1:8081"

# ---------------------
usage() {
  echo "Usage: $0 <customer_id>"
  exit 1
}

if [ $# -lt 1 ]; then
  echo "Error: No Customer ID provided."
  usage
fi

CUSTOMER_ID="$1"

# --- CHECK REQUIRED TOOLS ---
for cmd in curl jq cloudflared; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: Required command '$cmd' not found. Please install it and try again."
    exit 1
  fi
done

# --- FETCH CONFIGURATION ---
API_ENDPOINT="${WORKER_URL}/api/customers/${CUSTOMER_ID}/config"
echo "→ Fetching configuration for customer ID: ${CUSTOMER_ID}"
echo "  from ${API_ENDPOINT}"

TMP_JSON=$(mktemp)
if ! curl -sS -w "%{http_code}" -o "$TMP_JSON" "$API_ENDPOINT" >/tmp/http_code; then
  echo "✗ Failed to contact worker. Check network or WORKER_URL."
  exit 1
fi

HTTP_CODE=$(cat /tmp/http_code)
CONFIG_JSON=$(cat "$TMP_JSON")
rm -f "$TMP_JSON" /tmp/http_code

if [ "$HTTP_CODE" != "200" ]; then
  echo "✗ Worker returned HTTP $HTTP_CODE"
  echo "Response: $CONFIG_JSON"
  exit 1
fi

# --- PARSE JSON (new nested schema) ---
TUNNEL_TOKEN=$(echo "$CONFIG_JSON" | jq -r '.tunnel.token // empty' 2>/dev/null)
TUNNEL_UID=$(echo "$CONFIG_JSON" | jq -r '.tunnel.uid // empty' 2>/dev/null)
FULL_DNS_NAME=$(echo "$CONFIG_JSON" | jq -r '.customer.domain // empty' 2>/dev/null)

# --- VALIDATE DATA ---
if [ -z "$TUNNEL_TOKEN" ] || [ "$TUNNEL_TOKEN" = "null" ]; then
  echo "-----------------"
  echo "✗ Error: Worker response did not include a valid tunnel token."
  echo "Worker Response (raw): $CONFIG_JSON"
  echo "-----------------"
  exit 1
fi

echo ""
echo "✓ Successfully fetched tunnel token for customer ${CUSTOMER_ID}"
echo "  Tunnel UID: ${TUNNEL_UID:-unknown}"
if [ -n "$FULL_DNS_NAME" ] && [ "$FULL_DNS_NAME" != "null" ]; then
  echo "  Public endpoint: https://${FULL_DNS_NAME}"
fi
echo "  Local service: ${LOCAL_SERVICE_URL}"
echo ""

# --- START CLOUDFLARED ---
echo "Starting Cloudflare Tunnel (Ctrl+C to stop)..."
echo ""

# --no-autoupdate ensures consistent behavior
exec cloudflared tunnel --no-autoupdate run --token "${TUNNEL_TOKEN}" --url "${LOCAL_SERVICE_URL}"
