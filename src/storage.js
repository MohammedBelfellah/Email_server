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
  users: [],
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
      owner_user_id TEXT,
      label TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      access_key TEXT NOT NULL UNIQUE,
      extra_aliases INTEGER NOT NULL DEFAULT 0,
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
  await migrateEmailAddressOwner();
  await migrateUserExtraAliases();
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

async function migrateEmailAddressOwner() {
  const rows = await sqliteExec("PRAGMA table_info(email_addresses);", { json: true });
  const hasOwnerColumn = rows.some((row) => row.name === "owner_user_id");

  if (!hasOwnerColumn) {
    await sqliteExec("ALTER TABLE email_addresses ADD COLUMN owner_user_id TEXT;");
  }
}

async function migrateUserExtraAliases() {
  const rows = await sqliteExec("PRAGMA table_info(users);", { json: true });
  const hasExtraAliasesColumn = rows.some((row) => row.name === "extra_aliases");

  if (!hasExtraAliasesColumn) {
    await sqliteExec("ALTER TABLE users ADD COLUMN extra_aliases INTEGER NOT NULL DEFAULT 0;");
  }
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
    ownerUserId: row.ownerUserId || "",
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

function mapUser(row) {
  const extraAliases = Math.max(0, Number(row.extraAliases || 0));
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    accessKey: row.accessKey,
    extraAliases,
    maxAliases: config.maxAliasesPerUser + extraAliases,
    active: Boolean(row.active),
    createdAt: row.createdAt
  };
}

export function isAdminUser(user) {
  return user?.role === "admin";
}

export function generateAccessKey(prefix = "key") {
  return `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
}

function normalizeExtraAliases(value) {
  return Math.max(0, Math.min(500, Math.floor(Number(value) || 0)));
}

export async function createUser({ name, role = "user", accessKey = "", extraAliases = 0 }) {
  const normalizedName = String(name || "").trim();
  const normalizedRole = role === "admin" ? "admin" : "user";
  const normalizedExtraAliases = normalizeExtraAliases(extraAliases);

  if (!normalizedName) {
    return { ok: false, error: "User name is required." };
  }

  const user = {
    id: crypto.randomUUID(),
    name: normalizedName,
    role: normalizedRole,
    accessKey: accessKey || generateAccessKey(normalizedRole),
    extraAliases: normalizedExtraAliases,
    maxAliases: config.maxAliasesPerUser + normalizedExtraAliases,
    active: true,
    createdAt: new Date().toISOString()
  };

  if (isSqlite) {
    await ensureSqliteDb();
    await sqliteExec(`
      INSERT INTO users (id, name, role, access_key, extra_aliases, active, created_at)
      VALUES (
        ${textSql(user.id)},
        ${textSql(user.name)},
        ${textSql(user.role)},
        ${textSql(user.accessKey)},
        ${user.extraAliases},
        1,
        ${textSql(user.createdAt)}
      );
    `);
    return { ok: true, user };
  }

  const db = await readDb();
  db.users ||= [];
  db.users.push(user);
  await writeJsonDb(db);
  return { ok: true, user };
}

export async function listUsers() {
  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT
          id,
          name,
          role,
          access_key AS accessKey,
          extra_aliases AS extraAliases,
          active,
          created_at AS createdAt
        FROM users
        ORDER BY datetime(created_at) DESC;
      `,
      { json: true }
    );
    return rows.map(mapUser);
  }

  const db = await readDb();
  return (db.users || []).map(mapUser);
}

export async function findUserByAccessKey(accessKey) {
  const key = String(accessKey || "").trim();
  if (!key) {
    return null;
  }

  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT
          id,
          name,
          role,
          access_key AS accessKey,
          extra_aliases AS extraAliases,
          active,
          created_at AS createdAt
        FROM users
        WHERE access_key = ${textSql(key)}
          AND active = 1
        LIMIT 1;
      `,
      { json: true }
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  const db = await readDb();
  const user = (db.users || []).find((item) => item.accessKey === key && item.active);
  return user ? mapUser(user) : null;
}

export async function getAliasLimitForUser(userId) {
  const id = String(userId || "").trim();

  if (!id) {
    return config.maxAliasesPerUser;
  }

  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT extra_aliases AS extraAliases
        FROM users
        WHERE id = ${textSql(id)}
        LIMIT 1;
      `,
      { json: true }
    );
    return config.maxAliasesPerUser + normalizeExtraAliases(rows[0]?.extraAliases);
  }

  const db = await readDb();
  const user = (db.users || []).find((item) => item.id === id);
  return config.maxAliasesPerUser + normalizeExtraAliases(user?.extraAliases);
}

