import { createUser } from "../src/storage.js";

const name = process.argv[2] || "";
const role = process.argv[3] || "user";
const extraAliases = Number(process.argv[4] || 0);

const result = await createUser({ name, role, extraAliases });

if (!result.ok) {
  console.error(result.error);
  process.exit(64);
}

console.log(JSON.stringify({ user: result.user }, null, 2));
