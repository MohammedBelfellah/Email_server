import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
import { parseRawEmail } from "../src/mail.js";

const dbPath = path.resolve(process.cwd(), config.dataFile);
const raw = await fs.readFile(dbPath, "utf8");
const db = JSON.parse(raw);
let changed = 0;

for (const message of db.messages || []) {
  if (!message.rawEmail) {
    continue;
  }

  const parsed = parseRawEmail(message.rawEmail, {
    recipient: message.toEmail
  });

  const nextTextBody = parsed.textBody || message.textBody || "";
  const nextHtmlBody = parsed.htmlBody || message.htmlBody || "";

  if (message.textBody !== nextTextBody || message.htmlBody !== nextHtmlBody) {
    message.textBody = nextTextBody;
    message.htmlBody = nextHtmlBody;
    changed += 1;
  }
}

await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
console.log(`Reparsed ${changed} message(s).`);
