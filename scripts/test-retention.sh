#!/bin/sh
set -eu

ADDRESS="${1:-retention@belfellah.tech}"
DB_FILE="${2:-/opt/private-email-server/data/email-server.sqlite}"

for i in $(seq 1 11); do
  {
    printf '%s\n' "From: retention-test@example.com"
    printf '%s\n' "To: ${ADDRESS}"
    printf '%s\n' "Subject: retention test ${i}"
    printf '%s\n' ""
    printf '%s\n' "message ${i}"
  } | sendmail "${ADDRESS}"
done

sleep 8

sqlite3 "${DB_FILE}" "SELECT COUNT(*) FROM messages WHERE to_email = '${ADDRESS}';"
sqlite3 "${DB_FILE}" "SELECT subject FROM messages WHERE to_email = '${ADDRESS}' ORDER BY datetime(received_at) DESC;"
