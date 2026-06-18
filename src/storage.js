import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const dbPath = path.resolve(process.cwd(), config.dataFile);
const isSqlite = config.storageDriver === "sqlite";

const emptyDb = {
  emailAddresses: [],
  messages: []
};

function textSql(value) {
  const hex = Buffer.from(String(value ?? ""), "utf8").toString("hex");
  return `CAST(X'${hex}' AS TEXT)`;
}

async function sqliteExec(sql, options = {}) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const args = options.json ? ["-json", dbPath, sql] : [dbPath, sql];
  const { stdout } = await execFileAsync("sqlite3", args, {
    maxBuffer: 1024 * 1024 * 20
  });

  if (!options.json) {
    return stdout;
  }

  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function ensureSqliteDb() {
  await sqliteExec(`
    CREATE TABLE IF NOT EXISTS email_addresses (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      local_part TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      from_email TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      text_body TEXT NOT NULL DEFAULT '',
      html_body TEXT NOT NULL DEFAULT '',
      raw_email TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to_email_received_at
      ON messages (to_email, received_at DESC);
  `);

  await migrateEmailAddressLocalPartUnique();
}

async function migrateEmailAddressLocalPartUnique() {
  const rows = await sqliteExec(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_addresses';",
    { json: true }
  );
  const createSql = rows[0]?.sql || "";

  if (!/local_part\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(createSql)) {
    return;
  }

  await sqliteExec(`
    BEGIN;

    CREATE TABLE email_addresses_new (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      local_part TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO email_addresses_new (id, email, local_part, label, active, created_at)
    SELECT id, email, local_part, label, active, created_at
    FROM email_addresses;

    DROP TABLE email_addresses;
    ALTER TABLE email_addresses_new RENAME TO email_addresses;

    COMMIT;
  `);
}

async function ensureJsonDb() {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  try {
    await fs.access(dbPath);
  } catch {
    await writeJsonDb(emptyDb);
  }
}

export async function readDb() {
  if (isSqlite) {
    await ensureSqliteDb();
    return {
      emailAddresses: await listEmailAddresses(),
      messages: await listRecentMessages(500)
    };
  }

  await ensureJsonDb();
  const raw = await fs.readFile(dbPath, "utf8");
  return JSON.parse(raw);
}

async function writeJsonDb(db) {
  const tempPath = `${dbPath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, dbPath);
}

export function normalizeLocalPart(name) {
  let localPart = String(name || "").trim().toLowerCase();

  for (const domain of config.emailDomains) {
    localPart = localPart.replace(new RegExp(`@${domain.replaceAll(".", "\\.")}$`, "i"), "");
  }

  return localPart;
}

export function normalizeDomain(domain) {
  return String(domain || config.emailDomain).trim().toLowerCase();
}

export function validateDomain(domain) {
  const normalizedDomain = normalizeDomain(domain);

  if (!config.emailDomains.includes(normalizedDomain)) {
    return {
      ok: false,
      error: `Domain must be one of: ${config.emailDomains.join(", ")}.`
    };
  }

  return { ok: true, domain: normalizedDomain };
}

export function validateLocalPart(name) {
  const localPart = normalizeLocalPart(name);

  if (!localPart) {
    return { ok: false, error: "Email name is required." };
  }

  if (localPart.length > 64) {
    return { ok: false, error: "Email name must be 64 characters or less." };
  }

  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/.test(localPart)) {
    return {
      ok: false,
      error: "Use only letters, numbers, dots, underscores, and hyphens. Start and end with a letter or number."
    };
  }

  return { ok: true, localPart };
}

function mapEmailAddress(row) {
  return {
    id: row.id,
    email: row.email,
    localPart: row.localPart,
    label: row.label,
    active: Boolean(row.active),
    createdAt: row.createdAt
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    toEmail: row.toEmail,
    fromEmail: row.fromEmail,
    subject: row.subject,
    textBody: row.textBody,
    htmlBody: row.htmlBody,
    rawEmail: row.rawEmail,
    receivedAt: row.receivedAt
  };
}

export async function createEmailAddress(name, label = "", domain = config.emailDomain) {
  const validation = validateLocalPart(name);
  if (!validation.ok) {
    return validation;
  }

  const domainValidation = validateDomain(domain);
  if (!domainValidation.ok) {
    return domainValidation;
  }

  const email = `${validation.localPart}@${domainValidation.domain}`;

  if (isSqlite) {
    await ensureSqliteDb();
    const existing = await sqliteExec(
      `
        SELECT
          id,
          email,
          local_part AS localPart,
          label,
          active,
          created_at AS createdAt
        FROM email_addresses
        WHERE email = ${textSql(email)}
        LIMIT 1;
      `,
      { json: true }
    );

    if (existing[0]) {
      return { ok: true, emailAddress: mapEmailAddress(existing[0]) };
    }

    const emailAddress = {
      id: crypto.randomUUID(),
      email,
      localPart: validation.localPart,
      label: String(label || ""),
      active: true,
      createdAt: new Date().toISOString()
    };

    await sqliteExec(`
      INSERT INTO email_addresses (id, email, local_part, label, active, created_at)
      VALUES (
        ${textSql(emailAddress.id)},
        ${textSql(emailAddress.email)},
        ${textSql(emailAddress.localPart)},
        ${textSql(emailAddress.label)},
        1,
        ${textSql(emailAddress.createdAt)}
      );
    `);

    return { ok: true, emailAddress };
  }

  const db = await readDb();
  const existing = db.emailAddresses.find((item) => item.email === email);

  if (existing) {
    return { ok: true, emailAddress: existing };
  }

  const emailAddress = {
    id: crypto.randomUUID(),
    email,
    localPart: validation.localPart,
    label: String(label || ""),
    active: true,
    createdAt: new Date().toISOString()
  };

  db.emailAddresses.push(emailAddress);
  await writeJsonDb(db);

  return { ok: true, emailAddress };
}

export async function listEmailAddresses() {
  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT *
        FROM (
          SELECT
            id,
            email,
            local_part AS localPart,
            label,
            active,
            created_at AS createdAt,
            1 AS explicitAddress
          FROM email_addresses

          UNION ALL

          SELECT
            'observed:' || to_email AS id,
            to_email AS email,
            substr(to_email, 1, instr(to_email, '@') - 1) AS localPart,
            '' AS label,
            1 AS active,
            MAX(received_at) AS createdAt,
            0 AS explicitAddress
          FROM messages
          WHERE to_email NOT IN (SELECT email FROM email_addresses)
          GROUP BY to_email
        )
        ORDER BY explicitAddress DESC, datetime(createdAt) DESC;
      `,
      { json: true }
    );
    return rows.map(mapEmailAddress);
  }

  const db = await readDb();
  const byEmail = new Map(db.emailAddresses.map((item) => [item.email, item]));

  for (const message of db.messages) {
    if (!message.toEmail || byEmail.has(message.toEmail)) {
      continue;
    }

    byEmail.set(message.toEmail, {
      id: `observed:${message.toEmail}`,
      email: message.toEmail,
      localPart: normalizeLocalPart(message.toEmail),
      label: "",
      active: true,
      createdAt: message.receivedAt
    });
  }

  return [...byEmail.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function listExplicitEmailAddresses() {
  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT
          id,
          email,
          local_part AS localPart,
          label,
          active,
          created_at AS createdAt
        FROM email_addresses
        ORDER BY created_at DESC;
      `,
      { json: true }
    );
    return rows.map(mapEmailAddress);
  }

  const db = await readDb();
  return db.emailAddresses;
}

export async function listMessages(localPart) {
  const value = String(localPart || "").trim().toLowerCase();
  const wanted = value.includes("@") ? value : `${normalizeLocalPart(value)}@${config.emailDomain}`;

  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT
          id,
          to_email AS toEmail,
          from_email AS fromEmail,
          subject,
          text_body AS textBody,
          html_body AS htmlBody,
          raw_email AS rawEmail,
          received_at AS receivedAt
        FROM messages
        WHERE to_email = ${textSql(wanted)}
        ORDER BY datetime(received_at) DESC, rowid DESC
        LIMIT ${Number(config.messagesPerAddress)};
      `,
      { json: true }
    );
    return rows.map(mapMessage);
  }

  const db = await readDb();
  return db.messages
    .filter((message) => message.toEmail === wanted)
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
    .slice(0, config.messagesPerAddress);
}