export async function updateUserAliasExtra(userId, extraAliases) {
  const id = String(userId || "").trim();
  const normalizedExtraAliases = normalizeExtraAliases(extraAliases);

  if (!id) {
    return { ok: false, error: "User id is required." };
  }

  if (isSqlite) {
    await ensureSqliteDb();
    await sqliteExec(`
      UPDATE users
      SET extra_aliases = ${normalizedExtraAliases}
      WHERE id = ${textSql(id)};
    `);
    const users = await listUsers();
    const user = users.find((item) => item.id === id);
    return user ? { ok: true, user } : { ok: false, error: "User not found." };
  }

  const db = await readDb();
  db.users ||= [];
  const user = db.users.find((item) => item.id === id);
  if (!user) {
    return { ok: false, error: "User not found." };
  }
  user.extraAliases = normalizedExtraAliases;
  user.maxAliases = config.maxAliasesPerUser + normalizedExtraAliases;
  await writeJsonDb(db);
  return { ok: true, user };
}

export async function deleteUser(userId) {
  const id = String(userId || "").trim();

  if (!id) {
    return { ok: false, error: "User id is required." };
  }

  if (isSqlite) {
    await ensureSqliteDb();
    await sqliteExec(`
      DELETE FROM messages
      WHERE to_email IN (
        SELECT email FROM email_addresses WHERE owner_user_id = ${textSql(id)}
      );
      DELETE FROM email_addresses WHERE owner_user_id = ${textSql(id)};
      DELETE FROM users WHERE id = ${textSql(id)};
    `);
    return { ok: true };
  }

  const db = await readDb();
  const ownedEmails = new Set(db.emailAddresses.filter((item) => item.ownerUserId === id).map((item) => item.email));
  db.messages = db.messages.filter((message) => !ownedEmails.has(message.toEmail));
  db.emailAddresses = db.emailAddresses.filter((item) => item.ownerUserId !== id);
  db.users = (db.users || []).filter((user) => user.id !== id);
  await writeJsonDb(db);
  return { ok: true };
}

export async function getSystemStats() {
  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM email_addresses) AS aliases,
          (SELECT COUNT(*) FROM messages) AS messages;
      `,
      { json: true }
    );
    return rows[0] || { users: 0, aliases: 0, messages: 0 };
  }

  const db = await readDb();
  return {
    users: (db.users || []).length,
    aliases: db.emailAddresses.length,
    messages: db.messages.length
  };
}

export async function countEmailAddressesForOwner(ownerUserId) {
  const ownerId = String(ownerUserId || "");

  if (!ownerId) {
    return 0;
  }

  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT COUNT(*) AS count
        FROM email_addresses
        WHERE owner_user_id = ${textSql(ownerId)};
      `,
      { json: true }
    );
    return Number(rows[0]?.count || 0);
  }

  const db = await readDb();
  return db.emailAddresses.filter((item) => item.ownerUserId === ownerId).length;
}

