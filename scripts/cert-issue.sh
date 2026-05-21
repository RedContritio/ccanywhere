#!/usr/bin/env bash
# 一键申请 Let's Encrypt 证书 + 装到 ccanywhere 期望的路径。
#
# ============================================================
# THIS SCRIPT ENCODES THE AUTHOR'S LOCAL SETUP
#   macOS launchd + frpc + 腾讯云 DNSPod
# Fork and adapt the 3 marked lines below for your stack:
#   [adapt 1] DNS provider plugin (default: dns_tencent)
#   [adapt 2] DNS provider credential env names
#   [adapt 3] RELOAD_CMD (default: launchctl kickstart frpc)
# ============================================================
#
# DNS provider: 默认以**腾讯云 DNSPod (dns_tencent)** 为 example。换
# Cloudflare / AWS Route53 / 阿里云等只需 (1) 改下面 `--dns dns_tencent`
# 为对应 acme.sh plugin (如 `dns_cf` / `dns_aws` / `dns_ali`),
# (2) export 对应 plugin 的凭证 env (见 acme.sh wiki:
# https://github.com/acmesh-official/acme.sh/wiki/dnsapi)。
#
# RELOAD_CMD: 默认是 macOS launchd 重启 frpc。Linux systemd 用户改成
# `sudo systemctl reload <your-reverse-proxy>.service` 即可;caddy 用
# `sudo systemctl reload caddy` (它会自动读新 cert)。
#
# 前置：
# export CCANYWHERE_DOMAIN='cc.your-domain.com'
# export CCANYWHERE_ACME_EMAIL='you@your-domain.com'
# export Tencent_SecretId='...'   # 换 provider 时改对应 env name
# export Tencent_SecretKey='...'
#
# 续签：每天的 timer (macOS launchd / Linux systemd) 跑 `acme.sh --cron`
# 自动检查；本脚本只用于第一次申请。续签时 acme.sh 从
# ~/.acme.sh/account.conf 读凭证。

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
# [adapt 3] RELOAD_CMD: 装新 cert 后跑这个命令重启 reverse proxy 让
# 新 cert 生效。默认是 author 的 macOS launchd + frpc setup。
RELOAD_CMD="sudo /bin/launchctl kickstart -k system/com.fatedier.frpc"

echo "[cert-issue] domain=$DOMAIN email=$EMAIL"

if [[ ! -x "$ACME_HOME/acme.sh" ]]; then
  echo "[cert-issue] acme.sh 未装，从官方源安装到 $ACME_HOME ..."
  curl -fsSL https://get.acme.sh | sh -s "email=$EMAIL"
fi

# [adapt 2] DNS provider credential env names。换 provider 时改下面 var
# names (例: dns_cf 用 CF_Token / CF_Account_ID, dns_aws 用 AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY, 见 acme.sh wiki dnsapi 页)。
if [[ -z "${Tencent_SecretId:-}" || -z "${Tencent_SecretKey:-}" ]]; then
  echo "[cert-issue] 错误：先 export Tencent_SecretId 和 Tencent_SecretKey" >&2
  echo "  export Tencent_SecretId='your-secret-id'" >&2
  echo "  export Tencent_SecretKey='your-secret-key'" >&2
  exit 2
fi

# Let's Encrypt（acme.sh 默认走 ZeroSSL，需要 EAB；明确指定避免）。
"$ACME_HOME/acme.sh" --set-default-ca --server letsencrypt

echo "[cert-issue] 申请证书（DNS-01 challenge via 腾讯云 DNSPod）..."
# [adapt 1] DNS provider plugin。换 provider 时改下面 --dns 参数
# (例: --dns dns_cf / --dns dns_aws / --dns dns_ali)。
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