export async function listRecentMessages(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));

  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT
          id,
          to_email AS toEmail,
          from_email AS fromEmail,
          subject,
          text_body AS textBody,
          html_body AS htmlBody,
          raw_email AS rawEmail,
          received_at AS receivedAt
        FROM messages
        ORDER BY datetime(received_at) DESC, rowid DESC
        LIMIT ${safeLimit};
      `,
      { json: true }
    );
    return rows.map(mapMessage);
  }

  const db = await readDb();
  return db.messages
    .slice()
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
    .slice(0, safeLimit);
}

async function pruneMessagesForAddress(toEmail, db = null) {
  if (isSqlite) {
    await sqliteExec(`
      DELETE FROM messages
      WHERE to_email = ${textSql(toEmail)}
        AND id NOT IN (
          SELECT id
          FROM messages
          WHERE to_email = ${textSql(toEmail)}
          ORDER BY datetime(received_at) DESC, rowid DESC
          LIMIT ${Number(config.messagesPerAddress)}
        );
    `);
    return;
  }

  const messages = db.messages
    .filter((message) => message.toEmail === toEmail)
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
  const keepIds = new Set(messages.slice(0, config.messagesPerAddress).map((message) => message.id));
  db.messages = db.messages.filter((message) => message.toEmail !== toEmail || keepIds.has(message.id));
}

export async function saveMessage(message) {
  const storedMessage = {
    id: crypto.randomUUID(),
    toEmail: message.toEmail || "",
    fromEmail: message.fromEmail || "",
    subject: message.subject || "",
    textBody: message.textBody || "",
    htmlBody: message.htmlBody || "",
    rawEmail: message.rawEmail || "",
    receivedAt: message.receivedAt || new Date().toISOString()
  };

  if (isSqlite) {
    await ensureSqliteDb();
    await sqliteExec(`
      INSERT INTO messages (
        id,
        to_email,
        from_email,
        subject,
        text_body,
        html_body,
        raw_email,
        received_at
      )
      VALUES (
        ${textSql(storedMessage.id)},
        ${textSql(storedMessage.toEmail)},
        ${textSql(storedMessage.fromEmail)},
        ${textSql(storedMessage.subject)},
        ${textSql(storedMessage.textBody)},
        ${textSql(storedMessage.htmlBody)},
        ${textSql(storedMessage.rawEmail)},
        ${textSql(storedMessage.receivedAt)}
      );
    `);
    await pruneMessagesForAddress(storedMessage.toEmail);
    return storedMessage;
  }

  const db = await readDb();
  db.messages.push(storedMessage);
  await pruneMessagesForAddress(storedMessage.toEmail, db);
  await writeJsonDb(db);

  return storedMessage;
}
