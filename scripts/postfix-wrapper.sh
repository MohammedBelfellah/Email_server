#!/bin/sh
cd /opt/private-email-server || exit 75

export EMAIL_DOMAINS=belfellah.tech,belf.me,mailforges.email
export STORAGE_DRIVER=sqlite
export DATA_FILE=/opt/private-email-server/data/email-server.sqlite
export MESSAGES_PER_ADDRESS=10

exec /usr/bin/node /opt/private-email-server/scripts/postfix-pipe.js "$1"
