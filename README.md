# Private Email Server

First version of the private catch-all email backend for `belfellah.tech`.

This version does three things:

- creates local email aliases like `instagram@belfellah.tech`
- receives a raw email through an HTTP endpoint or a pipe script
- saves messages into a local JSON data file

React and PostgreSQL can come after this flow works.

## Run

```bash
node src/server.js
```

The server starts on:

```text
http://localhost:3000
```

Dashboard:

```text
http://localhost:3000/
```

To protect the dashboard and API, run with:

```bash
DASHBOARD_TOKEN=change-this-secret node src/server.js
```

Production storage uses SQLite:

```bash
STORAGE_DRIVER=sqlite DATA_FILE=data/email-server.sqlite node src/server.js
```

Multiple receiving domains:

```bash
EMAIL_DOMAINS=belfellah.tech,belf.me,mailforges.email
```

Production dashboard URL:

```text
https://mail.belfellah.tech/
```

Health check:

```bash
curl http://localhost:3000/health
```

## Test With Postman

Import this file into Postman:

```text
postman_collection.json
```

Then run the requests in this order:

```text
1. Health Check
2. Create Email Alias
3. Ingest Raw Email
4. Read Test Inbox
```

Expected result:

```text
Read Test Inbox returns one saved message for test@belfellah.tech.
```

## Create An Email Alias

```bash
curl -X POST http://localhost:3000/api/emails \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"test\"}"
```

Response:

```json
{
  "email": "test@belfellah.tech"
}
```

## Test Receiving A Raw Email

```bash
curl -X POST http://localhost:3000/api/ingest/raw \
  -H "Content-Type: message/rfc822" \
  --data-binary @sample-email.eml
```

You can also pass the recipient directly:

```bash
curl -X POST http://localhost:3000/api/ingest/raw \
  -H "Content-Type: message/rfc822" \
  -H "X-Original-Recipient: test@belfellah.tech" \
  --data-binary @sample-email.eml
```

## Read Inbox

```bash
curl http://localhost:3000/api/emails/test/messages
```

## Future Postfix Pipe

Postfix can pipe raw email into:

```bash
node scripts/postfix-pipe.js test@belfellah.tech
```

That script reads the email from `stdin`, parses it, and stores it in `data/db.json`.
