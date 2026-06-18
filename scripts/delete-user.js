import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../src/config.js";

const execFileAsync = promisify(execFile);
const userId = process.argv[2] || "";
const dbPath = path.resolve(process.cwd(), config.dataFile);

if (!userId) {
  console.error("Usage: node scripts/delete-user.js <user-id>");
  process.exit(64);
}

function textSql(value) {
  const hex = Buffer.from(String(value ?? ""), "utf8").toString("hex");
  return `CAST(X'${hex}' AS TEXT)`;
}

await execFileAsync("sqlite3", [
  dbPath,
  `
    DELETE FROM email_addresses WHERE owner_user_id = ${textSql(userId)};
    DELETE FROM users WHERE id = ${textSql(userId)};
  `
]);

console.log(`Deleted user ${userId} and owned aliases.`);
