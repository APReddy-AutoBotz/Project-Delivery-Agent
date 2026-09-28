import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log("Existing .env preserved.");
} else {
  const password = randomBytes(24).toString("hex");
  const connectorTaskKeyId = "local-connector-v1";
  const projectUpdateTaskKeyId = "local-project-update-v1";
  const connectorTaskKeys = {
    currentKeyId: connectorTaskKeyId,
    keys: { [connectorTaskKeyId]: randomBytes(32).toString("base64url") },
  };
  const projectUpdateTaskKeys = {
    currentKeyId: projectUpdateTaskKeyId,
    keys: { [projectUpdateTaskKeyId]: randomBytes(32).toString("base64url") },
  };
  // These task credentials are private synthetic-development fixtures only.
  writeFileSync(".connector-task-keys.local", JSON.stringify(connectorTaskKeys) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(".project-update-task-keys.local", JSON.stringify(projectUpdateTaskKeys) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const body = `NODE_ENV=development\nAUTH_MODE=development\nDATA_MODE=synthetic\nCUSTOMER_ID=10000000-0000-4000-8000-000000000001\nPDAA_DATABASE_URL=postgresql://pdaa:${password}@127.0.0.1:55432/pdaa\nPOSTGRES_PASSWORD=${password}\nENCRYPTION_KEY=${randomBytes(32).toString("base64")}\nSESSION_SECRET=${randomBytes(48).toString("base64url")}\nSHADOW_MODE=true\nAPI_HOST=127.0.0.1\nAPI_PORT=3001\nAPP_ORIGIN=http://localhost:5173\nINTERNAL_API_URL=http://127.0.0.1:3001\nCONNECTOR_TASK_KEYS_FILE=.connector-task-keys.local\nPROJECT_UPDATE_TASK_KEYS_FILE=.project-update-task-keys.local\nPROJECT_UPDATE_SERVICE_SUBJECT=local-project-update-scheduler\n`;
  writeFileSync(".env", body, { flag: "wx", mode: 0o600 });
  console.log("Created private .env and synthetic task credentials for the local workspace.");
}
