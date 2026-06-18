import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const port = 3100;
const baseUrl = `http://localhost:${port}`;
const server = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    EMAIL_DOMAINS: "belfellah.tech,belf.me,mailforges.email",
    STORAGE_DRIVER: "json",
    DATA_FILE: "data/smoke-db.json"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

async function waitForServer() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new Error(`Server did not start.\n${serverOutput}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed: ${JSON.stringify(body)}`);
  }

  return body;
}

async function requestText(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed: ${body}`);
  }

  return body;
}

try {
  await fs.rm("data/smoke-db.json", { force: true });
  await waitForServer();

  const userResult = await request("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Smoke User", role: "user", extraAliases: 1 })
  });
  const userHeaders = {
    "Content-Type": "application/json",
    "X-Dashboard-Token": userResult.user.accessKey
  };

  const created = await request("/api/emails", {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "test" })
  });
  const createdSecondDomain = await request("/api/emails", {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "test", domain: "belf.me" })
  });
  const createdThirdDomain = await request("/api/emails", {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "test", domain: "mailforges.email" })
  });
  await request("/api/emails", {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "htmltest" })
  });
  await request("/api/emails", {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "extraone" })
  });
  await request("/api/emails", {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "extrasix" })
  });

  const overLimitResponse = await fetch(`${baseUrl}/api/emails`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "toomany" })
  });
  const overLimitBody = await overLimitResponse.json();

  const sampleEmail = await fs.readFile("sample-email.eml", "utf8");
  const sampleMultipartEmail = await fs.readFile("sample-multipart-email.eml", "utf8");
  const ingested = await request("/api/ingest/raw", {
    method: "POST",
    headers: { "Content-Type": "message/rfc822" },
    body: sampleEmail
  });
  const ingestedMultipart = await request("/api/ingest/raw", {
    method: "POST",
    headers: { "Content-Type": "message/rfc822" },
    body: sampleMultipartEmail
  });

  const inbox = await request("/api/emails/test/messages", {
    headers: { "X-Dashboard-Token": userResult.user.accessKey }
  });
  const htmlInbox = await request("/api/emails/htmltest/messages", {
    headers: { "X-Dashboard-Token": userResult.user.accessKey }
  });
  await requestText("/");
  const appScript = await requestText("/web/app.js");
  const session = await request("/api/session", {
    headers: { "X-Dashboard-Token": userResult.user.accessKey }
  });

  if (created.email !== "test@belfellah.tech") {
    throw new Error(`Unexpected email alias: ${created.email}`);
  }

  if (createdSecondDomain.email !== "test@belf.me") {
    throw new Error(`Unexpected second-domain alias: ${createdSecondDomain.email}`);
  }

  if (createdThirdDomain.email !== "test@mailforges.email") {
    throw new Error(`Unexpected third-domain alias: ${createdThirdDomain.email}`);
  }

  if (ingested.message.subject !== "Your Instagram code is 123456") {
    throw new Error(`Unexpected subject: ${ingested.message.subject}`);
  }

  if (inbox.messages.length !== 1) {
    throw new Error(`Expected 1 inbox message, got ${inbox.messages.length}`);
  }

  if (htmlInbox.messages.length !== 1) {
    throw new Error(`Expected 1 HTML inbox message, got ${htmlInbox.messages.length}`);
  }

  if (session.user.maxAliases !== 6) {
    throw new Error(`Expected maxAliases 6, got ${session.user.maxAliases}`);
  }

  if (overLimitResponse.ok || !overLimitBody.error.includes("maximum 6")) {
    throw new Error(`Expected 7th alias to fail at limit 6, got ${JSON.stringify(overLimitBody)}`);
  }

  if (!ingestedMultipart.message.htmlBody.includes("<strong>HTML</strong>")) {
    throw new Error("Expected multipart HTML body to be parsed.");
  }

  if (ingestedMultipart.message.textBody.includes("demo-boundary")) {
    throw new Error("Expected multipart text body to exclude MIME boundaries.");
  }

  if (!appScript.includes("NotMyRealEmail")) {
    throw new Error("Dashboard HTML did not load.");
  }

  console.log("Smoke test passed.");
  console.log(`Created alias: ${created.email}`);
  console.log(`Saved message: ${ingested.message.id}`);
  console.log(`Inbox messages: ${inbox.messages.length}`);
} finally {
  server.kill();
}
