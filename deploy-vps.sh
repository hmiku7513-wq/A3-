#!/usr/bin/env bash
set -euo pipefail

# A3 一键部署脚本（Ubuntu / Debian 等）。
# 无域名：sudo bash deploy-vps.sh
# 有域名：sudo bash deploy-vps.sh a3.example.com

cd "$(dirname "$0")"
DOMAIN="${1:-${DOMAIN:-}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 运行，或执行：sudo bash deploy-vps.sh"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[A3] 正在安装 Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[A3] 正在安装 Docker Compose 插件..."
  apt-get update
  apt-get install -y docker-compose-plugin
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  if [[ -n "${DOMAIN:-}" ]]; then
    ufw allow 80/tcp >/dev/null || true
    ufw allow 443/tcp >/dev/null || true
  else
    ufw allow 3213/tcp >/dev/null || true
  fi
fi

if [[ -n "${DOMAIN:-}" ]]; then
  echo "[A3] 使用 HTTPS 模式：https://${DOMAIN}"
  DOMAIN="${DOMAIN}" docker compose -f docker-compose.https.yml up -d --build
  echo
  echo "部署完成：https://${DOMAIN}"
  echo "请确认域名 ${DOMAIN} 的 A 记录已经指向本机公网 IP。"
else
  echo "[A3] 使用直连端口模式。"
  docker compose up -d --build
  IP="$(curl -4 -fsS --max-time 8 https://api.ipify.org || true)"
  if [[ -z "${IP}" ]]; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  echo
  echo "部署完成：http://${IP:-服务器公网IP}:3213"
  echo "如果无法访问，请在云服务器安全组/防火墙放行 TCP 3213。"
fi

echo "查看日志：docker compose logs -f"
echo "停止服务：docker compose down"
