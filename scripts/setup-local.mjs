import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const password = randomBytes(24).toString("hex");
const body = `NODE_ENV=development\nAUTH_MODE=development\nDATA_MODE=synthetic\nCUSTOMER_ID=10000000-0000-4000-8000-000000000001\nPDAA_DATABASE_URL=postgresql://pdaa:${password}@127.0.0.1:55432/pdaa\nPOSTGRES_PASSWORD=${password}\nENCRYPTION_KEY=${randomBytes(32).toString("base64")}\nSESSION_SECRET=${randomBytes(48).toString("base64url")}\nSHADOW_MODE=true\nAPI_HOST=127.0.0.1\nAPI_PORT=3001\nAPP_ORIGIN=http://localhost:5173\n`;
try {
  writeFileSync(".env", body, { flag: "wx", mode: 0o600 });
  console.log("Created private .env for the synthetic workspace.");
} catch (error) {
  if (error.code === "EEXIST") console.log("Existing .env preserved.");
  else throw error;
}
