import { spawn } from "node:child_process";
const children = new Set();
let stopping = false;
let retry;
function start(file, args = [], restart = false) {
  const child = spawn(process.execPath, [file, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  children.add(child);
  child.on("exit", (code) => {
    children.delete(child);
    if (stopping) return;
    if (restart) retry = setTimeout(() => start(file, args, true), 1000);
    else {
      stop();
      process.exitCode = code ?? 1;
    }
  });
  child.on("error", () => {
    stop();
    process.exitCode = 1;
  });
}
function stop() {
  stopping = true;
  clearTimeout(retry);
  for (const child of children) child.kill();
}
start("apps/api/dist/main.js");
start("apps/worker/dist/main.js", [], true);
start("apps/web/node_modules/vite/bin/vite.js", [
  "apps/web",
  "--host",
  "127.0.0.1",
]);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
