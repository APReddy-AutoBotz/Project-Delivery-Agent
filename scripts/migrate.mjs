import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: "packages/data", env: process.env, stdio: "inherit" },
);
process.exit(result.status ?? 1);
