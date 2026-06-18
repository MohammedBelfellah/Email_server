#!/bin/sh
set -eu

DOMAINS="${1:-belfellah.tech,belf.me,mailforges.email}"
DOMAIN="$(printf '%s' "${DOMAINS}" | cut -d, -f1)"
HOSTNAME="mail.${DOMAIN}"
APP_DIR="/opt/private-email-server"
PIPE_USER="emailpipe"

if ! id "${PIPE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${PIPE_USER}"
fi

mkdir -p "${APP_DIR}/data"
chown -R "${PIPE_USER}:${PIPE_USER}" "${APP_DIR}/data"
chmod 755 "${APP_DIR}"
chmod 755 "${APP_DIR}/scripts"
chmod 755 "${APP_DIR}/scripts/postfix-wrapper.sh"

DOMAINS_SPACE="$(printf '%s' "${DOMAINS}" | tr ',' ' ')"

: > /etc/postfix/virtual_mailbox_regexp
for domain in ${DOMAINS_SPACE}; do
  escaped_domain="$(printf '%s' "${domain}" | sed 's/\./\\./g')"
  printf '/^.+@%s$/ anything\n' "${escaped_domain}" >> /etc/postfix/virtual_mailbox_regexp
done

postconf -e "myhostname = ${HOSTNAME}"
postconf -e "mydomain = ${DOMAIN}"
postconf -e 'myorigin = $mydomain'
postconf -e 'mydestination = localhost.$mydomain, localhost'
postconf -e "virtual_mailbox_domains = ${DOMAINS_SPACE}"
postconf -e "virtual_mailbox_maps = regexp:/etc/postfix/virtual_mailbox_regexp"
postconf -e "virtual_transport = emailpipe"
postconf -e "smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination"
postconf -e "inet_interfaces = all"
postconf -e "inet_protocols = ipv4"

postconf -M "emailpipe/unix=emailpipe unix - n n - - pipe flags=Rq user=${PIPE_USER} argv=${APP_DIR}/scripts/postfix-wrapper.sh \${recipient}"

postfix check
systemctl restart postfix
systemctl enable postfix

postconf -n
