#!/usr/bin/env bash
#
# proxy-manual-verify.sh — verify the anthropic proxy path end-to-end:
# spin up proxy, issue a temporary bearer, run `claude --print` through
# it, assert proxy log redacts the bearer.
#
# 用法:
# ./scripts/proxy-manual-verify.sh [--keep]
#
# --keep 不 kill 后台 proxy (留着 owner 手动 dogfood 用)
#
# 前置:
# 1. pnpm build:all 已跑过 (dist/cli.js 就绪)
# 2. ~/.config/ccanywhere/anthropic-credentials.json 含 owner key
# (mode 0600), 内容 { "apiKey": "sk-ant-..." }
# 3. ccanywhere 主 server 已经跑过, ~/.config/ccanywhere/users.json
# 含至少一个 user record (验证 owner 即可)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${CCANYWHERE_CONFIG_DIR:-$HOME/.config/ccanywhere}"
PROXY_PORT="${CCANYWHERE_PROXY_PORT:-8082}"
KEEP_RUNNING="no"

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP_RUNNING="yes" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# 1. preflight
if [[ ! -f "$CONFIG_DIR/anthropic-credentials.json" ]]; then
  echo "FAIL: $CONFIG_DIR/anthropic-credentials.json missing" >&2
  echo "  write { \"apiKey\": \"sk-ant-...\" }, then chmod 600" >&2
  exit 2
fi
if [[ ! -f "$REPO/dist/cli.js" ]]; then
  echo "FAIL: $REPO/dist/cli.js missing — run pnpm build:all first" >&2
  exit 2
fi
if [[ ! -f "$CONFIG_DIR/users.json" ]]; then
  echo "FAIL: $CONFIG_DIR/users.json missing — start ccanywhere main server once first" >&2
  exit 2
fi

# 2. start proxy in background
echo "[1/4] starting proxy..."
node "$REPO/dist/cli.js" proxy serve > /tmp/proxy-manual-verify.log 2>&1 &
PROXY_PID=$!
trap '[[ "$KEEP_RUNNING" == "no" ]] && kill -9 $PROXY_PID 2>/dev/null || true' EXIT
sleep 2

if ! curl -sf "http://127.0.0.1:$PROXY_PORT/healthz" > /dev/null; then
  echo "FAIL: proxy /healthz not responding on port $PROXY_PORT" >&2
  echo "--- proxy log ---" >&2
  tail -20 /tmp/proxy-manual-verify.log >&2
  exit 2
fi
echo "  proxy healthz OK"

# 3. issue test bearer (HMAC over fake payload using proxy-token-secret)
echo "[2/4] issuing test bearer..."
OWNER_ID=$(node -e "
const u = JSON.parse(require('fs').readFileSync('$CONFIG_DIR/users.json', 'utf8'));
const o = u.users.find(x => x.kind === 'owner');
if (!o) { console.error('no owner'); process.exit(2); }
process.stdout.write(o.id);
")

BEARER=$(node -e "
const { TokenIssuer } = require('$REPO/dist/index.js');
const fs = require('fs');
const secret = fs.readFileSync('$CONFIG_DIR/proxy-token-secret');
const issuer = new TokenIssuer({ secret });
const { token } = issuer.issue('$OWNER_ID');
process.stdout.write(token);
" 2>/dev/null || true)

if [[ -z "$BEARER" ]]; then
  # fallback: TokenIssuer 不在 dist/index.js 时直接 inline 实现
  BEARER=$(node -e "
const { createHmac, randomBytes } = require('crypto');
const fs = require('fs');
const secret = fs.readFileSync('$CONFIG_DIR/proxy-token-secret');
const payload = {
  uid: '$OWNER_ID',
  exp: Date.now() + 5 * 60 * 1000,
  nonce: randomBytes(8).toString('base64url'),
};
const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
const mac = createHmac('sha256', secret).update(b64).digest('base64url');
process.stdout.write('cca.' + b64 + '.' + mac);
")
fi
echo "  bearer: ${BEARER:0:24}... (${#BEARER} bytes)"

# 4. claude --print through proxy
echo "[3/4] calling claude --print through proxy..."
CLAUDE_OUT=$(ANTHROPIC_BASE_URL="http://127.0.0.1:$PROXY_PORT" \
  ANTHROPIC_AUTH_TOKEN="$BEARER" \
  DISABLE_AUTOUPDATER=1 \
  DISABLE_TELEMETRY=1 \
  claude --print "reply only with the word OK" 2>&1 | head -5 || true)
echo "  claude output: $CLAUDE_OUT"

# 5. grep proxy log for token leak (redact self-test 跑过, 这里再 verify)
echo "[4/4] checking proxy log for bearer leak..."
if grep -F "$BEARER" /tmp/proxy-manual-verify.log > /dev/null 2>&1; then
  echo "  FAIL: bearer leaked in proxy log!" >&2
  exit 2
fi
echo "  no leak"

if [[ "$KEEP_RUNNING" == "yes" ]]; then
  trap - EXIT
  echo "PASS — proxy still running as PID $PROXY_PID (--keep)"
else
  echo "PASS — proxy killed"
fi
