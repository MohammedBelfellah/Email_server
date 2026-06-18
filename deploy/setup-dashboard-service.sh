#!/bin/sh
set -eu

DOMAINS="${1:-belfellah.tech,belf.me,mailforges.email}"
DOMAIN="$(printf '%s' "${DOMAINS}" | cut -d, -f1)"
APP_DIR="/opt/private-email-server"
PIPE_USER="emailpipe"
ENV_DIR="/etc/private-email-server"
ENV_FILE="${ENV_DIR}/app.env"
SERVICE_FILE="/etc/systemd/system/private-email-server.service"

if ! id "${PIPE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${PIPE_USER}"
fi

mkdir -p "${APP_DIR}/data" "${ENV_DIR}"
chown -R "${PIPE_USER}:${PIPE_USER}" "${APP_DIR}/data"

if [ -f "${ENV_FILE}" ]; then
  DASHBOARD_TOKEN="$(grep '^DASHBOARD_TOKEN=' "${ENV_FILE}" | cut -d= -f2-)"
else
  DASHBOARD_TOKEN="$(openssl rand -hex 24)"
fi

cat > "${ENV_FILE}" <<EOF
PORT=3000
HOST=127.0.0.1
EMAIL_DOMAIN=${DOMAIN}
EMAIL_DOMAINS=${DOMAINS}
STORAGE_DRIVER=sqlite
DATA_FILE=${APP_DIR}/data/email-server.sqlite
MESSAGES_PER_ADDRESS=10
MAX_ALIASES_PER_USER=5
DASHBOARD_TOKEN=${DASHBOARD_TOKEN}
INGEST_SECRET=
EOF

chmod 600 "${ENV_FILE}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Private Email Server Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP_DIR}/src/server.js
Restart=always
RestartSec=3
User=${PIPE_USER}
Group=${PIPE_USER}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable private-email-server
systemctl restart private-email-server

echo "Dashboard URL: https://mail.${DOMAIN}/"
echo "Dashboard key: ${DASHBOARD_TOKEN}"
