#!/bin/sh
set -eu

TOKEN="$1"

for i in 1 2 3 4 5 6; do
  code="$(curl -s -o "/tmp/limit-${i}.json" -w "%{http_code}" \
    -X POST \
    -H "X-Dashboard-Token: ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"limit${i}\",\"domain\":\"belfellah.tech\"}" \
    http://127.0.0.1:3000/api/emails)"
  printf '%s:%s ' "${i}" "${code}"
  cat "/tmp/limit-${i}.json"
  printf '\n'
done
