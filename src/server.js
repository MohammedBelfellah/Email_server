import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { config } from "./config.js";
import { isLocalDomain, parseRawEmail } from "./mail.js";
import {
  canAccessEmail,
  countEmailAddressesForOwner,
  createEmailAddress,
  createUser,
  deleteUser,
  findUserByAccessKey,
  getAliasLimitForUser,
  getSystemStats,
  isAdminUser,
  listAdminAliases,
  listEmailAddresses,
  listMessages,
  listRecentMessages,
  listUsers,
  normalizeLocalPart,
  saveMessage,
  updateUserAliasExtra
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
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Secret, X-Dashboard-Token",
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

async function authenticateDashboard(req) {
  const token = String(req.headers["x-dashboard-token"] || "").trim();

  if (config.dashboardToken && token === config.dashboardToken) {
    return {
      ok: true,
      user: {
        id: "bootstrap-admin",
        name: "Owner",
        role: "admin",
        active: true,
        createdAt: ""
      },
      bootstrap: true
    };
  }

  const user = await findUserByAccessKey(token);
  if (user) {
    return { ok: true, user, bootstrap: false };
  }

  if (!config.dashboardToken && !token) {
    return {
      ok: true,
      user: {
        id: "dev-admin",
        name: "Dev Admin",
        role: "admin",
        active: true,
        createdAt: ""
      },
      bootstrap: true
    };
  }

  return { ok: false, user: null, bootstrap: false };
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    role: user.role,
    extraAliases: user.extraAliases || 0,
    maxAliases: user.maxAliases || config.maxAliasesPerUser,
    active: user.active,
    createdAt: user.createdAt
  };
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const urlPath = url.pathname;

  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  try {
    let auth = { ok: false, user: null, bootstrap: false };

    if (urlPath.startsWith("/api/")) {
      auth = await authenticateDashboard(req);
    }

    if (req.method === "GET" && urlPath === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "private-email-server",
        domain: config.emailDomain,
        domains: config.emailDomains
      });
    }

    if (req.method === "GET" && (urlPath === "/" || urlPath === "/dashboard" || urlPath === "/admin")) {
      return sendFile(res, path.join(publicDir, "index.html"));
    }

    if (req.method === "GET" && urlPath.startsWith("/web/")) {
      const relativePath = decodeURIComponent(urlPath.replace(/^\/web\//, ""));
      return sendFile(res, path.join(publicDir, relativePath));
    }

    if (urlPath.startsWith("/api/") && !auth.ok) {
      return sendJson(res, 401, { error: "Invalid dashboard token." });
    }

    if (req.method === "GET" && urlPath === "/api/session") {
      return sendJson(res, 200, {
        user: publicUser(auth.user),
        bootstrap: auth.bootstrap
      });
    }

    if (req.method === "GET" && urlPath === "/api/domains") {
      return sendJson(res, 200, {
        defaultDomain: config.emailDomain,
        domains: config.emailDomains
      });
    }

    if (req.method === "POST" && urlPath === "/api/emails") {
      const body = await readJson(req);
      const ownerUserId = isAdminUser(auth.user)
        ? String(body.ownerUserId || "")
        : auth.user.id;

      if (!ownerUserId) {
        return sendJson(res, 400, { error: "Choose an owner for this address." });
      }

      const aliasCount = await countEmailAddressesForOwner(ownerUserId);
      const aliasLimit = await getAliasLimitForUser(ownerUserId);
      if (aliasCount >= aliasLimit) {
        return sendJson(res, 400, {
          error: `This user already has the maximum ${aliasLimit} email addresses.`
        });
      }

      const result = await createEmailAddress(body.name, body.label, body.domain, ownerUserId);

      if (!result.ok) {
        return sendJson(res, 400, { error: result.error });
      }

      return sendJson(res, 201, {
        email: result.emailAddress.email,
        emailAddress: result.emailAddress
      });
    }

    if (req.method === "GET" && urlPath === "/api/emails") {
      return sendJson(res, 200, { emails: await listEmailAddresses(auth.user) });
    }

    if (req.method === "GET" && urlPath === "/api/messages") {
      if (isAdminUser(auth.user)) {
        return sendJson(res, 403, { error: "Admin accounts cannot read inbox message data." });
      }

      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      return sendJson(res, 200, { messages: await listRecentMessages(limit, auth.user) });
    }

    if (req.method === "GET" && urlPath === "/api/admin/stats") {
      if (!isAdminUser(auth.user)) {
        return sendJson(res, 403, { error: "Admin access required." });
      }

      return sendJson(res, 200, { stats: await getSystemStats() });
    }

    if (req.method === "GET" && urlPath === "/api/admin/users") {
      if (!isAdminUser(auth.user)) {
        return sendJson(res, 403, { error: "Admin access required." });
      }

      return sendJson(res, 200, { users: await listUsers() });
    }

    if (req.method === "GET" && urlPath === "/api/admin/aliases") {
      if (!isAdminUser(auth.user)) {
        return sendJson(res, 403, { error: "Admin access required." });
      }

      return sendJson(res, 200, { aliases: await listAdminAliases() });
    }

    if (req.method === "POST" && urlPath === "/api/admin/users") {
      if (!isAdminUser(auth.user)) {
        return sendJson(res, 403, { error: "Admin access required." });
      }

      const body = await readJson(req);
      const result = await createUser({
        name: body.name,
        role: body.role || "user",
        extraAliases: body.extraAliases || 0
      });

      if (!result.ok) {
        return sendJson(res, 400, { error: result.error });
      }

      return sendJson(res, 201, { user: result.user });
    }

    const adminUserMatch = urlPath.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (req.method === "PATCH" && adminUserMatch) {
      if (!isAdminUser(auth.user)) {
        return sendJson(res, 403, { error: "Admin access required." });
      }

      const userId = decodeURIComponent(adminUserMatch[1]);
      const body = await readJson(req);
      const result = await updateUserAliasExtra(userId, body.extraAliases);

      if (!result.ok) {
        return sendJson(res, 400, { error: result.error });
      }

      return sendJson(res, 200, { user: result.user });
    }

    if (req.method === "DELETE" && adminUserMatch) {
      if (!isAdminUser(auth.user)) {
        return sendJson(res, 403, { error: "Admin access required." });
      }

      const userId = decodeURIComponent(adminUserMatch[1]);
      if (userId === auth.user.id) {
        return sendJson(res, 400, { error: "You cannot delete your own admin account." });
      }

      const result = await deleteUser(userId);
      if (!result.ok) {
        return sendJson(res, 400, { error: result.error });
      }

      return sendJson(res, 200, { ok: true });
    }

    const inboxMatch = urlPath.match(/^\/api\/emails\/([^/]+)\/messages$/);
    if (req.method === "GET" && inboxMatch) {
      const emailOrLocalPart = decodeURIComponent(inboxMatch[1]);
      const localPart = normalizeLocalPart(emailOrLocalPart);
      const domain = emailOrLocalPart.includes("@")
        ? emailOrLocalPart.split("@").at(-1).toLowerCase()
        : config.emailDomain;
      const email = emailOrLocalPart.includes("@") ? emailOrLocalPart.toLowerCase() : `${localPart}@${domain}`;

      if (isAdminUser(auth.user)) {
        return sendJson(res, 403, { error: "Admin accounts cannot read inbox message data." });
      }

      if (!(await canAccessEmail(auth.user, email))) {
        return sendJson(res, 403, { error: "You do not have access to this inbox." });
      }

      return sendJson(res, 200, {
        email,
        messages: await listMessages(emailOrLocalPart, auth.user)
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
        return sendJson(res, 400, { error: `Recipient must use one of: ${config.emailDomains.join(", ")}.` });
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
