#!/usr/bin/env bash
# 一键申请 Let's Encrypt 证书 + 装到 ccanywhere 期望的路径。
#
# 前置：
#   export CCANYWHERE_DOMAIN='cc.your-domain.com'
#   export CCANYWHERE_ACME_EMAIL='you@your-domain.com'
#   export Tencent_SecretId='...'
#   export Tencent_SecretKey='...'
#
# 续签：每天的 launchd timer 跑 `acme.sh --cron` 自动检查；本脚本只用
# 于第一次申请。续签时 acme.sh 从 ~/.acme.sh/account.conf 读凭证。

set -euo pipefail

if [[ -z "${CCANYWHERE_DOMAIN:-}" || -z "${CCANYWHERE_ACME_EMAIL:-}" ]]; then
  echo "[cert-issue] 错误：先 export CCANYWHERE_DOMAIN 和 CCANYWHERE_ACME_EMAIL" >&2
  echo "  export CCANYWHERE_DOMAIN='cc.your-domain.com'" >&2
  echo "  export CCANYWHERE_ACME_EMAIL='you@your-domain.com'" >&2
  exit 2
fi

DOMAIN="$CCANYWHERE_DOMAIN"
EMAIL="$CCANYWHERE_ACME_EMAIL"
CERT_DIR="$HOME/.config/ccanywhere/certs"
ACME_HOME="$HOME/.acme.sh"
RELOAD_CMD="sudo /bin/launchctl kickstart -k system/com.fatedier.frpc"

echo "[cert-issue] domain=$DOMAIN email=$EMAIL"

if [[ ! -x "$ACME_HOME/acme.sh" ]]; then
  echo "[cert-issue] acme.sh 未装，从官方源安装到 $ACME_HOME ..."
  curl -fsSL https://get.acme.sh | sh -s "email=$EMAIL"
fi

if [[ -z "${Tencent_SecretId:-}" || -z "${Tencent_SecretKey:-}" ]]; then
  echo "[cert-issue] 错误：先 export Tencent_SecretId 和 Tencent_SecretKey" >&2
  echo "  export Tencent_SecretId='your-secret-id'" >&2
  echo "  export Tencent_SecretKey='your-secret-key'" >&2
  exit 2
fi

# Let's Encrypt（acme.sh 默认走 ZeroSSL，需要 EAB；明确指定避免）。
"$ACME_HOME/acme.sh" --set-default-ca --server letsencrypt

echo "[cert-issue] 申请证书（DNS-01 challenge via 腾讯云 DNSPod）..."
"$ACME_HOME/acme.sh" --issue --dns dns_tencent -d "$DOMAIN"

mkdir -p "$CERT_DIR"

echo "[cert-issue] 安装证书到 $CERT_DIR ..."
"$ACME_HOME/acme.sh" --install-cert -d "$DOMAIN" \
  --key-file       "$CERT_DIR/$DOMAIN.key" \
  --fullchain-file "$CERT_DIR/$DOMAIN.crt" \
  --reloadcmd      "$RELOAD_CMD"

chmod 600 "$ACME_HOME/account.conf"
chmod 600 "$CERT_DIR/$DOMAIN.key"

cat <<EOF

[cert-issue] 完成。

  证书:  $CERT_DIR/$DOMAIN.crt
  私钥:  $CERT_DIR/$DOMAIN.key
  凭证已落盘: $ACME_HOME/account.conf (chmod 600)

下一步：
  1. 配置 sudoers NOPASSWD（让自动续签后能 reload frpc）
  2. 改 ~/.config/frp/frpc.toml 切到 https + https2http plugin
  3. 装 launchd timer 每日跑续签
EOF
