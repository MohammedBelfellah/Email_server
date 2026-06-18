import { createUser } from "../src/storage.js";

const name = process.argv[2] || "";
const role = process.argv[3] || "user";

const result = await createUser({ name, role });

if (!result.ok) {
  console.error(result.error);
  process.exit(64);
}

console.log(JSON.stringify({ user: result.user }, null, 2));
