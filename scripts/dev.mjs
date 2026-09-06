import { spawn } from "node:child_process";
const children = [
  "apps/api/dist/main.js",
  "apps/worker/dist/main.js",
  "apps/web/node_modules/vite/bin/vite.js",
].map((file, index) =>
  spawn(
    process.execPath,
    [file, ...(index === 2 ? ["apps/web", "--host", "127.0.0.1"] : [])],
    { stdio: "inherit", env: process.env },
  ),
);
function stop() {
  for (const child of children) child.kill();
}
for (const child of children)
  child.on("exit", (code) => {
    stop();
    process.exit(code ?? 1);
  });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
