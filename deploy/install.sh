#!/usr/bin/env bash
# Installs Uptime Monitor as a systemd service on Debian / Ubuntu
# (works great in a Proxmox LXC container). Run from the project folder:
#   sudo ./deploy/install.sh
# Re-running it updates the code and keeps your data.
set -euo pipefail

APP_DIR=/opt/uptime-monitor
DATA_DIR=/var/lib/uptime-monitor
ENV_FILE=/etc/uptime-monitor.env
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo ./deploy/install.sh)" >&2
  exit 1
fi

need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] && need_node=0
fi

echo "==> Installing packages"
apt-get update -qq || echo "    (apt-get update reported errors, continuing)"
apt-get install -y -qq iputils-ping ca-certificates curl >/dev/null
if [ "$need_node" -eq 1 ]; then
  apt-get install -y -qq nodejs >/dev/null || true
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
    echo "==> Distro Node.js is too old, installing Node 22 from NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
fi
echo "    Node $(node --version)"

echo "==> Creating user and folders"
id uptime >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin uptime
mkdir -p "$APP_DIR" "$DATA_DIR"
chown uptime:uptime "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> Copying app to $APP_DIR"
cp -r "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/lib" "$SRC_DIR/public" "$APP_DIR/"

if [ ! -f "$ENV_FILE" ]; then
  echo "==> Writing $ENV_FILE"
  cat > "$ENV_FILE" <<CONF
# Uptime Monitor settings. Restart after editing: systemctl restart uptime-monitor
PORT=3000
HOST=0.0.0.0
#ADMIN_PASSWORD=change-me
#SITE_TITLE=Homelab Status
# Google sign-in (see docs/GOOGLE_SIGNIN.md)
#GOOGLE_CLIENT_ID=
#GOOGLE_CLIENT_SECRET=
#ADMIN_EMAILS=you@gmail.com
#PUBLIC_URL=https://status.example.com
#NOTIFY_WEBHOOK_URL=
#TRUST_PROXY=true
CONF
  chmod 640 "$ENV_FILE"
  chown root:uptime "$ENV_FILE"
fi

echo "==> Installing systemd service"
cp "$SRC_DIR/deploy/uptime-monitor.service" /etc/systemd/system/uptime-monitor.service
systemctl daemon-reload
systemctl enable --now uptime-monitor >/dev/null
systemctl restart uptime-monitor
sleep 2

PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Uptime Monitor is running:  http://${IP:-localhost}:${PORT:-3000}"
if [ -f "$DATA_DIR/admin-password.txt" ] && ! grep -qE '^ADMIN_PASSWORD=.+' "$ENV_FILE"; then
  echo "Admin password / API token: $(cat "$DATA_DIR/admin-password.txt")"
fi
echo "Google sign-in:             edit $ENV_FILE (see docs/GOOGLE_SIGNIN.md)"
echo "Logs:                       journalctl -u uptime-monitor -f"
echo "Settings:                   $ENV_FILE"
