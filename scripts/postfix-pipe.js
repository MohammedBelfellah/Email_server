import { isLocalDomain, parseRawEmail } from "../src/mail.js";
import { saveMessage } from "../src/storage.js";

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

const rawEmail = await readStdin();
const recipient = process.env.ORIGINAL_RECIPIENT || process.argv[2] || "";
const parsed = parseRawEmail(rawEmail, { recipient });

if (!parsed.toEmail) {
  console.error("No recipient found in email.");
  process.exit(64);
}

if (!isLocalDomain(parsed.toEmail)) {
  console.error(`Recipient is outside configured domain: ${parsed.toEmail}`);
  process.exit(65);
}

const message = await saveMessage(parsed);
console.log(`Saved email ${message.id} for ${message.toEmail}`);
