import fs from "node:fs/promises";
import { createEmailAddress, saveMessage } from "../src/storage.js";

const jsonPath = process.argv[2] || "data/db.json";
const raw = await fs.readFile(jsonPath, "utf8");
const db = JSON.parse(raw);

for (const emailAddress of db.emailAddresses || []) {
  await createEmailAddress(emailAddress.localPart || emailAddress.email, emailAddress.label || "");
}

const messages = (db.messages || [])
  .slice()
  .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));

for (const message of messages) {
  await saveMessage(message);
}

console.log(`Migrated ${db.emailAddresses?.length || 0} address(es) and ${messages.length} message(s).`);
