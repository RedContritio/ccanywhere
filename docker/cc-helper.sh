#!/bin/sh
# cc apiKeyHelper rotation script.
#
# cc invokes this script when its current ANTHROPIC_AUTH_TOKEN 401s
# upstream. Reads CC_HELPER_TOKEN (long-lived 24h bearer injected at
# spawn) from env, POSTs it to the proxy's bearer-refresh endpoint to
# trade for a fresh 5-min bearer, prints the new token to stdout.
#
# cc reads the trimmed stdout and uses it as the new bearer.
#
# Failure modes:
#   - missing env  → exit 2 (cc sees empty stdout, will retry)
#   - curl fail    → propagated exit code (cc retries; might surface UI msg)
#   - JSON parse   → empty stdout (cc retries)
set -eu

if [ -z "${CC_HELPER_TOKEN:-}" ] || [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
  echo "cc-helper.sh: CC_HELPER_TOKEN or ANTHROPIC_BASE_URL unset" >&2
  exit 2
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${CC_HELPER_TOKEN}" \
  "${ANTHROPIC_BASE_URL}/ccanywhere/bearer-refresh" \
  | grep -o '"token":"[^"]*"' \
  | head -n 1 \
  | cut -d'"' -f4
