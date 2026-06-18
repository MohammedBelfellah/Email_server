import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { config } from "./config.js";
import { isLocalDomain, parseRawEmail } from "./mail.js";
import {
  createEmailAddress,
  listEmailAddresses,
  listMessages,
  listRecentMessages,
  normalizeLocalPart,
  saveMessage
} from "./storage.js";

const publicDir = path.resolve(process.cwd(), "web");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);

  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Secret",
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(body);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(body);
}

function sendFile(res, filePath) {
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(publicDir)) {
    return sendJson(res, 403, { error: "Forbidden." });
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return sendJson(res, 404, { error: "File not found." });
  }

  const ext = path.extname(resolved);
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream"
  });
  fs.createReadStream(resolved).pipe(res);
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const raw = await readRequestBody(req);

  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function requireIngestSecret(req) {
  if (!config.ingestSecret) {
    return true;
  }

  return req.headers["x-ingest-secret"] === config.ingestSecret;
}

function requireDashboardToken(req) {
  if (!config.dashboardToken) {
    return true;
  }

  return req.headers["x-dashboard-token"] === config.dashboardToken;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const urlPath = url.pathname;

  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  try {
    if (req.method === "GET" && urlPath === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "private-email-server",
        domain: config.emailDomain
      });
    }

    if (req.method === "GET" && (urlPath === "/" || urlPath === "/dashboard")) {
      return sendFile(res, path.join(publicDir, "index.html"));
    }

    if (req.method === "GET" && urlPath.startsWith("/web/")) {
      const relativePath = decodeURIComponent(urlPath.replace(/^\/web\//, ""));
      return sendFile(res, path.join(publicDir, relativePath));
    }

    if (urlPath.startsWith("/api/") && !requireDashboardToken(req)) {
      return sendJson(res, 401, { error: "Invalid dashboard token." });
    }

    if (req.method === "POST" && urlPath === "/api/emails") {
      const body = await readJson(req);
      const result = await createEmailAddress(body.name, body.label);

      if (!result.ok) {
        return sendJson(res, 400, { error: result.error });
      }

      return sendJson(res, 201, {
        email: result.emailAddress.email,
        emailAddress: result.emailAddress
      });
    }

    if (req.method === "GET" && urlPath === "/api/emails") {
      return sendJson(res, 200, { emails: await listEmailAddresses() });
    }

    if (req.method === "GET" && urlPath === "/api/messages") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      return sendJson(res, 200, { messages: await listRecentMessages(limit) });
    }

    const inboxMatch = urlPath.match(/^\/api\/emails\/([^/]+)\/messages$/);
    if (req.method === "GET" && inboxMatch) {
      const localPart = normalizeLocalPart(decodeURIComponent(inboxMatch[1]));
      return sendJson(res, 200, {
        email: `${localPart}@${config.emailDomain}`,
        messages: await listMessages(localPart)
      });
    }

    if (req.method === "POST" && urlPath === "/api/ingest/raw") {
      if (!requireIngestSecret(req)) {
        return sendJson(res, 401, { error: "Invalid ingest secret." });
      }

      const rawEmail = await readRequestBody(req);
      const parsed = parseRawEmail(rawEmail, {
        recipient: req.headers["x-original-recipient"] || ""
      });

      if (!parsed.toEmail) {
        return sendJson(res, 400, { error: "Could not find recipient email in raw message." });
      }

      if (!isLocalDomain(parsed.toEmail)) {
        return sendJson(res, 400, { error: `Recipient must be @${config.emailDomain}.` });
      }

      const saved = await saveMessage(parsed);
      return sendJson(res, 201, { message: saved });
    }

    return sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }

    console.error(error);
    return sendJson(res, 500, { error: "Internal server error." });
  }
}

const server = http.createServer(handleRequest);

server.listen(config.port, config.host, () => {
  console.log(`Private email server running on http://${config.host}:${config.port}`);
  console.log(`Receiving domain: ${config.emailDomain}`);
});
