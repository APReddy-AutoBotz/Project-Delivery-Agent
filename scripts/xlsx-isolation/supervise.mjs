import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { superviseWorker } from "../xlsx-runtime/supervise.mjs";

const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));

export function runWorker(request, job, mode, signal, noteDescendant) {
  return superviseWorker(request, job, signal, () => {
    const child = spawn(process.execPath, [worker, mode], {
      detached: true,
      env: {},
      stdio: [
        "pipe",
        "pipe",
        "ignore",
        mode === "descendant" ? "pipe" : "ignore",
      ],
    });
    if (mode === "descendant") {
      child.stdio[3].on("error", () => {});
      child.stdio[3].once("data", (data) => {
        if (data.length === 1 && data[0] === 1) noteDescendant();
      });
    }
    return child;
  });
}
