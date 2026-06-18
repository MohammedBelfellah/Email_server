import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../src/config.js";
import { normalizeLocalPart } from "../src/storage.js";

const execFileAsync = promisify(execFile);
const keepEmail = String(process.argv[2] || "").trim().toLowerCase();

if (!keepEmail || !keepEmail.includes("@")) {
  console.error("Usage: node scripts/cleanup-keep-address.js luise@belfellah.tech");
  process.exit(64);
}

const dbPath = path.resolve(process.cwd(), config.dataFile);
const backupPath = `${dbPath}.cleanup-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;

function textSql(value) {
  const hex = Buffer.from(String(value ?? ""), "utf8").toString("hex");
  return `CAST(X'${hex}' AS TEXT)`;
}

async function sqliteExec(sql) {
  const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], {
    maxBuffer: 1024 * 1024 * 20
  });
  return stdout.trim();
}

await fs.copyFile(dbPath, backupPath);

const localPart = normalizeLocalPart(keepEmail);
const now = new Date().toISOString();

await sqliteExec(`
  BEGIN;

  DELETE FROM messages
  WHERE to_email != ${textSql(keepEmail)};

  DELETE FROM email_addresses
  WHERE email != ${textSql(keepEmail)};

  INSERT INTO email_addresses (id, email, local_part, label, active, created_at)
  SELECT
    ${textSql(`manual:${keepEmail}`)},
    ${textSql(keepEmail)},
    ${textSql(localPart)},
    '',
    1,
    ${textSql(now)}
  WHERE NOT EXISTS (
    SELECT 1 FROM email_addresses WHERE email = ${textSql(keepEmail)}
  );

  COMMIT;
`);

const summary = await sqliteExec(`
  SELECT 'addresses=' || COUNT(*) FROM email_addresses;
  SELECT 'messages=' || COUNT(*) FROM messages;
  SELECT 'kept=' || ${textSql(keepEmail)};
  SELECT 'backup=' || ${textSql(backupPath)};
`);

console.log(summary);