export async function listAdminAliases() {
  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT
          email_addresses.id,
          email_addresses.email,
          email_addresses.local_part AS localPart,
          email_addresses.owner_user_id AS ownerUserId,
          email_addresses.label,
          email_addresses.active,
          email_addresses.created_at AS createdAt,
          users.name AS ownerName
        FROM email_addresses
        LEFT JOIN users ON users.id = email_addresses.owner_user_id
        ORDER BY datetime(email_addresses.created_at) DESC;
      `,
      { json: true }
    );
    return rows.map((row) => ({
      ...mapEmailAddress(row),
      ownerName: row.ownerName || ""
    }));
  }

  const db = await readDb();
  const usersById = new Map((db.users || []).map((user) => [user.id, user]));
  return db.emailAddresses
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((item) => ({
      ...item,
      ownerName: usersById.get(item.ownerUserId)?.name || ""
    }));
}

export async function createEmailAddress(name, label = "", domain = config.emailDomain, ownerUserId = "") {
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
          owner_user_id AS ownerUserId,
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
      ownerUserId: String(ownerUserId || ""),
      label: String(label || ""),
      active: true,
      createdAt: new Date().toISOString()
    };

    await sqliteExec(`
      INSERT INTO email_addresses (id, email, local_part, owner_user_id, label, active, created_at)
      VALUES (
        ${textSql(emailAddress.id)},
        ${textSql(emailAddress.email)},
        ${textSql(emailAddress.localPart)},
        ${textSql(emailAddress.ownerUserId)},
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
    ownerUserId: String(ownerUserId || ""),
    label: String(label || ""),
    active: true,
    createdAt: new Date().toISOString()
  };

  db.emailAddresses.push(emailAddress);
  await writeJsonDb(db);

  return { ok: true, emailAddress };
}

export async function listEmailAddresses(user = null) {
  if (isSqlite) {
    await ensureSqliteDb();
    if (user && !isAdminUser(user)) {
      const rows = await sqliteExec(
        `
          SELECT
            id,
            email,
            local_part AS localPart,
            owner_user_id AS ownerUserId,
            label,
            active,
            created_at AS createdAt
          FROM email_addresses
          WHERE owner_user_id = ${textSql(user.id)}
          ORDER BY datetime(created_at) DESC;
        `,
        { json: true }
      );
      return rows.map(mapEmailAddress);
    }

    const rows = await sqliteExec(
      `
        SELECT *
        FROM (
          SELECT
            id,
            email,
            local_part AS localPart,
            owner_user_id AS ownerUserId,
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
            '' AS ownerUserId,
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
          owner_user_id AS ownerUserId,
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

function userMessageFilterSql(user) {
  if (!user || isAdminUser(user)) {
    return "";
  }

  return `
    AND to_email IN (
      SELECT email FROM email_addresses WHERE owner_user_id = ${textSql(user.id)}
    )
  `;
}

export async function canAccessEmail(user, email) {
  if (!user || isAdminUser(user)) {
    return true;
  }

  if (isSqlite) {
    await ensureSqliteDb();
    const rows = await sqliteExec(
      `
        SELECT id
        FROM email_addresses
        WHERE email = ${textSql(String(email || "").toLowerCase())}
          AND owner_user_id = ${textSql(user.id)}
        LIMIT 1;
      `,
      { json: true }
    );
    return Boolean(rows[0]);
  }

  const db = await readDb();
  return db.emailAddresses.some((item) => item.email === email && item.ownerUserId === user.id);
}

export async function listMessages(localPart, user = null) {
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
          ${userMessageFilterSql(user)}
        ORDER BY datetime(received_at) DESC, rowid DESC
        LIMIT ${Number(config.messagesPerAddress)};
      `,
      { json: true }
    );
    return rows.map(mapMessage);
  }

  const db = await readDb();
  const allowedEmails = user && !isAdminUser(user)
    ? new Set(db.emailAddresses.filter((item) => item.ownerUserId === user.id).map((item) => item.email))
    : null;
  return db.messages
    .filter((message) => message.toEmail === wanted)
    .filter((message) => !allowedEmails || allowedEmails.has(message.toEmail))
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
    .slice(0, config.messagesPerAddress);
}

export async function listRecentMessages(limit = 50, user = null) {
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
        WHERE 1 = 1
          ${userMessageFilterSql(user)}
        ORDER BY datetime(received_at) DESC, rowid DESC
        LIMIT ${safeLimit};
      `,
      { json: true }
    );
    return rows.map(mapMessage);
  }

  const db = await readDb();
  const allowedEmails = user && !isAdminUser(user)
    ? new Set(db.emailAddresses.filter((item) => item.ownerUserId === user.id).map((item) => item.email))
    : null;
  return db.messages
    .slice()
    .filter((message) => !allowedEmails || allowedEmails.has(message.toEmail))
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
