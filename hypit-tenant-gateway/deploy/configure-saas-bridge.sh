#!/usr/bin/env bash
set -euo pipefail

gateway_env=/etc/hypit-tenant-gateway.env
saas_env=/home/ad-creative-hub/.env

if [[ ! -f "$gateway_env" || ! -f "$saas_env" ]]; then
  echo "Expected gateway and SaaS environment files were not found" >&2
  exit 1
fi

upsert() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

secret="$(openssl rand -hex 32)"
upsert "$gateway_env" SAAS_BRIDGE_SECRET "$secret"
upsert "$saas_env" HYPIT_GATEWAY_BRIDGE_SECRET "$secret"
upsert "$saas_env" HYPIT_GATEWAY_BASE_URL "http://127.0.0.1:8791"

chmod 600 "$gateway_env" "$saas_env"
echo "SaaS bridge credentials configured"
