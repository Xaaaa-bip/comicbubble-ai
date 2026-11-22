#!/usr/bin/env bash
set -euo pipefail

# ComicBubble AI VPS 原生 Python 一键安装脚本（Ubuntu / Debian / CentOS 等）
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> 安装目录: ${INSTALL_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[错误] 未找到 python3，请先安装 Python 3.9+ (如: sudo apt update && sudo apt install -y python3 python3-venv python3-pip)"
  exit 1
fi

# 安装 python3-venv 与 OpenCV 依赖（兼容 Ubuntu 24.04 / Debian）
if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  apt-get update -y
  PY_MINOR="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  apt-get install -y "python${PY_MINOR}-venv" python3-venv python3-pip libglib2.0-0t64 libgl1 2>/dev/null || \
    apt-get install -y python3-venv python3-pip libglib2.0-0 libgl1 || true
fi

if [ ! -f "${INSTALL_DIR}/.venv/bin/pip" ]; then
  rm -rf "${INSTALL_DIR}/.venv"
  echo "==> 创建 Python 虚拟环境 .venv ..."
  python3 -m venv "${INSTALL_DIR}/.venv"
fi

echo "==> 安装轻量 CPU 依赖（首次下载约 150MB，无需 PyTorch/CUDA）..."
"${INSTALL_DIR}/.venv/bin/pip" install --no-cache-dir --upgrade pip
"${INSTALL_DIR}/.venv/bin/pip" install --no-cache-dir -r "${INSTALL_DIR}/requirements.txt"

if [ ! -f "${INSTALL_DIR}/.env" ]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  RAND_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  sed -i "s/^API_TOKEN=.*/API_TOKEN=${RAND_TOKEN}/" "${INSTALL_DIR}/.env"
  echo ""
  echo "============================================================"
  echo "已生成配置文件: ${INSTALL_DIR}/.env"
  echo "自动生成的访问密钥 API_TOKEN = ${RAND_TOKEN}"
  echo "（请把此 Token 填入浏览器插件的 VPS 配置中；如需接入 DeepSeek/OpenAI 可编辑 .env）"
  echo "============================================================"
fi

if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  echo "==> 注册并启动 systemd 服务 comicbubble.service ..."
  sed "s|__INSTALL_DIR__|${INSTALL_DIR}|g" "${INSTALL_DIR}/comicbubble.service" > /etc/systemd/system/comicbubble.service
  systemctl daemon-reload
  systemctl enable --now comicbubble.service
  sleep 2
  systemctl status comicbubble.service --no-pager || true
  echo ""
  echo "==> 部署完成！请确保 VPS 防火墙/安全组已放行对应端口（默认 8765，推荐再套 Nginx HTTPS 反向代理）。"
  echo "    查看日志: journalctl -u comicbubble -f"
  echo "    修改配置后重启: systemctl restart comicbubble"
else
  echo ""
  echo "==> 虚拟环境安装完成（非 root 未自动写 systemd）。手动启动命令："
  echo "    cd ${INSTALL_DIR} && ./.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8765"
fi
